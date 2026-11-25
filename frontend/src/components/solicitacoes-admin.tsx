// Tela "Solicitações" do painel da TI: a lista (SolicitacoesView em modo admin) ligada ao servidor.

import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SolicitacoesView } from "@/components/solicitacoes-view"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import { isSessionError } from "@/lib/api"
import { LISTA_POLL_MS } from "@/lib/constants"
import { fetchSolicitacoesAdmin, mudarStatusSolicitacao, type SolicStatus } from "@/lib/solicitacoes-api"

export const CHAVE_SOLICITACOES_ADMIN = ["solicitacoes-admin"] as const

export function SolicitacoesAdmin() {
  const { secret, logout } = useAdminAuth()
  const qc = useQueryClient()
  const [erro, setErro] = useState<string | null>(null)

  const consulta = useQuery({
    queryKey: CHAVE_SOLICITACOES_ADMIN,
    queryFn: () => fetchSolicitacoesAdmin(secret),
    refetchInterval: LISTA_POLL_MS,
  })

  const mudar = useMutation({
    mutationFn: ({ id, status, motivo }: { id: string; status: SolicStatus; motivo?: string }) => mudarStatusSolicitacao(secret, id, status, motivo),
    onMutate: () => setErro(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: CHAVE_SOLICITACOES_ADMIN }),
    onError: (e) => {
      if (isSessionError(e)) return logout()
      setErro(e instanceof Error ? e.message : "Não foi possível mudar a etapa.")
      // se a lista mudou por baixo (409), mostra o que está valendo agora
      qc.invalidateQueries({ queryKey: CHAVE_SOLICITACOES_ADMIN })
    },
  })

  if (consulta.isLoading) return <Skeleton className="h-64 rounded-xl" />
  if (consulta.isError && !consulta.data) {
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex items-center justify-between gap-2">
          Não foi possível carregar as solicitações.
          <Button size="sm" variant="outline" onClick={() => consulta.refetch()}>Tentar de novo</Button>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {erro && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{erro}</AlertDescription>
        </Alert>
      )}
      <SolicitacoesView
        solicitacoes={consulta.data?.solicitacoes ?? []}
        modo="admin"
        ocupadoId={mudar.isPending ? mudar.variables?.id : null}
        onMudarStatus={(s, status, motivo) => mudar.mutate({ id: s.id, status, motivo })}
      />
    </div>
  )
}
