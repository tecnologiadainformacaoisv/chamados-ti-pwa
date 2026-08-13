import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import {
  createSolicitante,
  fetchAdminSolicitantes,
  isSessionError,
  setSolicitanteAtivo,
  fmtDate,
} from "@/lib/api"

// Gestão de solicitantes (Fase M1, 2026-08-13 — migração de saída da ClickUp). Antes
// disso, essa lista só existia como custom field dropdown dentro da própria ClickUp;
// aqui a TI adiciona/desativa quem pode logar no app dos solicitantes, sem precisar
// mexer em nada fora deste painel. Desativar não apaga — chamados antigos continuam
// referenciando o nome pelo histórico (mesmo espírito de "sem atribuição" em vez de
// excluir operador, ver TaskModal).
export function UsuariosView() {
  const { secret, logout } = useAdminAuth()
  const queryClient = useQueryClient()
  const [novoNome, setNovoNome] = useState("")
  const [formError, setFormError] = useState<string | null>(null)

  const solicitantesQuery = useQuery({
    queryKey: ["admin-solicitantes"],
    queryFn: () => fetchAdminSolicitantes(secret),
  })

  function onQueryError(err: unknown) {
    if (isSessionError(err)) logout()
  }

  const createMutation = useMutation({
    mutationFn: (name: string) => createSolicitante(secret, name),
    onSuccess: () => {
      setNovoNome("")
      setFormError(null)
      queryClient.invalidateQueries({ queryKey: ["admin-solicitantes"] })
    },
    onError: (err) => {
      if (isSessionError(err)) { logout(); return }
      setFormError(err instanceof Error ? err.message : "Não foi possível adicionar.")
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ name, ativo }: { name: string; ativo: boolean }) => setSolicitanteAtivo(secret, name, ativo),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin-solicitantes"] }),
    onError: onQueryError,
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const nome = novoNome.trim()
    if (!nome) { setFormError("Digite um nome."); return }
    createMutation.mutate(nome)
  }

  if (solicitantesQuery.isError && isSessionError(solicitantesQuery.error)) {
    logout()
    return null
  }

  const solicitantes = solicitantesQuery.data?.solicitantes ?? []
  const ativos = solicitantes.filter((s) => s.ativo === 1)
  const inativos = solicitantes.filter((s) => s.ativo !== 1)

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex items-end gap-2 rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-1 flex-col gap-1.5">
          <label className="text-sm font-medium text-foreground" htmlFor="novo-solicitante">
            Adicionar solicitante
          </label>
          <Input
            id="novo-solicitante"
            placeholder="Nome completo"
            value={novoNome}
            onChange={(e) => setNovoNome(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={createMutation.isPending}>
          <UserPlus /> Adicionar
        </Button>
      </form>

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      {solicitantesQuery.isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
          <table className="w-full min-w-[500px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Nome</th>
                <th className="px-3 py-2 font-medium">Cadastrado em</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {[...ativos, ...inativos].map((s) => (
                <tr key={s.name} className="border-b border-border last:border-0 hover:bg-muted/30">
                  <td className={`px-3 py-2 font-medium ${s.ativo !== 1 ? "text-muted-foreground line-through" : "text-foreground"}`}>
                    {s.name}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{fmtDate(s.created_at)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button
                      size="sm"
                      variant={s.ativo === 1 ? "outline" : "default"}
                      disabled={toggleMutation.isPending}
                      onClick={() => toggleMutation.mutate({ name: s.name, ativo: s.ativo !== 1 })}
                    >
                      {s.ativo === 1 ? "Desativar" : "Reativar"}
                    </Button>
                  </td>
                </tr>
              ))}
              {solicitantes.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    Nenhum solicitante cadastrado ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Desativar um nome tira ele do login e da lista de filtro — chamados já abertos por essa pessoa continuam
        aparecendo normalmente no histórico.
      </p>
    </div>
  )
}
