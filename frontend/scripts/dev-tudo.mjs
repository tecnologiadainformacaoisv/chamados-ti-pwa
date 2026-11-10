// Sobe TUDO pra desenvolver olhando os dois lados ao mesmo tempo (2026-11-10):
//   1) o Worker real em Node (scripts/dev-backend.mjs) com dados de teste, e
//   2) o Vite apontando pra ele, com recarga automática a cada alteração no código.
// Depois abra http://localhost:5173/lado-a-lado.html
//   npm run dev:tudo            (mantém os dados da última vez)
//   npm run dev:tudo -- --reset (volta aos dados de exemplo)
import { spawn } from 'node:child_process'
import path from 'node:path'
import { iniciarBackend, PORTA } from './dev-backend.mjs'

const reset = process.argv.includes('--reset')
await iniciarBackend({ reset })

const vite = path.resolve(import.meta.dirname, '..', 'node_modules', 'vite', 'bin', 'vite.js')
const filho = spawn(process.execPath, [vite, '--port', '5173', '--strictPort'], {
  stdio: 'inherit',
  cwd: path.resolve(import.meta.dirname, '..'),
  env: { ...process.env, VITE_WORKER_URL: `http://localhost:${PORTA}` },
})
filho.on('exit', (code) => process.exit(code ?? 0))
process.on('SIGINT', () => filho.kill())
console.log('\n  Painel lado a lado:  http://localhost:5173/lado-a-lado.html\n')
