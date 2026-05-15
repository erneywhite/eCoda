// Benchmarks yt-dlp resolve speed across flag combinations. Tells us
// whether --extractor-args player_client=… or --no-check-formats actually
// move the needle, or if 4-5s/track is just what yt-dlp costs.
//
// Each variant is run twice — the first run is cold (JS-challenge cache
// miss), the second is warm. Both numbers are reported.
//
// Usage: node scripts/bench-ytdlp.mjs [videoId]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, delimiter, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const run = promisify(execFile)

const VIDEO_ID = process.argv[2] || 'J7p4bzqLvCw' // Blinding Lights — what user actually plays
const RESOURCES = join(process.cwd(), 'resources')
const YTDLP = join(RESOURCES, 'yt-dlp.exe')
const DENO = join(RESOURCES, 'deno.exe')

if (!existsSync(YTDLP) || !existsSync(DENO)) {
  console.error('Missing resources/yt-dlp.exe or deno.exe — run npm install first.')
  process.exit(1)
}

// Read the browser id eCoda is using from its config so we hit the same
// cookies the app does
const configPath = join(process.env.APPDATA ?? '', 'ecoda', 'config.json')
let browser = 'firefox'
try {
  const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
  if (cfg.browser) browser = cfg.browser
} catch {
  console.warn(`(no ecoda config; defaulting to ${browser})`)
}
console.log(`benchmarking yt-dlp on ${VIDEO_ID}, browser=${browser}\n`)

const baseArgs = [
  '-f',
  'bestaudio',
  '--no-playlist',
  '--no-warnings',
  '--cookies-from-browser',
  browser,
  '--print',
  '%(title)s',
  '--print',
  '%(ext)s',
  '--print',
  '%(url)s',
  `https://www.youtube.com/watch?v=${VIDEO_ID}`
]

const variants = [
  { name: 'baseline (current code)', extra: [] },
  { name: '+ --no-check-formats', extra: ['--no-check-formats'] },
  { name: '+ player_client=ios', extra: ['--extractor-args', 'youtube:player_client=ios'] },
  { name: '+ player_client=android', extra: ['--extractor-args', 'youtube:player_client=android'] },
  {
    name: '+ player_client=tv_embedded',
    extra: ['--extractor-args', 'youtube:player_client=tv_embedded']
  },
  {
    name: '+ player_client=web_safari',
    extra: ['--extractor-args', 'youtube:player_client=web_safari']
  },
  {
    name: '+ player_client=ios + --no-check-formats',
    extra: ['--no-check-formats', '--extractor-args', 'youtube:player_client=ios']
  }
]

const env = {
  ...process.env,
  PATH: `${dirname(DENO)}${delimiter}${process.env.PATH ?? ''}`
}

async function timeRun(args) {
  const t0 = Date.now()
  try {
    const { stdout } = await run(YTDLP, args, { maxBuffer: 10 * 1024 * 1024, env })
    const lines = stdout.trim().split(/\r?\n/)
    const ms = Date.now() - t0
    return { ms, title: lines[0]?.slice(0, 40), ext: lines[1], urlOk: !!lines[2] }
  } catch (e) {
    return { ms: Date.now() - t0, err: e.message?.split('\n')[0] }
  }
}

// First: clear yt-dlp cache so every variant starts cold-ish on the first run
try {
  await run(YTDLP, ['--rm-cache-dir'], { env })
  console.log('(yt-dlp cache cleared)\n')
} catch {
  // ignore
}

console.log('variant'.padEnd(50) + 'cold ms   warm ms   info')
console.log('-'.repeat(95))
for (const v of variants) {
  const args = [...baseArgs, ...v.extra]
  const r1 = await timeRun(args)
  const r2 = await timeRun(args)
  const info = r1.err
    ? `ERR ${r1.err}`
    : `${r1.title ?? '?'} (${r1.ext})${r1.urlOk ? '' : ' NO URL'}`
  console.log(v.name.padEnd(50) + String(r1.ms).padEnd(10) + String(r2.ms).padEnd(10) + info)
}
