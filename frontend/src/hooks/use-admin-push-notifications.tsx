import { useCallback, useEffect, useRef, useState } from "react"
import { VAPID_PUBLIC_KEY } from "@/lib/constants"
import { subscribeAdminPush, testAdminPush } from "@/lib/api"
import { registerAdminSW, waitForAdminSWActivation } from "@/lib/admin-sw"

const DISMISS_KEY = "admin_notif_dismissed_at"
const DISMISS_WINDOW_MS = 86400000 // 24h — mesma janela de use-push-notifications.tsx
const DEVICE_ID_KEY = "admin_push_device_id"

// Sem login por pessoa no admin (só ADMIN_SECRET compartilhado) — a inscrição de push
// é por NAVEGADOR/DISPOSITIVO, não por "Everson"/"Henrique". Gerado uma vez, persistido
// — reenviar com o mesmo id sobrescreve no servidor (ver handleAdminSubscribe).
function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(DEVICE_ID_KEY, id)
  }
  return id
}

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

// registerAdminSW/waitForAdminSWActivation vivem em @/lib/admin-sw agora — extraído
// porque o hook do badge (use-admin-app-badge.tsx) também precisa registrar o mesmo SW
// (ver comentário lá pro porquê disso ser seguro/idempotente).

// Compara a chave que a subscription já existente foi criada com (o navegador guarda
// isso em `sub.options.applicationServerKey`) contra a VAPID_PUBLIC_KEY atual —
// achado do revisor/investigação (2026-09-15, "não estou sendo notificado"): antes
// disso, `getSubscription()` sempre reaproveitava uma subscription antiga sem checar
// se ela ainda bate com a chave VAPID atual; se o par VAPID for trocado no servidor
// um dia (já aconteceu uma vez, ver SEGREDOS-LOCAIS.md), toda subscription antiga
// vira uma referência inválida pro navegador, mas send WebPush só detecta isso como
// 401/403 (não 404/410) — que notifyAdminsNovoChamado nunca soube limpar, e nunca vai.
function chaveBate(sub: PushSubscription): boolean {
  const atual = urlB64ToUint8Array(VAPID_PUBLIC_KEY)
  const daSub = sub.options?.applicationServerKey
  if (!daSub) return true // navegador não expõe (raro/antigo) — assume ok, não força resubscribe à toa
  const bytes = new Uint8Array(daSub as ArrayBuffer)
  if (bytes.length !== atual.length) return false
  return bytes.every((b, i) => b === atual[i])
}

async function subscribeToAdminPush(secret: string): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    throw new Error("Este navegador não suporta notificação push.")
  }

  const reg = await registerAdminSW()
  if (!reg) throw new Error("Não foi possível registrar o Service Worker.")
  await waitForAdminSWActivation(reg)

  let sub = await reg.pushManager.getSubscription()
  if (sub && !chaveBate(sub)) {
    // Chave VAPID mudou desde que essa subscription foi criada — reaproveitá-la
    // resultaria em pushes rejeitados pelo serviço de push (401/403), nunca
    // limpos automaticamente. Descarta e cria uma nova do zero.
    await sub.unsubscribe()
    sub = null
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Mesmo cast de use-push-notifications.tsx — ver comentário lá.
      applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    })
  }

  await subscribeAdminPush(secret, getDeviceId(), sub.toJSON())
}

// Diagnóstico de "não estou sendo notificado" (2026-09-15) — dispara um push REAL de
// teste pro device deste navegador, ida e volta completa pelo servidor (não é só tocar
// o som local: confirma que o Service Worker, a subscription e o servidor estão todos
// funcionando juntos, sem precisar criar um chamado de teste de verdade).
async function testarAdminPush(secret: string): Promise<void> {
  await testAdminPush(secret, getDeviceId())
}

