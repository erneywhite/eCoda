import { app } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, delimiter, join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { getCookiesFilePath } from './auth'
import { YtdlpDaemon, YtdlpDaemonPool } from './ytdlp-daemon'

// Cross-platform binary paths. Resolved at runtime so the build
// machine doesn't need both .exe and bare binaries present. See
// downloads.ts for the same pattern + the asar gotcha.
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const binDir = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'resources')
  : join(app.getAppPath(), 'resources')
// On macOS we ship the Python zipapp (a single executable Python script
// archive) instead of the `yt-dlp_macos` PyInstaller binary. The
// PyInstaller bundle extracts ~100 internal .so files at every launch
// and amfid validates each one (~150ms each) → 12-15s cold startup.
// The zipapp imports modules from the system Python install (all
// Apple-signed) → no amfid overhead, ~0.05s startup. Trade-off: macOS
// users need Python 3.10+ installed (Homebrew or python.org). See
// macPython3Path() below for the search order.
// Both platforms now ship the yt-dlp Python zipapp (no `.exe` /
// `_macos` suffix — same file on every OS). The daemon imports
// `yt_dlp` from it via zipimport; per-call fallback runs it through
// bundled standalone Python.
const ytdlpPath = join(binDir, 'yt-dlp')
const denoPath = join(binDir, isWin ? 'deno.exe' : 'deno')

const run = promisify(execFile)

// Finds a usable Python 3.10+ interpreter. We always prefer the
// bundled standalone Python (python-build-standalone) shipped in the
// installer — it's the same release on Mac and Windows for lock-step
// behaviour. Homebrew paths are a dev fallback for the rare case where
// the postinstall fetch was skipped on a development machine.
//
// `/usr/bin/python3` on macOS is excluded because Apple's stub is
// Python 3.9 on every supported macOS version, and yt-dlp requires
// 3.10+. On Windows there's no system-Python fallback — bundled is
// required.
const MAC_PYTHON_CANDIDATES = [
  join(binDir, 'python-mac', 'bin', 'python3'),
  '/opt/homebrew/bin/python3',
  '/opt/homebrew/opt/python@3.13/bin/python3',
  '/opt/homebrew/opt/python@3.14/bin/python3',
  '/usr/local/bin/python3',
  '/usr/local/opt/python@3.13/bin/python3',
  '/usr/local/opt/python@3.14/bin/python3'
]
// Windows layout from python-build-standalone is flat: python.exe sits
// at the top level of the extracted folder (NOT under bin/). pythonw
// is the windowed variant — fine for our use but we prefer console
// python for clearer stderr in dev.
const WIN_PYTHON_CANDIDATES = [join(binDir, 'python-win', 'python.exe')]
let cachedPython3: string | null = null
function bundledPython3Path(): string {
  if (cachedPython3) return cachedPython3
  const candidates = isWin ? WIN_PYTHON_CANDIDATES : MAC_PYTHON_CANDIDATES
  for (const p of candidates) {
    if (existsSync(p)) {
      cachedPython3 = p
      return p
    }
  }
  throw new Error(
    `Bundled Python missing at resources/python-${isWin ? 'win' : 'mac'}/. Re-run \`npm install\` to fetch it.`
  )
}

// Returns the [command, args] tuple to spawn yt-dlp with the given
// user-supplied args. Always: bundled Python + the zipapp.
export function ytdlpInvocation(userArgs: string[]): [string, string[]] {
  return [bundledPython3Path(), [ytdlpPath, ...userArgs]]
}

// Persistent yt-dlp worker pool. Same code path on macOS and Windows
// now — both ship the zipapp + bundled Python, both benefit from
// amortising Python interpreter init (~1.5-2s) and YoutubeDL
// construction (~2-3s) across the lifetime of the app. Cold-resolve
// benchmark on Windows 0.0.48 (per-call spawn): ~6.8s; with the pool
// after first click: ~3s.
//
// POOL_SIZE = 2: enough to keep one foreground user click and one
// background prefetch running concurrently without queueing. Bumping
// higher mostly burns RAM (~70 MB per daemon) without improving
// perceived latency for the music-app traffic pattern.
const POOL_SIZE = 2
let daemonPool: YtdlpDaemonPool | null = null
function getYtdlpDaemonPool(): YtdlpDaemonPool | null {
  if (daemonPool) return daemonPool
  const daemonScript = join(binDir, 'yt-dlp-daemon.py')
  if (!existsSync(daemonScript)) {
    console.warn('[ytdlp] daemon script missing, falling back to per-call spawn')
    return null
  }
  let python: string
  try {
    python = bundledPython3Path()
  } catch (err) {
    console.warn('[ytdlp] no bundled Python available, daemon disabled:', err)
    return null
  }
  daemonPool = new YtdlpDaemonPool(
    POOL_SIZE,
    () => new YtdlpDaemon(python, daemonScript, ytdlpPath, ytdlpEnv)
  )
  daemonPool.start()
  return daemonPool
}

// Called from app startup. Just spins up the pool — no warmup resolve.
// The first user-click pays the YoutubeDL construction cost (~5-7s) on
// one daemon while the other stays cold for background prefetches; the
// second click typically lands on the warmed daemon at ~3s.
//
// (Earlier signature took a `browser` arg for a planned warmup; we
// dropped the warmup because it queued ahead of the user's first click
// and hurt latency — so the param is gone too.)
export function startYtdlpDaemon(): void {
  getYtdlpDaemonPool()
}

