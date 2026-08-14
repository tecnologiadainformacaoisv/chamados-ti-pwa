-- Schema do banco Cloudflare D1 (chamados-ti-db) — Fase B2 do roadmap de
-- modernização (ver CLAUDE.md, "Decisões técnicas tomadas" e a seção do
-- roadmap). Espelha os campos que hoje vivem como custom fields na ClickUp
-- (ver FIELD_IDS em app.js / push-worker.js) — mas com nomes de coluna
-- diretos, sem a indireção de orderindex que a ClickUp exige.
--
-- ⚠️ Só schema — nenhuma rota do Worker lê/escreve aqui ainda. A ClickUp
-- continua sendo 100% a fonte de verdade em produção. Ver a camada de acesso
-- (funções d1*) em push-worker.js e os testes em tests/d1-layer.test.js.
--
-- Aplicado no banco real via API da Cloudflare em 2026-08-11 (ver histórico
-- de comandos/commit desse dia). Para reaplicar do zero num banco novo:
--   wrangler d1 execute chamados-ti-db --remote --file=d1/schema.sql

CREATE TABLE IF NOT EXISTS chamados (
  id            TEXT PRIMARY KEY,   -- gerado pela aplicação (crypto.randomUUID()), não é o task_id da ClickUp
  name          TEXT NOT NULL,      -- título curto do chamado
  description   TEXT,               -- detalhes adicionais (opcional)
  status        TEXT NOT NULL CHECK (status IN ('aberto', 'em atendimento', 'pendente', 'encerrado')),
  priority      INTEGER NOT NULL CHECK (priority IN (1, 2, 3)),  -- 1 Urgente, 2 Alta, 3 Normal — nunca "Baixa" (regra de negócio)
  tipo          INTEGER,             -- orderindex em TIPOS (app.js); NULL = campo ausente na
                                      -- ClickUp (12 chamados bem antigos, sem custom_fields
                                      -- nenhum preenchido — ver CLAUDE.md "Fase B7")
  setor         INTEGER,             -- orderindex em SETORES (app.js); mesma observação do tipo
  solicitante   TEXT NOT NULL,      -- nome de quem abriu — sempre resolvido da sessão no servidor, nunca do cliente
  email         TEXT,
  solucao       TEXT,
  assignee_id   INTEGER,            -- id do operador (OPERADORES em app.js); NULL = sem atribuição
  due_date      INTEGER,            -- epoch ms — prazo de SLA (aceitação ou finalização, conforme status)
  date_created  INTEGER NOT NULL,   -- epoch ms
  date_closed   INTEGER,            -- epoch ms — preenchido só quando status vira "encerrado"
  start_date    INTEGER,            -- epoch ms — preenchido quando status vira "em atendimento" (início da fase de finalização do SLA)
  created_at    INTEGER NOT NULL,   -- epoch ms — bookkeeping interno (quando a linha foi inserida neste banco)
  updated_at    INTEGER NOT NULL    -- epoch ms — bookkeeping interno (última mutação)
);

-- Índices nos mesmos campos que /admin/tasks já filtra hoje (status, setor, tipo,
-- operador, solicitante) — mantém a busca rápida mesmo com volume maior que hoje.
CREATE INDEX IF NOT EXISTS idx_chamados_status      ON chamados (status);
CREATE INDEX IF NOT EXISTS idx_chamados_setor       ON chamados (setor);
CREATE INDEX IF NOT EXISTS idx_chamados_tipo        ON chamados (tipo);
CREATE INDEX IF NOT EXISTS idx_chamados_assignee    ON chamados (assignee_id);
CREATE INDEX IF NOT EXISTS idx_chamados_solicitante ON chamados (solicitante);
CREATE INDEX IF NOT EXISTS idx_chamados_date_created ON chamados (date_created);

