// Servidor estático mínimo (só Node nativo, zero dependência) pra rodar a suíte E2E
// contra o build real de produção (`frontend/dist`) igual ao GitHub Pages serve de
// verdade. Achado escrevendo a suíte (2026-08-17): `vite build` sempre grava `base:
// '/chamados-ti-pwa/'` (GitHub Pages é project site, ver vite.config.ts) direto nos
// caminhos de asset do HTML — `vite preview` sozinho serve na raiz e não sabe
// reescrever isso, dando 404 em todo asset. Aqui a gente serve com um prefixo de
// verdade (`/chamados-ti-pwa/`), removendo ele antes de procurar o arquivo em `dist/`
// — mesmo truque que os scripts ad-hoc desta sessão faziam copiando o dist pra um
// subdiretório físico, só que sem precisar copiar nada.
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, "..", "dist")
const PREFIX = "/chamados-ti-pwa"
const PORT = Number(process.env.PORT || 4173)

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
}

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0])
    if (urlPath.startsWith(PREFIX)) urlPath = urlPath.slice(PREFIX.length) || "/"
    if (urlPath === "/" || urlPath === "") urlPath = "/index.html"
    const filePath = path.join(DIST, urlPath)
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403)
      res.end()
      return
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" })
        res.end("not found: " + urlPath)
        return
      }
      const ext = path.extname(filePath)
      res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" })
      res.end(data)
    })
  })
  .listen(PORT, () => console.log(`[e2e-server] servindo dist/ em http://localhost:${PORT}${PREFIX}/`))
