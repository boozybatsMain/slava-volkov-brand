// Cloudflare Pages Function: POST /api/waitlist — лист ожидания Corner Guy (форма на /corner-guy/, src/corner-guy.ts).
// Почты лежат в базе D1 corner-guy-waitlist (привязка DB в настройках проекта Pages slavavolkov), таблица waitlist.
// Выгрузка: дашборд Cloudflare → D1 → corner-guy-waitlist → Console: SELECT * FROM waitlist ORDER BY created_at;
// На GitHub Pages функций нет: зеркало boozybatsmain.github.io шлёт заявку сюда же, поэтому ниже CORS для него.

interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<unknown>
}
interface D1 {
  prepare(sql: string): D1Statement
}
interface Ctx {
  request: Request
  env: { DB?: D1 }
}

const ORIGINS = ['https://slavavolkov.com', 'https://www.slavavolkov.com', 'https://slavavolkov.pages.dev', 'https://boozybatsmain.github.io']
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/

function cors(request: Request): Record<string, string> {
  const o = request.headers.get('Origin') || ''
  return ORIGINS.includes(o) ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin' } : {}
}
function json(request: Request, status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(request) },
  })
}

export const onRequestOptions = ({ request }: Ctx) =>
  new Response(null, {
    status: 204,
    headers: { ...cors(request), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' },
  })

export const onRequestPost = async ({ request, env }: Ctx) => {
  let data: { email?: unknown; source?: unknown; _honey?: unknown }
  try {
    data = await request.json()
  } catch {
    return json(request, 400, { ok: false, error: 'bad-json' })
  }
  if (data._honey) return json(request, 200, { ok: true }) // бот: делаем вид, что записали
  const email = String(data.email ?? '').trim().toLowerCase()
  if (email.length > 254 || !EMAIL.test(email)) return json(request, 400, { ok: false, error: 'bad-email' })
  if (!env.DB) return json(request, 503, { ok: false, error: 'no-db' })

  const cf = (request as Request & { cf?: { country?: string } }).cf
  const source = String(data.source ?? '').slice(0, 200)
  const ua = (request.headers.get('User-Agent') || '').slice(0, 300)
  try {
    await env.DB.prepare(
      'CREATE TABLE IF NOT EXISTS waitlist (email TEXT PRIMARY KEY, created_at TEXT NOT NULL, source TEXT, country TEXT, ua TEXT)',
    ).run()
    await env.DB.prepare('INSERT OR IGNORE INTO waitlist (email, created_at, source, country, ua) VALUES (?, ?, ?, ?, ?)')
      .bind(email, new Date().toISOString(), source, cf?.country ?? '', ua)
      .run()
  } catch (e) {
    console.error('waitlist insert failed', e)
    return json(request, 500, { ok: false, error: 'db' })
  }
  return json(request, 200, { ok: true })
}
