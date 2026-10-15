#!/usr/bin/env node
/**
 * One shared headless Chrome (system Chrome, real GPU WebGL) for every screenshot script,
 * instead of a fresh browser per run.
 *
 *   import { openBrowser } from './shared-browser.mjs'
 *   const browser = await openBrowser()      // use exactly like the result of chromium.launch()
 *   const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
 *   …
 *   await browser.close()                    // closes this script's contexts only; Chrome stays up
 *
 * The first caller starts a small background server (this file with --serve) that owns the
 * browser; later callers connect to it. It exits after IDLE_MINUTES without a caller, so nothing
 * is left running. If the shared browser cannot be reached for any reason, openBrowser() falls
 * back to launching a private one, as before.
 *
 *   openBrowser({ private: true })           own browser (use for frame-timing measurements)
 *   SHARED_BROWSER=0 node your-script.mjs    same, without touching the script
 *   node scripts/shared-browser.mjs --status | --stop
 *
 * Queue: at most SHARED_BROWSER_MAX scripts (default 4) hold a browser at once, counted across
 * every project on this machine that uses this helper; the others wait inside openBrowser() for
 * a free slot. A page of a WebGL scene takes about a core, so more of them than that at once
 * slows every agent down. A script that has waited SHARED_BROWSER_WAIT_S seconds (default 120)
 * goes ahead anyway and prints who holds the slots.
 *
 * Why: every Chrome launch costs ~4 MB of profile writes and a scan of every Secure Enclave key
 * Chrome has ever stored in the keychain (thousands of calls into secd/ctkd). That scan is
 * Chrome's orphaned-key garbage collection; it is switched off for these throwaway profiles.
 */
import { chromium } from 'playwright-core'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHROME_ARGS = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl']
const IDLE_MINUTES = 10
const HEARTBEAT_MS = 30_000
const MAX_CLIENTS = Math.max(1, Number(process.env.SHARED_BROWSER_MAX) || 4)
const MAX_WAIT_MS = (Number(process.env.SHARED_BROWSER_WAIT_S) || 120) * 1000

const pwVersion = createRequire(import.meta.url)('playwright-core/package.json').version
const STATE_DIR = path.join(os.tmpdir(), `shared-headless-chrome-pw${pwVersion}`)
const ENDPOINT = path.join(STATE_DIR, 'endpoint.json')
const LAST_USED = path.join(STATE_DIR, 'last-used')
const LOCK = path.join(STATE_DIR, 'starting.lock')
// one queue for every project: cores are shared even where browsers are not
const SLOTS = path.join(os.tmpdir(), 'shared-browser-slots')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const touch = () => fs.writeFileSync(LAST_USED, String(Date.now()))

/** Playwright's own --disable-features switch, read from a launch that never starts a browser. */
async function playwrightDisableFeatures() {
  try {
    await chromium.launch({ executablePath: '/usr/bin/true', timeout: 10_000 })
  } catch (e) {
    return String(e?.message ?? e).match(/--disable-features=[^\s"']+/)?.[0] ?? null
  }
  return null
}

/** The launch every script used before, plus Chrome's keychain scan switched off. */
export async function launchOptions() {
  // Chrome honours only the last --disable-features, so Playwright's list is replaced by a merged one
  const defaults = await playwrightDisableFeatures()
  return {
    channel: 'chrome',
    headless: true,
    args: [...CHROME_ARGS, ...(defaults ? [`${defaults},UnexportableKeyDeletion`] : [])],
    ...(defaults ? { ignoreDefaultArgs: [defaults] } : {}),
  }
}

/** Slots whose holder is still there: its process exists and it refreshed the file in the last 90 s. */
function slotHolders() {
  const holders = []
  for (const name of fs.existsSync(SLOTS) ? fs.readdirSync(SLOTS) : []) {
    const file = path.join(SLOTS, name)
    try {
      const age = Date.now() - fs.statSync(file).mtimeMs
      const holder = JSON.parse(fs.readFileSync(file, 'utf8') || 'null')
      let running = false
      try {
        running = !!holder && (process.kill(holder.pid, 0), true)
      } catch {}
      // an empty file is a slot being written right now; give it a few seconds
      if (holder ? running && age < 3 * HEARTBEAT_MS : age < 5000) holders.push({ ...holder, file })
      else fs.rmSync(file, { force: true })
    } catch {
      // removed by its holder between the listing and the read
    }
  }
  return holders
}

/** Waits for one of the MAX_CLIENTS machine-wide slots. Resolves to the function that gives it back. */
async function takeSlot() {
  fs.mkdirSync(SLOTS, { recursive: true })
  const asked = Date.now()
  for (;;) {
    const taken = new Set(slotHolders().map((h) => path.basename(h.file)))
    for (let i = 0; i < MAX_CLIENTS; i++) {
      const name = `slot-${i}.json`
      if (taken.has(name)) continue
      const file = path.join(SLOTS, name)
      try {
        const script = process.argv.slice(1, 3).map((a) => path.basename(a)).join(' ').slice(0, 80)
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, since: Date.now(), script }), { flag: 'wx' })
      } catch {
        continue // another script took this slot first
      }
      const beat = setInterval(() => fs.utimes(file, new Date(), new Date(), () => {}), HEARTBEAT_MS)
      beat.unref()
      const release = () => {
        clearInterval(beat)
        process.off('exit', release)
        fs.rmSync(file, { force: true })
      }
      process.once('exit', release)
      return release
    }
    if (Date.now() - asked > MAX_WAIT_MS) {
      const who = slotHolders().map((h) => `pid ${h.pid}, ${Math.round((Date.now() - h.since) / 60_000)} min, ${h.script}`)
      console.error(`[shared-browser] no free slot after ${Math.round(MAX_WAIT_MS / 1000)} s, continuing anyway. Holding the slots: ${who.join(' | ')}`)
      return () => {}
    }
    await sleep(250)
  }
}

