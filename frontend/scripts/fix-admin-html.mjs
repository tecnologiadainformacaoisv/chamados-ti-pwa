// Pós-build (Fase F5): o vite-plugin-pwa injeta <link rel="manifest"> em toda entrada
// HTML do build MPA, sem opção de escopo por página — mas admin.html/AdminApp nunca
// deve ser PWA (ver CLAUDE.md, "Painel de admin"). Remove só essa linha do
// admin.html gerado; index.html (app dos solicitantes) fica intacto.
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const dir = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(dir, "..", "dist", "admin.html")

const before = readFileSync(file, "utf8")
const after = before.replace(/\s*<link rel="manifest"[^>]*>/, "")

if (after === before) {
  console.error("fix-admin-html: nenhuma tag de manifest encontrada em dist/admin.html — build mudou de formato?")
  process.exit(1)
}

writeFileSync(file, after)
console.log("fix-admin-html: manifest removido de dist/admin.html")
