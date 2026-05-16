// Simulates "user clicks 5 different tracks in a row" — measures the
// per-call latency the user actually feels.
//
// Two modes:
//   node scripts/bench-resolve.mjs           — per-call spawn (old path)
//   node scripts/bench-resolve.mjs --daemon  — through the persistent
//                                              yt-dlp daemon (new path)
//
// Picks 5 well-known stable tracks (no chance of region-block / region-
// shuffle inflating numbers) and times each resolve. Reports individual
// + min/p50/avg/p95/max.
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { dirname, delimiter, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const run = promisify(execFile)

const RESOURCES = join(process.cwd(), 'resources')
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const YTDLP = join(RESOURCES, 'yt-dlp')
const DENO = join(RESOURCES, isWin ? 'deno.exe' : 'deno')
const PYTHON = isWin
  ? join(RESOURCES, 'python-win', 'python.exe')
  : isMac
    ? join(RESOURCES, 'python-mac', 'bin', 'python3')
    : 'python3'
const DAEMON_SCRIPT = join(RESOURCES, 'yt-dlp-daemon.py')

const useDaemon = process.argv.includes('--daemon')

if (!existsSync(YTDLP) || !existsSync(DENO)) {
  console.error(`Missing ${YTDLP} or ${DENO} — run npm install first.`)
  process.exit(1)
}
if (useDaemon && (!existsSync(PYTHON) || !existsSync(DAEMON_SCRIPT))) {
  console.error(`--daemon mode needs ${PYTHON} and ${DAEMON_SCRIPT}.`)
  process.exit(1)
}

// Read browser id from ecoda config so we hit the same cookies the app does.
const configDir = process.env.APPDATA
  ? join(process.env.APPDATA, 'ecoda')
  : join(process.env.HOME ?? '', 'Library', 'Application Support', 'ecoda')
const configPath = join(configDir, 'config.json')
let browser = 'firefox'
try {
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
  if (cfg.browser) browser = cfg.browser
} catch {
  console.warn(`(no ecoda config; defaulting to ${browser})`)
}

// Five diverse, stable tracks — different genres / uploaders to avoid
// any one extractor path being especially fast or slow. Hand-picked to
// always be region-available so the benchmark doesn't flake.
const TRACKS = [
  { id: 'dQw4w9WgXcQ', name: 'Rick Astley — Never Gonna' },
  { id: 'kJQP7kiw5Fk', name: 'Luis Fonsi — Despacito' },
  { id: '9bZkp7q19f0', name: 'PSY — Gangnam Style' },
  { id: 'YQHsXMglC9A', name: 'Adele — Hello' },
  { id: 'OPf0YbXqDm0', name: 'Mark Ronson — Uptown Funk' }
]

const env = {
  ...process.env,
  PATH: `${dirname(DENO)}${delimiter}${process.env.PATH ?? ''}`,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1'
}

const baseArgs = (videoId) => [
  '-f',
  'bestaudio',
  '--no-playlist',
  '--no-warnings',
  '--extractor-args',
  'youtube:player_client=web_music,web',
  '--cookies-from-browser',
  browser,
  '--print',
  '%(title)s',
  '--print',
  '%(ext)s',
  '--print',
  '%(url)s',
  `https://music.youtube.com/watch?v=${videoId}`
]

// Per-call spawn (the old path) — what every fresh yt-dlp invocation
// cost. Includes Python interpreter init + YoutubeDL construction.
async function spawnRun(videoId) {
  const t0 = Date.now()
  try {
    await run(PYTHON, [YTDLP, ...baseArgs(videoId)], {
      maxBuffer: 10 * 1024 * 1024,
      env
    })
    return { ms: Date.now() - t0, ok: true }
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, err: e.message?.split('\n')[0] }
  }
}

// Daemon path — Python imports yt_dlp once, then handles each
// resolve via JSON over stdin/stdout. After the first call (which
// pays YoutubeDL construction), subsequent calls are pure network.
function startDaemon() {
  const proc = spawn(PYTHON, [DAEMON_SCRIPT, YTDLP], {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const rl = createInterface({ input: proc.stdout })
  const pending = new Map()
  let nextId = 1
  rl.on('line', (line) => {
    try {
      const resp = JSON.parse(line)
      const cb = pending.get(resp.id)
      if (cb) {
        pending.delete(resp.id)
        cb(resp)
      }
    } catch {
      /* ignore non-JSON lines */
    }
  })
  proc.stderr.on('data', (chunk) => {
    process.stderr.write(`[daemon] ${chunk}`)
  })
  return {
    resolve(videoId) {
      const id = nextId++
      return new Promise((res, rej) => {
        pending.set(id, (resp) => {
          if (resp.ok) res(resp)
          else rej(new Error(resp.error))
        })
        proc.stdin.write(
          JSON.stringify({ id, cmd: 'resolve', videoId, browser, denoPath: DENO }) + '\n'
        )
      })
    },
    stop() {
      try {
        proc.stdin.write(JSON.stringify({ id: nextId++, cmd: 'exit' }) + '\n')
        proc.stdin.end()
      } catch {
        /* ignore */
      }
      setTimeout(() => proc.kill(), 200)
    }
  }
}

async function daemonRun(daemon, videoId) {
  const t0 = Date.now()
  try {
    await daemon.resolve(videoId)
    return { ms: Date.now() - t0, ok: true }
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, err: e.message?.split('\n')[0] }
  }
}

// Wipe yt-dlp's own JS-challenge cache so the first call is genuinely
// "cold" (player_js + n-sig solver get re-downloaded).
try {
  await run(PYTHON, [YTDLP, '--rm-cache-dir'], { env })
} catch {
  // ignore
}

const mode = useDaemon ? 'DAEMON' : 'spawn'
console.log(
  `benchmarking 5 cold resolves [${mode}], browser=${browser}, platform=${process.platform}\n`
)
console.log('#'.padEnd(3) + 'track'.padEnd(35) + 'ms')
console.log('-'.repeat(55))

let daemon = null
if (useDaemon) daemon = startDaemon()

const results = []
for (let i = 0; i < TRACKS.length; i++) {
  const t = TRACKS[i]
  const r = useDaemon ? await daemonRun(daemon, t.id) : await spawnRun(t.id)
  results.push(r.ms)
  const status = r.ok ? `${r.ms} ms` : `FAILED (${r.ms} ms) — ${r.err}`
  console.log(`${i + 1}.`.padEnd(3) + t.name.padEnd(35) + status)
}

if (daemon) daemon.stop()

const sorted = [...results].sort((a, b) => a - b)
const p50 = sorted[Math.floor(sorted.length / 2)]
const p95 = sorted[Math.floor(sorted.length * 0.95)]
const avg = Math.round(results.reduce((s, n) => s + n, 0) / results.length)
const min = sorted[0]
const max = sorted[sorted.length - 1]
console.log('-'.repeat(55))
console.log(`min ${min}  p50 ${p50}  avg ${avg}  p95 ${p95}  max ${max}`)