function readEndpoint() {
  try {
    const state = JSON.parse(fs.readFileSync(ENDPOINT, 'utf8'))
    process.kill(state.pid, 0)
    return state
  } catch {
    return null
  }
}

async function startServer() {
  let owner = false
  try {
    fs.mkdirSync(LOCK)
    owner = true
  } catch {
    // another script is starting it; a lock older than 30 s was left by a crash
    if (Date.now() - fs.statSync(LOCK).mtimeMs > 30_000) fs.rmSync(LOCK, { recursive: true, force: true })
  }
  if (owner) spawn(process.execPath, [fileURLToPath(import.meta.url), '--serve'], { detached: true, stdio: 'ignore' }).unref()
  try {
    for (let i = 0; i < 200 && !readEndpoint(); i++) await sleep(100)
  } finally {
    if (owner) fs.rmSync(LOCK, { recursive: true, force: true })
  }
}

async function connectShared() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = readEndpoint()
    if (state) {
      try {
        const browser = await chromium.connect(state.wsEndpoint, { timeout: 10_000 })
        touch()
        const beat = setInterval(touch, HEARTBEAT_MS)
        beat.unref()
        browser.on('disconnected', () => clearInterval(beat))
        return browser
      } catch {
        fs.rmSync(ENDPOINT, { force: true })
      }
    }
    await startServer()
  }
  throw new Error('shared browser unavailable')
}

async function open(isolated) {
  if (!isolated && process.env.SHARED_BROWSER !== '0') {
    try {
      return await connectShared()
    } catch {
      // fall through: a private browser is never worse than what the scripts did before
    }
  }
  return chromium.launch(await launchOptions())
}

export async function openBrowser({ private: isolated = false } = {}) {
  const release = await takeSlot()
  try {
    const browser = await open(isolated)
    browser.on('disconnected', release)
    return browser
  } catch (e) {
    release()
    throw e
  }
}

async function serve() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  const server = await chromium.launchServer(await launchOptions())
  touch()
  fs.writeFileSync(`${ENDPOINT}.tmp`, JSON.stringify({ wsEndpoint: server.wsEndpoint(), pid: process.pid, started: Date.now() }))
  fs.renameSync(`${ENDPOINT}.tmp`, ENDPOINT)
  const stop = async () => {
    if (readEndpoint()?.pid === process.pid) fs.rmSync(ENDPOINT, { force: true })
    await server.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  server.on('close', () => process.exit(0))
  setInterval(() => {
    if (Date.now() - fs.statSync(LAST_USED).mtimeMs > IDLE_MINUTES * 60_000) stop()
  }, 30_000)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2]
  if (mode === '--serve') await serve()
  else {
    const state = readEndpoint()
    if (mode === '--stop' && state) process.kill(state.pid, 'SIGTERM')
    const idle = state ? Math.round((Date.now() - fs.statSync(LAST_USED).mtimeMs) / 1000) : 0
    console.log(state ? `${mode === '--stop' ? 'stopping' : 'running'}: server pid ${state.pid}, idle ${idle}s, up ${Math.round((Date.now() - state.started) / 60_000)} min` : 'not running')
    const holders = slotHolders()
    console.log(`slots: ${holders.length} of ${MAX_CLIENTS} in use${holders.map((h) => `\n  pid ${h.pid}, ${Math.round((Date.now() - h.since) / 60_000)} min, ${h.script}`).join('')}`)
  }
}