export function stopYtdlpDaemon(): void {
  daemonPool?.stop()
  daemonPool = null
}

// yt-dlp solves YouTube's signature/nsig JS challenges with a JS runtime it
// finds on PATH. We ship our own Deno and put it on PATH for the child
// process, so extraction never depends on a system-wide install.
//
// PYTHONIOENCODING is critical on Windows: yt-dlp is a Python program,
// and Python defaults to the active code page (cp1251 in RU locale) for
// stdout. Track names with Cyrillic/CJK/emoji come back mojibake'd when
// Node decodes those bytes as UTF-8. Forcing UTF-8 fixes the player bar
// title and any other %(title)s output we read back.
const ytdlpEnv = {
  ...process.env,
  PATH: `${dirname(denoPath)}${delimiter}${process.env.PATH ?? ''}`,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1'
}

export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

// Accepts a full YouTube / YouTube Music URL or a bare 11-char video id.
// We use the music.youtube.com host because some tracks (Premium-only
// remixes, region-fenced auto-uploads, "art tracks" backed by SoundCloud
// uploaders) are flagged Video unavailable when accessed via the plain
// youtube.com extractor path but work fine under the YT Music context.
function toWatchUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) {
    return `https://music.youtube.com/watch?v=${trimmed}`
  }
  return trimmed
}

// Pulls the 11-char videoId out of either a bare id, a music.youtube
// URL, or a youtu.be link. Returns null if it can't find one — caller
// then falls back to the spawn-based path (which accepts full URLs).
function extractVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed
  const queryMatch = /[?&]v=([\w-]{11})/.exec(trimmed)
  if (queryMatch) return queryMatch[1]
  const shortMatch = /youtu\.be\/([\w-]{11})/.exec(trimmed)
  if (shortMatch) return shortMatch[1]
  return null
}

// Resolves a track's title and audio stream URL. `browser` is the browser
// yt-dlp reads the YouTube login cookies from — that authenticated session
// unlocks Premium quality and gets past YouTube's bot check.
//
// extractor-args player_client=web_music,web tells yt-dlp to try the YT
// Music client first (sees Music-specific availability), then fall back
// to standard web. Some tracks are only resolvable via the music client.
export async function resolveAudio(input: string, browser: string): Promise<ResolvedAudio> {
  // Mac path: route through the persistent daemon (saves ~2s of
  // Python+extractor init per call vs a fresh spawn). Per-call spawn
  // stays as a fallback if the daemon couldn't be started.
  const pool = getYtdlpDaemonPool()
  const videoId = extractVideoId(input)
  if (pool && videoId) {
    const result = await pool.resolve(videoId, browser, denoPath)
    return { title: result.title, format: result.ext, streamUrl: result.url }
  }

  const [cmd, args] = ytdlpInvocation([
    '-f',
    'bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--extractor-args',
    'youtube:player_client=web_music,web',
    '--cookies-from-browser',
    browser,
    // yt-dlp 2026.x no longer auto-discovers JS runtimes on PATH on
    // macOS; without an explicit --js-runtimes it falls back to a slow
    // path that retries on n-challenge failures. Pointing it directly
    // at our bundled Deno keeps cold resolve under 5s.
    '--js-runtimes',
    `deno:${denoPath}`,
    '--print',
    '%(title)s',
    '--print',
    '%(ext)s',
    '--print',
    '%(url)s',
    toWatchUrl(input)
  ])
  const { stdout } = await run(cmd, args, { maxBuffer: 10 * 1024 * 1024, env: ytdlpEnv })
  const [title, format, streamUrl] = stdout.trim().split(/\r?\n/)
  if (!streamUrl) {
    throw new Error('yt-dlp did not return a stream URL')
  }
  return { title, format, streamUrl }
}

// Checks whether a browser has a usable YouTube login by trying to reach the
// user's private "Liked videos" playlist (LL), which requires authentication.
// Side effect: also dumps the cookies to disk for youtubei.js to use later.
export async function verifyBrowserLogin(browser: string): Promise<boolean> {
  const cookieFile = getCookiesFilePath()
  // ALWAYS reset the cookies file before yt-dlp runs. With --cookies <file>
  // present, yt-dlp merges its contents with --cookies-from-browser; if the
  // file still holds last session's cookies (which YouTube has since
  // rotated/invalidated), the merged jar fails auth even though the live
  // browser cookies on their own would have worked. Truncating gives
  // yt-dlp a clean slate to dump into.
  try {
    writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n', 'utf-8')
  } catch (err) {
    console.warn('[verifyBrowserLogin] could not reset cookies file:', err)
  }
  try {
    const [cmd, args] = ytdlpInvocation([
      '--cookies-from-browser',
      browser,
      '--cookies',
      cookieFile,
      '--flat-playlist',
      '--playlist-items',
      '1',
      '--simulate',
      '--no-warnings',
      'https://www.youtube.com/playlist?list=LL'
    ])
    await run(cmd, args, { maxBuffer: 10 * 1024 * 1024, env: ytdlpEnv })
    return true
  } catch (err) {
    // Surface the actual yt-dlp stderr so we can tell whether the failure
    // is "Firefox profile is locked, close the browser", "no YouTube login
    // in this browser", or something else. Otherwise the user just sees a
    // generic "not signed in" UI message and has nothing to act on.
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = (e.stderr ?? e.stdout ?? e.message ?? '')
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-5)
      .join('\n')
    console.warn(`[verifyBrowserLogin] yt-dlp failed for browser=${browser}:\n${detail}`)
    return false
  }
}
