// "Antes de abrir, tente isto": aparece embaixo da descrição quando o texto digitado bate com uma dica.
// Nunca bloqueia nem atrasa a abertura do chamado. O alerta de cada dica vem ANTES dos passos.

import { useState } from "react"
import { dicasPara, type Dica } from "@/lib/dicas"

export function DicasAntesDoChamado({ texto, tipo }: { texto: string; tipo?: number }) {
  const dicas = dicasPara(texto, tipo)
  return (
    // O aviso fica sempre montado: leitor de tela só anuncia mudança em região que já existia.
    <div>
      <p className="sr-only" aria-live="polite">
        {dicas.length ? `Dica antes de abrir o chamado: ${dicas.map((d) => d.titulo).join(" e ")}.` : ""}
      </p>
      {dicas.length > 0 && (
        <section aria-label="Dicas antes de abrir o chamado" className="flex flex-col gap-2 rounded-md border-2 border-[#1F6FB2]/40 bg-[#E8F0F6] p-3">
          <h3 className="m-0 text-[0.98rem] font-bold text-[#0A3D62]">
            <span aria-hidden="true">💡 </span>
            {dicas[0].id === "perigo" ? "Atenção" : "Antes de abrir, que tal tentar?"}
          </h3>
          {dicas.map((d, i) => (
            <Item key={d.id} dica={d} abrir={i === 0} />
          ))}
          <p className="m-0 text-[0.88rem] text-[#33485A]">
            {dicas[0].id === "perigo" ? "Abra o chamado abaixo." : "Não resolveu, ou prefere não mexer? É só abrir o chamado normalmente."}
          </p>
        </section>
      )}
    </div>
  )
}

function Item({ dica, abrir }: { dica: Dica; abrir: boolean }) {
  // O estado inicial não muda enquanto a pessoa digita: a dica que ela está lendo não fecha sozinha.
  const [aberta, setAberta] = useState(abrir)
  return (
    <details open={aberta} onToggle={(e) => setAberta(e.currentTarget.open)} className="rounded-md bg-white px-3 py-1">
      <summary className="min-h-11 cursor-pointer content-center text-[0.95rem] font-semibold text-[#0A3D62]">{dica.titulo}</summary>
      {dica.aviso && (
        <p className="mt-0 mb-1 text-[0.88rem] font-medium text-[#8A4B0F]">
          <span aria-hidden="true">⚠ </span>
          {dica.aviso}
        </p>
      )}
      <ol className="mt-1 mb-2 list-decimal pl-5 text-[0.92rem] leading-relaxed">
        {dica.passos.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ol>
    </details>
  )
}
