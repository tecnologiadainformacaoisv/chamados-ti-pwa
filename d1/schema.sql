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
  tipo          INTEGER NOT NULL,   -- orderindex em TIPOS (app.js)
  setor         INTEGER NOT NULL,   -- orderindex em SETORES (app.js)
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