// "checking": tentando confirmar com o servidor (mostrado o tempo todo que uma
// chamada de subscribe/teste está em voo). "active": confirmado — permissão concedida
// E o POST /admin/subscribe teve sucesso (ver 🛡️ abaixo pro que "granted" sozinho não
// garantia). "error": permissão concedida mas a inscrição com o servidor falhou —
// estado que antes era 100% silencioso (`.catch(console.warn)`, sem ninguém saber).
type PushState = "unsupported" | "active" | "error" | "checking" | "show-banner" | "hidden"

// Reconfirma a inscrição com o servidor a cada 6h enquanto a aba fica aberta — não é
// só pra cobrir uma chave VAPID trocada (ver chaveBate acima), mas qualquer outra
// forma de a inscrição podre nunca ser detectada: como notifyAdminsNovoChamado só
// roda quando um chamado é criado DE VERDADE, um painel que fica dias sem nenhum
// chamado novo nunca teria a chance de descobrir (e avisar) que a inscrição morreu.
const RECHECK_MS = 6 * 60 * 60 * 1000

// Mesmo esqueleto de usePushNotifications (use-push-notifications.tsx) — só troca a
// identidade (device id + X-Admin-Secret em vez de sessão de solicitante) e o Service
// Worker (admin-sw.js em vez de sw.js). Achado da investigação de 2026-09-15
// ("chamados acontecendo e não estou sendo notificado"): a versão anterior tratava
// `Notification.permission === "granted"` como sinônimo de "notificação funcionando"
// — mas a permissão do NAVEGADOR não garante nada sobre a inscrição estar de fato
// salva e válida no SERVIDOR (rede caiu, ADMIN_SECRET mudou no meio do caminho, chave
// VAPID ficou desatualizada, etc.) — e qualquer falha aí era só um `console.warn`,
// nunca visível pra quem está de olho no painel. Agora esse resultado vira estado.
export function useAdminPushNotifications(secret: string) {
  const [state, setState] = useState<PushState>("hidden")
  const [erro, setErro] = useState<string | null>(null)
  const secretRef = useRef(secret)
  secretRef.current = secret

  const confirmar = useCallback(async (isTest = false): Promise<boolean> => {
    setState((s) => (s === "active" && !isTest ? s : "checking"))
    try {
      await subscribeToAdminPush(secretRef.current)
      setErro(null)
      setState("active")
      return true
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Falha desconhecida ao ativar notificações.")
      setState("error")
      return false
    }
  }, [])

  useEffect(() => {
    if (!secret) return
    if (!("Notification" in window)) {
      setState("unsupported")
      return
    }
    if (Notification.permission === "granted") {
      confirmar()
      return
    }
    if (Notification.permission !== "default") {
      setState("hidden")
      return
    }
    const dismissedAt = parseInt(localStorage.getItem(DISMISS_KEY) || "0", 10)
    if (dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_WINDOW_MS) {
      setState("hidden")
      return
    }
    setState("show-banner")
  }, [secret, confirmar])

  // Reconfirmação periódica (ver RECHECK_MS) + ao voltar o foco da aba — pega
  // notebook suspenso/rede instável sem esperar o próximo chamado real de verdade.
  useEffect(() => {
    if (Notification.permission !== "granted" || !secret) return
    const interval = setInterval(() => confirmar(), RECHECK_MS)
    function onVisible() {
      if (document.visibilityState === "visible") confirmar()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [secret, confirmar])

  const ativar = useCallback(async () => {
    const perm = await Notification.requestPermission()
    if (perm === "granted") {
      await confirmar()
    } else {
      setState("hidden")
    }
    return perm
  }, [confirmar])

  const dispensar = useCallback(() => {
    setState("hidden")
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  }, [])

  // Reconfirma a inscrição e, só se isso passar, dispara o push de teste real através
  // do servidor (ver testarAdminPush acima) — se a reconfirmação já falhar, o erro dela
  // (em `erro`) já é a resposta certa, sem precisar de uma segunda falha em cascata.
  const testar = useCallback(async () => {
    const ok = await confirmar(true)
    if (!ok) return
    try {
      await testarAdminPush(secretRef.current)
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Falha desconhecida ao testar.")
      setState("error")
      throw err
    }
  }, [confirmar])

  return { state, erro, ativar, dispensar, testar }
}
