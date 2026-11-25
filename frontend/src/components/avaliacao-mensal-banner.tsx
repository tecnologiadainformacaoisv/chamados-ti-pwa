// Faixa no app do solicitante: "Como foi a TI em novembro?" (avaliação mensal, 2026-11-25, ideia do estudo
// do OS800). Aparece até a pessoa responder o mês; "Agora não" esconde só até o fim do dia.

import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Star } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { AvaliacaoMensal } from "@/components/avaliacao-mensal"
import { enviarAvaliacaoMensal, fetchAvaliacaoMensal, nomeDoMes, type AvaliacaoRespostas } from "@/lib/avaliacao-api"

const CHAVE_ADIADA = "avaliacao_mensal_adiada"

function hojeLocal(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function adiadaHoje(competencia: string): boolean {
  try {
    return localStorage.getItem(CHAVE_ADIADA) === `${competencia}|${hojeLocal()}`
  } catch {
    return false
  }
}

export function AvaliacaoMensalBanner({ sessionToken }: { sessionToken: string }) {
  const qc = useQueryClient()
  const [aberto, setAberto] = useState(false)
  const [agradecido, setAgradecido] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [adiou, setAdiou] = useState(false)

  // Se a consulta falhar (rede, servidor), a faixa simplesmente não aparece: nunca atrapalha abrir chamado.
  const consulta = useQuery({
    queryKey: ["avaliacao-mensal"],
    queryFn: () => fetchAvaliacaoMensal(sessionToken),
    enabled: !!sessionToken,
    retry: false,
    staleTime: 5 * 60_000,
  })

  const enviar = useMutation({
    mutationFn: ({ respostas, comentario, competencia }: { respostas: AvaliacaoRespostas; comentario?: string; competencia: string }) =>
      enviarAvaliacaoMensal(sessionToken, respostas, comentario, competencia),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["avaliacao-mensal"] })
      setAberto(false)
      setAgradecido(true)
    },
    onError: (e) => setErro(e instanceof Error ? e.message : "Não foi possível enviar agora. Tente de novo."),
  })

  // Depois do envio o formulário fecha e a faixa vira esta mensagem: leva o foco para ela (senão cai no <body>).
  const msgRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    if (agradecido) msgRef.current?.focus()
  }, [agradecido])

  if (agradecido) {
    return (
      <p ref={msgRef} tabIndex={-1} role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-900">
        <Check className="size-4 shrink-0" aria-hidden /> Obrigado! Sua avaliação foi registrada.
      </p>
    )
  }

  const dados = consulta.data
  if (!dados || dados.respondida || dados.elegivel === false || adiou || adiadaHoje(dados.competencia)) return null

  const adiar = () => {
    try {
      localStorage.setItem(CHAVE_ADIADA, `${dados.competencia}|${hojeLocal()}`)
    } catch { /* sem armazenamento: só some até recarregar */ }
    setAdiou(true)
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
        <span className="flex items-center gap-2 text-foreground">
          <Star className="size-4 shrink-0 text-primary" aria-hidden />
          <span>
            <strong>Como foi a TI em {nomeDoMes(dados.competencia)}?</strong> Leva menos de 1 minuto.
          </span>
        </span>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="ghost" onClick={adiar}>Agora não</Button>
          <Button size="sm" onClick={() => { setErro(null); setAberto(true) }}>Avaliar agora</Button>
        </div>
      </div>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogTitle className="sr-only">Avaliação mensal da TI</DialogTitle>
          <AvaliacaoMensal
            competencia={dados.competencia}
            inicial={dados.respostas}
            enviando={enviar.isPending}
            erro={erro}
            onEnviar={(respostas, comentario) => { setErro(null); enviar.mutate({ respostas, comentario, competencia: dados.competencia }) }}
            onCancelar={() => setAberto(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
