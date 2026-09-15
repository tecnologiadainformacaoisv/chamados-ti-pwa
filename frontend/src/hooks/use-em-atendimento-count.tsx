import { useQuery } from "@tanstack/react-query"
import { fetchTasks } from "@/lib/api"

const POLL_MS = 20_000 // mesmo intervalo de use-novos-chamados.tsx

// Contagem de "em atendimento" (2026-09-15, pedido do usuário) — separado de propósito
// de useNovosChamados: o sino/som/caixa de "chamado novo" continua contando só
// "aberto" (só faz sentido *aceitar* um chamado que ainda não foi aceito por
// ninguém); já o badge do ÍCONE DO APP (ver use-admin-app-badge.tsx) soma
// aberto+em atendimento — pedido explícito do usuário: "quando eu colocar para
// pendente ou fechado, não deverá mais estar na contagem", ou seja, o badge reflete
// "chamado que ainda precisa de atenção ativa da TI", não só "nunca foi tocado".
export function useEmAtendimentoCount(secret: string): number {
  const query = useQuery({
    queryKey: ["admin-em-atendimento-count"],
    queryFn: () => fetchTasks(secret, { status: "em atendimento" }),
    refetchInterval: POLL_MS,
    enabled: !!secret,
  })
  return query.data?.total ?? 0
}
