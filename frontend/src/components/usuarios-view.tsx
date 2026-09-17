import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { UserPlus, Pencil, Check, X, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useAdminAuth } from "@/hooks/use-admin-auth"
import {
  createSolicitante,
  fetchAdminSolicitantes,
  fetchAdminUsers,
  isSessionError,
  setSolicitanteAtivo,
  setSolicitanteEmail,
  resetSenhaSolicitante,
  fmtDate,
  type AdminSolicitante,
} from "@/lib/api"

// Gestão de solicitantes (Fase M1, 2026-08-13 — migração de saída da ClickUp). Antes
// disso, essa lista só existia como custom field dropdown dentro da própria ClickUp;
// aqui a TI adiciona/desativa quem pode logar no app dos solicitantes, sem precisar
// mexer em nada fora deste painel. Desativar não apaga — chamados antigos continuam
// referenciando o nome pelo histórico (mesmo espírito de "sem atribuição" em vez de
// excluir operador, ver TaskModal).
//
// 2026-09-16 (login por e-mail, pedido da diretoria) — ganhou coluna de e-mail
// (editável inline), status de cadastro (cruzando com GET /admin/users, que nunca
// tinha UI nenhuma até agora) e botão "Resetar senha" — antes disso resetar senha
// de alguém exigia apagar a chave manualmente no painel da Cloudflare (ver
// SEGREDOS-LOCAIS.md/CLAUDE.md).
export function UsuariosView() {
  const { secret, logout } = useAdminAuth()
  const queryClient = useQueryClient()
  const [novoNome, setNovoNome] = useState("")
  const [novoEmail, setNovoEmail] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [editandoEmail, setEditandoEmail] = useState<string | null>(null)
  const [rascunhoEmail, setRascunhoEmail] = useState("")
  const [emailError, setEmailError] = useState<string | null>(null)
  const [resetFeedback, setResetFeedback] = useState<string | null>(null)
  const [soExternos, setSoExternos] = useState(false)

  const solicitantesQuery = useQuery({
    queryKey: ["admin-solicitantes"],
    queryFn: () => fetchAdminSolicitantes(secret),
  })
  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => fetchAdminUsers(secret),
  })

  function onQueryError(err: unknown) {
    if (isSessionError(err)) logout()
  }

  const createMutation = useMutation({
    mutationFn: ({ name, email }: { name: string; email: string }) => createSolicitante(secret, name, email),
    onSuccess: () => {
      setNovoNome("")
      setNovoEmail("")
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

  const emailMutation = useMutation({
    mutationFn: ({ name, email }: { name: string; email: string }) => setSolicitanteEmail(secret, name, email),
    onSuccess: () => {
      setEditandoEmail(null)
      setEmailError(null)
      queryClient.invalidateQueries({ queryKey: ["admin-solicitantes"] })
    },
    onError: (err) => {
      if (isSessionError(err)) { logout(); return }
      setEmailError(err instanceof Error ? err.message : "Não foi possível salvar o e-mail.")
    },
  })

  const resetMutation = useMutation({
    mutationFn: (name: string) => resetSenhaSolicitante(secret, name),
    onSuccess: (_data, name) => {
      setResetFeedback(`Senha de ${name} resetada — a pessoa cadastra uma nova no próximo login.`)
      queryClient.invalidateQueries({ queryKey: ["admin-users"] })
    },
    onError: onQueryError,
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const nome = novoNome.trim()
    if (!nome) { setFormError("Digite um nome."); return }
    createMutation.mutate({ name: nome, email: novoEmail.trim() })
  }

  function iniciarEdicaoEmail(s: AdminSolicitante) {
    setEditandoEmail(s.name)
    setRascunhoEmail(s.email ?? "")
    setEmailError(null)
  }

  function salvarEmail(name: string) {
    emailMutation.mutate({ name, email: rascunhoEmail.trim() })
  }

  if (solicitantesQuery.isError && isSessionError(solicitantesQuery.error)) {
    logout()
    return null
  }

  const todos = solicitantesQuery.data?.solicitantes ?? []
  const totalExternos = todos.filter((s) => s.origem === "externo").length
  const solicitantes = soExternos ? todos.filter((s) => s.origem === "externo") : todos
  const ativos = solicitantes.filter((s) => s.ativo === 1)
  const inativos = solicitantes.filter((s) => s.ativo !== 1)
  const comSenha = new Set((usersQuery.data?.users ?? []).map((u) => u.name))

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-1 flex-col gap-1.5" style={{ minWidth: 180 }}>
          <label className="text-sm font-medium text-foreground" htmlFor="novo-solicitante">
            Nome
          </label>
          <Input
            id="novo-solicitante"
            placeholder="Nome completo"
            value={novoNome}
            onChange={(e) => setNovoNome(e.target.value)}
          />
        </div>
        <div className="flex flex-1 flex-col gap-1.5" style={{ minWidth: 220 }}>
          <label className="text-sm font-medium text-foreground" htmlFor="novo-solicitante-email">
            E-mail institucional
          </label>
          <Input
            id="novo-solicitante-email"
            type="email"
            placeholder="pessoa@institutosaovicente.com.br"
            value={novoEmail}
            onChange={(e) => setNovoEmail(e.target.value)}
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
      {resetFeedback && (
        <Alert>
          <AlertDescription className="flex items-center justify-between gap-2">
            {resetFeedback}
            <Button variant="ghost" size="sm" onClick={() => setResetFeedback(null)}>Fechar</Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Origem (2026-09-17, pedido do usuário: "os chamados tbm estao sendo usados de
          forma externa... preciso que haja uma forma de identificar estes usuarios que
          nao sao os pre selecionados") — quem se autocadastra sem e-mail institucional
          (ver SolicitanteSetup) cai aqui como "Externo", distinto de quem a TI mesma
          cadastrou. Filtro rápido pra achar esses casos sem precisar ler linha por linha. */}
      {totalExternos > 0 && (
        <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={soExternos} onChange={(e) => setSoExternos(e.target.checked)} className="h-3.5 w-3.5" />
          Mostrar só externos ({totalExternos})
        </label>
      )}

      {solicitantesQuery.isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Carregando…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Nome</th>
                <th className="px-3 py-2 font-medium">Origem</th>
                <th className="px-3 py-2 font-medium">E-mail / telefone</th>
                <th className="px-3 py-2 font-medium">Cadastro</th>
                <th className="px-3 py-2 font-medium">Desde</th>
                <th className="px-3 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {[...ativos, ...inativos].map((s) => {
                const editando = editandoEmail === s.name
                const registrou = comSenha.has(s.name)
                return (
                  <tr key={s.name} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className={`px-3 py-2 font-medium ${s.ativo !== 1 ? "text-muted-foreground line-through" : "text-foreground"}`}>
                      {s.name}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          s.origem === "externo" ? "bg-amber-500/15 text-amber-700" : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {s.origem === "externo" ? "Externo" : "Interno"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {editando ? (
                        <div className="flex items-center gap-1.5">
                          <Input
                            autoFocus
                            type="email"
                            value={rascunhoEmail}
                            onChange={(e) => setRascunhoEmail(e.target.value)}
                            className="h-7 w-56"
                            placeholder="pessoa@institutosaovicente.com.br"
                          />
                          <Button size="icon-sm" variant="ghost" disabled={emailMutation.isPending} onClick={() => salvarEmail(s.name)} aria-label="Salvar e-mail">
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon-sm" variant="ghost" onClick={() => setEditandoEmail(null)} aria-label="Cancelar">
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="flex items-center gap-1.5 text-left text-muted-foreground hover:text-foreground"
                            onClick={() => iniciarEdicaoEmail(s)}
                          >
                            {s.email ?? <span className="italic">sem e-mail cadastrado</span>}
                            <Pencil className="h-3 w-3 shrink-0 opacity-50" />
                          </button>
                          {s.telefone && <p className="mt-0.5 text-xs text-muted-foreground">{s.telefone}</p>}
                        </>
                      )}
                      {editando && emailError && <p className="mt-1 text-xs text-destructive">{emailError}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${registrou ? "bg-emerald-500/15 text-emerald-700" : "bg-muted text-muted-foreground"}`}>
                        {registrou ? "Já acessou" : "Aguardando 1º acesso"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{fmtDate(s.created_at)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1.5">
                        {registrou && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={resetMutation.isPending}
                            onClick={() => {
                              if (confirm(`Resetar a senha de ${s.name}? A pessoa vai precisar cadastrar uma senha nova no próximo login.`)) {
                                resetMutation.mutate(s.name)
                              }
                            }}
                          >
                            <KeyRound className="h-3.5 w-3.5" /> Resetar senha
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant={s.ativo === 1 ? "outline" : "default"}
                          disabled={toggleMutation.isPending}
                          onClick={() => toggleMutation.mutate({ name: s.name, ativo: s.ativo !== 1 })}
                        >
                          {s.ativo === 1 ? "Desativar" : "Reativar"}
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {solicitantes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    {soExternos ? "Nenhum solicitante externo cadastrado ainda." : "Nenhum solicitante cadastrado ainda."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Desativar um nome tira ele do login e da lista de filtro — chamados já abertos por essa pessoa continuam
        aparecendo normalmente no histórico. Solicitantes "Interno" precisam de e-mail institucional
        (@institutosaovicente.com.br) cadastrado por aqui pra conseguir entrar; solicitantes "Externo" se
        autocadastraram pela tela de login (visitante/parceiro sem e-mail institucional) com o próprio nome,
        e-mail e telefone — desative se um cadastro externo parecer indevido.
      </p>
    </div>
  )
}
