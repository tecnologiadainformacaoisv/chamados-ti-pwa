import { useCallback, useEffect, useState } from "react"
import { APP_SHARED_SECRET, VAPID_PUBLIC_KEY, WORKER_URL } from "@/lib/constants"

const DISMISS_KEY = "notif_dismissed_at"
const DISMISS_WINDOW_MS = 86400000 // 24h — mesmo prazo de app.js pra reaparecer o banner

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

async function subscribeToPush(sessionToken: string): Promise<void> {
  if (!WORKER_URL) return
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return

  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast: TS 6/lib.dom mais recente não considera Uint8Array<ArrayBufferLike> como
      // BufferSource compatível (SharedArrayBuffer vs ArrayBuffer) — o valor em si é
      // válido em runtime, é só a tipagem estrita do lib.dom.
      applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    })
  }

  // Quem é o dono da subscription é resolvido pelo Worker a partir da sessão — não manda
  // nenhum índice/nome daqui (ver handleSubscribe em push-worker.js).
  await fetch(`${WORKER_URL}/subscribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-App-Secret": APP_SHARED_SECRET,
      "X-Session-Token": sessionToken,
    },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  })
}

type PushState = "unsupported" | "granted" | "show-banner" | "hidden"

// Porta setupNotifications()/subscribeToPush() de app.js. Só decide SE mostra o banner —
// quem renderiza é <NotifBanner/>, e a decisão de reaparecer 24h depois de dispensado
// usa o mesmo localStorage (`notif_dismissed_at`) que a versão vanilla já usava.
export function usePushNotifications(sessionToken: string) {
  const [state, setState] = useState<PushState>("hidden")

  useEffect(() => {
    if (!("Notification" in window)) {
      setState("unsupported")
      return
    }
    if (Notification.permission === "granted") {
      setState("granted")
      subscribeToPush(sessionToken).catch(console.warn)
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
  }, [sessionToken])

  const ativar = useCallback(async () => {
    setState("hidden")
    const perm = await Notification.requestPermission()
    if (perm === "granted") {
      await subscribeToPush(sessionToken).catch(console.warn)
      setState("granted")
    }
    return perm
  }, [sessionToken])

  const dispensar = useCallback(() => {
    setState("hidden")
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  }, [])

  return { state, ativar, dispensar }
}
