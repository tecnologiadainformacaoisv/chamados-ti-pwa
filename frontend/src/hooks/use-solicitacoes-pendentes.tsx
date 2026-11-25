// Selo do menu "Solicitações": quantos pedidos esperam a primeira resposta da TI. Usa a MESMA consulta da tela
// (mesma chave), então abrir a tela não faz um segundo pedido ao servidor.

import { useQuery } from "@tanstack/react-query"
import { CHAVE_SOLICITACOES_ADMIN } from "@/components/solicitacoes-admin"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { LISTA_POLL_MS } from "@/lib/constants"
import { fetchSolicitacoesAdmin } from "@/lib/solicitacoes-api"

export function useSolicitacoesPendentes(): number {
  const { secret } = useAdminAuth()
  const consulta = useQuery({
    queryKey: CHAVE_SOLICITACOES_ADMIN,
    queryFn: () => fetchSolicitacoesAdmin(secret),
    refetchInterval: LISTA_POLL_MS,
    enabled: !!secret,
    retry: false,
  })
  return consulta.data?.pendentes ?? 0
}