-- Suporte a múltiplos operadores por chamado (B7 parte 2, fase 1 — 2026-08-12).
-- A coluna chamados.assignee_id continua existindo e sendo mantida (primeiro
-- operador, usada hoje por GET /api/my-tasks via d1RowToTaskShape) — esta tabela é
-- a fonte completa, N-pra-N, igual assignees[] da ClickUp. Só ADIÇÃO: nenhuma rota
-- lê daqui ainda (isso é a fase 2, quando GET /admin/tasks e GET /admin/metrics
-- cortarem pro D1 — hoje continuam lendo da ClickUp de propósito).
-- Sem FOREIGN KEY de propósito (chamado_id "se relaciona" com chamados.id só por
-- convenção, sem constraint de verdade) — node:sqlite e possivelmente o D1 real têm
-- `foreign_keys` ligado por padrão, e isso bloquearia qualquer migração futura que
-- precise recriar a tabela `chamados` (ver POST /admin/migrate-schema-nullable-tipo-
-- setor, que já faz exatamente isso). Sem cascade/delete de chamado no app hoje, então
-- não há necessidade real de enforcement aqui.
CREATE TABLE IF NOT EXISTS chamado_assignees (
  chamado_id  TEXT NOT NULL,
  assignee_id INTEGER NOT NULL,
  PRIMARY KEY (chamado_id, assignee_id)
);
CREATE INDEX IF NOT EXISTS idx_chamado_assignees_assignee ON chamado_assignees (assignee_id);

-- Lista de solicitantes (Fase M1 da migração de saída da ClickUp, 2026-08-13) — até
-- aqui essa lista só existia como um custom field dropdown dentro da própria ClickUp
-- (SOLICITANTE_FIELD_ID); o boot inteiro do app dos solicitantes travava
-- (state = "boot-error") se aquele endpoint falhasse. Nome é a chave primária de
-- propósito — é o mesmo valor usado em `chamados.solicitante` e nas chaves de sessão/
-- senha no KV (`auth_<nome>`), sem indireção de id/orderindex nenhuma (diferente da
-- ClickUp, que exigia orderindex). `ativo` desativa em vez de apagar — chamados
-- antigos continuam referenciando o nome pelo histórico, mesmo que a pessoa não
-- trabalhe mais aqui; só para de aparecer no dropdown de login/gestão.
CREATE TABLE IF NOT EXISTS solicitantes (
  name       TEXT PRIMARY KEY,
  ativo      INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- Anexos (Fase M2 da migração de saída da ClickUp, 2026-08-13) — até aqui, todo anexo
-- de chamado morava só na ClickUp (upload direto pra lá, URL pública dela usada direto
-- no <img>/<a> do frontend). `id` é gerado pela aplicação (crypto.randomUUID(), igual
-- chamados.id) — é o que o cliente usa em `GET /api/anexos/:id`, nunca a `r2_key` bruta
-- (não expõe o formato interno da key do bucket). `chamado_id` aponta pro id do
-- chamado (hoje ainda o task_id da ClickUp, até a Fase M3 trocar pra UUID nativo) — sem
-- FOREIGN KEY de propósito, mesmo motivo de chamado_assignees (foreign_keys ligado por
-- padrão no D1/node:sqlite bloquearia recriar a tabela chamados no futuro).
CREATE TABLE IF NOT EXISTS chamado_anexos (
  id           TEXT PRIMARY KEY,
  chamado_id   TEXT NOT NULL,
  r2_key       TEXT NOT NULL,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chamado_anexos_chamado ON chamado_anexos (chamado_id);

-- Histórico + comentários por chamado (Fase B do roadmap pós-MVP-visual, 2026-08-14)
-- — maior lacuna identificada comparando com a ClickUp: até aqui só existia 1 campo
-- "solucao" (sobrescrito, sem log de quem mudou o quê nem espaço pra nota interna da
-- TI). Uma tabela só, timeline unificada (eventos automáticos + notas manuais),
-- ordenada por created_at — é exatamente o conceito já validado no Artifact do MVP
-- visual (drawer de detalhe, linha do tempo misturando os dois tipos.
-- `tipo='nota'`: autor/texto preenchidos (autor é um dos OPERADORES — sem login por
-- pessoa no admin, só ADMIN_SECRET compartilhado, então quem escreve PRECISA se
-- identificar manualmente, não tem sessão pra inferir). `tipo='status'`/`'operador'`:
-- de_valor/para_valor preenchidos, autor/texto nulos — gravados automaticamente por
-- handleAdminUpdateTask (e pela rota de ação em lote), nunca pelo cliente direto.
-- Sem FOREIGN KEY, mesmo motivo de chamado_assignees/chamado_anexos acima.
CREATE TABLE IF NOT EXISTS chamado_eventos (
  id         TEXT PRIMARY KEY,
  chamado_id TEXT NOT NULL,
  tipo       TEXT NOT NULL CHECK (tipo IN ('nota', 'status', 'operador')),
  autor      TEXT,
  texto      TEXT,
  de_valor   TEXT,
  para_valor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chamado_eventos_chamado ON chamado_eventos (chamado_id, created_at);
