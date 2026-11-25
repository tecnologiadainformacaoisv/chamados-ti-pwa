// Avaliação mensal do atendimento da TI (estudo do OS800, 2026-11-17).
//
// No OS800 o ISV avalia o FORNECEDOR uma vez por mês, por contrato (7 notas de 1 a 5 e
// uma recomendação de 0 a 10). Aqui a mesma mecânica virada para dentro: cada
// solicitante avalia a TI do ISV uma vez por mês. Complementa a nota por chamado
// (chamados.nota), que mede um atendimento; esta mede o mês inteiro e dá um NPS
// para mostrar à diretoria.
//
// Uso: mostrar como faixa no app do solicitante ("Como foi a TI em novembro?") quando
// fetchAvaliacaoMensal().respondida === false; abre este formulário num Dialog.

import { useRef, useState, type KeyboardEvent } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { PERGUNTAS, nomeDoMes, type AvaliacaoRespostas } from "@/lib/avaliacao-api"
import { cn } from "@/lib/utils"

export function AvaliacaoMensal({
  competencia,
  inicial,
  enviando,
  erro,
  onEnviar,
  onCancelar,
}: {
  competencia: string
  inicial?: Partial<AvaliacaoRespostas> | null
  enviando?: boolean
  erro?: string | null
  onEnviar: (respostas: AvaliacaoRespostas, comentario?: string) => void
  onCancelar?: () => void
}) {
  const [notas, setNotas] = useState<Partial<AvaliacaoRespostas>>(inicial ?? {})
  const [comentario, setComentario] = useState("")
  const [tentouEnviar, setTentouEnviar] = useState(false)

  const faltando: (keyof AvaliacaoRespostas)[] = [...PERGUNTAS.map((p) => p.chave), "recomendacao" as const].filter((k) => notas[k] == null)

  const enviar = (e: React.FormEvent) => {
    e.preventDefault()
    setTentouEnviar(true)
    if (faltando.length) {
      document.getElementById(`aval-${faltando[0]}`)?.focus()
      return
    }
    onEnviar(notas as AvaliacaoRespostas, comentario.trim() || undefined)
  }

  return (
    <form onSubmit={enviar} noValidate className="flex flex-col gap-5">
      <header>
        <h2 className="text-lg font-semibold">Como foi a TI em {nomeDoMes(competencia)}?</h2>
        <p className="text-sm text-muted-foreground">Leva menos de 1 minuto.</p>
      </header>

      {PERGUNTAS.map(({ chave, pergunta }, i) => (
        <Escala
          key={chave}
          id={`aval-${chave}`}
          rotulo={`${i + 1}. ${pergunta}`}
          de={1}
          ate={5}
          legenda="1 = muito ruim · 5 = excelente"
          valor={notas[chave]}
          invalido={tentouEnviar && notas[chave] == null}
          onChange={(v) => setNotas((n) => ({ ...n, [chave]: v }))}
        />
      ))}

      <Escala
        id="aval-recomendacao"
        rotulo={`${PERGUNTAS.length + 1}. De 0 a 10, quanto você recomendaria o atendimento da TI a um colega?`}
        de={0}
        ate={10}
        legenda="0 = de jeito nenhum · 10 = com certeza"
        valor={notas.recomendacao}
        invalido={tentouEnviar && notas.recomendacao == null}
        onChange={(v) => setNotas((n) => ({ ...n, recomendacao: v }))}
      />

      <label className="flex flex-col gap-1.5 text-sm font-medium">
        Quer contar alguma coisa? (opcional)
        <Textarea value={comentario} onChange={(e) => setComentario(e.target.value)} maxLength={1000} rows={3} />
      </label>

      {tentouEnviar && faltando.length > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Falta responder {faltando.length === 1 ? "1 pergunta" : `${faltando.length} perguntas`}.</AlertDescription>
        </Alert>
      )}
      {erro && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancelar && <Button type="button" variant="outline" onClick={onCancelar}>Agora não</Button>}
        <Button type="submit" disabled={enviando}>{enviando ? "Enviando…" : "Enviar avaliação"}</Button>
      </div>
    </form>
  )
}

function Escala({
  id,
  rotulo,
  de,
  ate,
  legenda,
  valor,
  invalido,
  onChange,
}: {
  id: string
  rotulo: string
  de: number
  ate: number
  legenda: string
  valor?: number
  invalido: boolean
  onChange: (v: number) => void
}) {
  const valores = Array.from({ length: ate - de + 1 }, (_, i) => de + i)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const legendaId = `${id}-legenda`
  // Padrão de grupo de rádio (ARIA): só UM botão fica na ordem de Tab (o escolhido, ou o primeiro se nada foi
  // escolhido); as setas, Home e End mudam a nota e levam o foco junto.
  const comTab = valor != null ? Math.max(0, valores.indexOf(valor)) : 0
  function aoTeclar(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    let prox = -1
    if (e.key === "ArrowRight" || e.key === "ArrowDown") prox = (i + 1) % valores.length
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") prox = (i - 1 + valores.length) % valores.length
    else if (e.key === "Home") prox = 0
    else if (e.key === "End") prox = valores.length - 1
    if (prox < 0) return
    e.preventDefault()
    onChange(valores[prox])
    refs.current[prox]?.focus()
  }
  return (
    <fieldset className="flex flex-col gap-2">
      <legend id={legendaId} className={cn("mb-2 text-sm font-medium", invalido && "text-destructive")}>{rotulo}</legend>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-labelledby={legendaId}>
        {valores.map((v, i) => (
          <button
            key={v}
            ref={(el) => { refs.current[i] = el }}
            id={i === 0 ? id : undefined}
            type="button"
            role="radio"
            aria-checked={valor === v}
            tabIndex={i === comTab ? 0 : -1}
            onClick={() => onChange(v)}
            onKeyDown={(e) => aoTeclar(e, i)}
            className={cn(
              "flex size-10 cursor-pointer items-center justify-center rounded-lg border text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              valor === v ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
            )}
          >
            {v}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{legenda}</p>
      {invalido && <p className="text-xs font-medium text-destructive">Escolha uma nota.</p>}
    </fieldset>
  )
}
