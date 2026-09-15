// Pós-build: o vite-plugin-pwa injeta <link rel="manifest" href=".../manifest.webmanifest">
// (o manifest do app de SOLICITANTES) em toda entrada HTML do build MPA, sem opção de
// escopo por página — remove só essa linha de admin.html; index.html fica intacto.
//
// 🔄 2026-09-15: admin.html ganhou seu PRÓPRIO manifest (admin-manifest.webmanifest,
// referenciado direto no admin.html fonte, ver comentário lá) — reverte a decisão
// anterior ("admin.html nunca deve ser PWA"; agora é um PWA instalável de verdade, só
// que com identidade própria, separada do app de solicitantes). Esse script continua
// necessário: precisa remover só o manifest ERRADO (o do solicitante, injetado
// automaticamente pelo plugin em toda entrada), preservando o `admin-manifest.webmanifest`
// que já vem escrito no admin.html fonte. O regex casa só `manifest.webmanifest`
// (com âncora de fim de palavra antes das aspas) — de propósito NÃO casa
// `admin-manifest.webmanifest`.
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const dir = path.dirname(fileURLToPath(import.meta.url))
const file = path.join(dir, "..", "dist", "admin.html")

const before = readFileSync(file, "utf8")
const after = before.replace(/\s*<link rel="manifest" href="[^"]*\/manifest\.webmanifest">/, "")

if (after === before) {
  console.error("fix-admin-html: manifest do solicitante não encontrado em dist/admin.html — build mudou de formato?")
  process.exit(1)
}
if (!after.includes("admin-manifest.webmanifest")) {
  console.error("fix-admin-html: admin-manifest.webmanifest sumiu de dist/admin.html — checar admin.html fonte")
  process.exit(1)
}

writeFileSync(file, after)
console.log("fix-admin-html: manifest do solicitante removido de dist/admin.html (admin-manifest.webmanifest preservado)")
