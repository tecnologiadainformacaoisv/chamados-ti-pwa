import { useCallback, useEffect, useState } from "react"
import { VAPID_PUBLIC_KEY } from "@/lib/constants"
import { subscribeAdminPush } from "@/lib/api"

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

// Registro manual — admin-sw.js é um arquivo estático em public/, não passa pelo
// vite-plugin-pwa/Workbox (esse é só do app de solicitantes, ver src/sw.ts). Sem
// manifest nenhum aqui — só o essencial pra Web Push funcionar (ver comentário no
// próprio admin-sw.js pro porquê de ser um arquivo separado).
async function registerAdminSW(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null
  const base = import.meta.env.BASE_URL
  return navigator.serviceWorker.register(`${base}admin-sw.js`, { scope: base })
}

async function subscribeToAdminPush(secret: string): Promise<void> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return

  const reg = await registerAdminSW()
  if (!reg) return
  await navigator.serviceWorker.ready

  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Mesmo cast de use-push-notifications.tsx — ver comentário lá.
      applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    })
  }

  await subscribeAdminPush(secret, getDeviceId(), sub.toJSON())
}

type PushState = "unsupported" | "granted" | "show-banner" | "hidden"

// Mesmo esqueleto de usePushNotifications (use-push-notifications.tsx) — só troca a
// identidade (device id + X-Admin-Secret em vez de sessão de solicitante) e o Service
// Worker (admin-sw.js em vez de sw.js).
export function useAdminPushNotifications(secret: string) {
  const [state, setState] = useState<PushState>("hidden")

  useEffect(() => {
    if (!secret) return
    if (!("Notification" in window)) {
      setState("unsupported")
      return
    }
    if (Notification.permission === "granted") {
      setState("granted")
      subscribeToAdminPush(secret).catch(console.warn)
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
  }, [secret])

  const ativar = useCallback(async () => {
    setState("hidden")
    const perm = await Notification.requestPermission()
    if (perm === "granted") {
      await subscribeToAdminPush(secret).catch(console.warn)
      setState("granted")
    }
    return perm
  }, [secret])

  const dispensar = useCallback(() => {
    setState("hidden")
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  }, [])

  return { state, ativar, dispensar }
}
