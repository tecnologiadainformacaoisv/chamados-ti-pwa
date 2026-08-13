// Alerta sonoro simples pro admin quando um chamado novo chega (2026-08-13) — gerado
// por código (Web Audio API), sem arquivo de áudio nenhum pra baixar/versionar. Dois
// tons curtos, tipo "ding-dong" discreto — não precisa de asset novo em public/.
let ctx: AudioContext | null = null

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) ctx = new Ctor()
  return ctx
}

function beep(context: AudioContext, freq: number, startAt: number, durationSec: number) {
  const osc = context.createOscillator()
  const gain = context.createGain()
  osc.type = "sine"
  osc.frequency.value = freq
  // Sobe e desce o volume rápido (envelope) em vez de ligar/desligar seco — evita o
  // "clique" de um corte abrupto de onda.
  gain.gain.setValueAtTime(0, startAt)
  gain.gain.linearRampToValueAtTime(0.2, startAt + 0.02)
  gain.gain.linearRampToValueAtTime(0, startAt + durationSec)
  osc.connect(gain)
  gain.connect(context.destination)
  osc.start(startAt)
  osc.stop(startAt + durationSec)
}

export function playNotificationSound() {
  const context = getContext()
  if (!context) return
  // Autoplay de áudio programático só funciona depois de alguma interação do usuário
  // na página (clique no gate, no botão de ativar notificações, etc.) — se o contexto
  // nascer "suspended", tenta retomar; se não conseguir, simplesmente não toca (não é
  // erro, só significa que ainda não houve interação nenhuma nesta sessão).
  if (context.state === "suspended") context.resume().catch(() => {})
  const now = context.currentTime
  beep(context, 880, now, 0.15) // tom 1: A5
  beep(context, 1108.73, now + 0.16, 0.18) // tom 2: C#6 — sobe, "novidade chegando"
}
