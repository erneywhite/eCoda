import { app } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

// Keeps yt-dlp fresh without shipping a new eCoda release.
//
// YouTube breaks yt-dlp every few weeks (signature / n-challenge changes,
// player client shuffles). The zipapp bundled with the installer is frozen
// at build time, so without this every such break meant "no playback until
// a new eCoda build lands on both OSes". Instead we keep a second copy in
// <userData>/yt-dlp/ and use whichever of the two is newer.
//
// Layout:
//   <userData>/yt-dlp/yt-dlp-<version>   the zipapp (versioned file name:
//                                         on Windows a running daemon may
//                                         hold the old file, so we never
//                                         overwrite in place)
//   <userData>/yt-dlp/state.json          { version, file, checkedAt }
//
// The bundled copy's version comes from resources/yt-dlp.version, written by
// scripts/fetch-ytdlp.mjs. If that file is missing (old dev checkout) the
// bundled copy counts as "unknown" and any downloaded copy wins.

const run = promisify(execFile)

const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
// After a failed resolve we check right away, but no more than once an hour —
// a dead network shouldn't turn every click into a GitHub request.
const FAILURE_CHECK_THROTTLE_MS = 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 20 * 1000
const RECHECK_TICK_MS = 6 * 60 * 60 * 1000

interface UpdaterState {
  version: string
  file: string
  checkedAt: number
}

export interface YtdlpVersionInfo {
  active: string | null
  source: 'bundled' | 'downloaded'
  bundled: string | null
  downloaded: string | null
  checkedAt: number | null
}

const updateDir = join(app.getPath('userData'), 'yt-dlp')
const statePath = join(updateDir, 'state.json')

let bundledPath = ''
let bundledVersion: string | null = null
let state: UpdaterState | null = null
let activePath = ''
let checkInFlight: Promise<boolean> | null = null
let lastFailureCheck = 0
let pythonPathGetter: (() => string) | null = null
let onUpdated: (() => void) | null = null

// Compares yt-dlp versions like "2026.08.19" or "2026.08.19.232839"
// (nightly) numerically, part by part.
export function compareYtdlpVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function readState(): UpdaterState | null {
  try {
    const s = JSON.parse(readFileSync(statePath, 'utf-8')) as Partial<UpdaterState>
    if (typeof s.version !== 'string' || typeof s.file !== 'string') {
      return { version: '', file: '', checkedAt: Number(s.checkedAt) || 0 }
    }
    return { version: s.version, file: s.file, checkedAt: Number(s.checkedAt) || 0 }
  } catch {
    return null
  }
}

async function writeState(next: UpdaterState): Promise<void> {
  await mkdir(updateDir, { recursive: true })
  const tmp = `${statePath}.tmp`
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8')
  await rename(tmp, statePath)
  state = next
}

function downloadedPath(): string | null {
  if (!state?.file) return null
  const p = join(updateDir, state.file)
  return existsSync(p) ? p : null
}

function downloadedIsNewer(): boolean {
  if (!state?.version || !downloadedPath()) return false
  if (!bundledVersion) return true
  return compareYtdlpVersions(state.version, bundledVersion) > 0
}

function pickActivePath(): void {
  activePath = downloadedIsNewer() ? downloadedPath()! : bundledPath
}

// Must run before the first getActiveYtdlpPath() call. Sync on purpose:
// it only reads two tiny files and the daemon pool needs the answer
// synchronously.
export function initYtdlpUpdater(opts: {
  bundledZipapp: string
  pythonPath: () => string
  onUpdated: () => void
}): void {
  bundledPath = opts.bundledZipapp
  pythonPathGetter = opts.pythonPath
  onUpdated = opts.onUpdated
  try {
    bundledVersion = readFileSync(`${opts.bundledZipapp}.version`, 'utf-8').trim() || null
  } catch {
    bundledVersion = null
  }
  state = readState()
  pickActivePath()
  console.log(
    `[ytdlp-update] bundled=${bundledVersion ?? 'unknown'} downloaded=${state?.version || 'none'} → using ${
      activePath === bundledPath ? 'bundled' : 'downloaded'
    }`
  )
  cleanupStaleFiles()
}

export function getActiveYtdlpPath(): string {
  return activePath || bundledPath
}

export function getYtdlpVersionInfo(): YtdlpVersionInfo {
  const fromDownload = activePath !== bundledPath
  return {
    active: fromDownload ? state?.version ?? null : bundledVersion,
    source: fromDownload ? 'downloaded' : 'bundled',
    bundled: bundledVersion,
    downloaded: state?.version || null,
    checkedAt: state?.checkedAt || null
  }
}

// Removes older downloaded zipapps and leftover partial downloads. Runs at
// startup only, when no daemon holds any of them yet.
function cleanupStaleFiles(): void {
  if (!existsSync(updateDir)) return
  const keep = state?.file
  for (const name of readdirSync(updateDir)) {
    if (name === 'state.json' || name === keep) continue
    if (!name.startsWith('yt-dlp-') && !name.endsWith('.part')) continue
    try {
      unlinkSync(join(updateDir, name))
    } catch (err) {
      console.warn(`[ytdlp-update] could not remove stale ${name}:`, err)
    }
  }
}

// `releases/latest` answers with a redirect to `releases/tag/<tag>`; reading
// the Location header gives the latest tag without the rate-limited REST API.
// (Following redirects all the way doesn't work: asset downloads end up on a
// CDN URL that no longer carries the tag.)
export async function fetchLatestYtdlpTag(): Promise<string> {
  const res = await fetch(`${RELEASES}/latest`, { redirect: 'manual' })
  const location = res.headers.get('location') ?? ''
  const m = /\/releases\/tag\/([^/?#]+)/.exec(location)
  if (!m) throw new Error(`cannot read the latest tag (HTTP ${res.status}, location "${location}")`)
  return decodeURIComponent(m[1])
}

// The checksum list is fetched for the exact tag, so the hash always
// matches the file we download next.
async function fetchLatest(): Promise<{ version: string; sha256: string }> {
  const version = await fetchLatestYtdlpTag()
  const res = await fetch(`${RELEASES}/download/${encodeURIComponent(version)}/SHA2-256SUMS`, {
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`SHA2-256SUMS: HTTP ${res.status}`)
  const sums = await res.text()
  const line = sums.split(/\r?\n/).find((l) => /\s\*?yt-dlp$/.test(l.trim()))
  const sha256 = line?.trim().split(/\s+/)[0]?.toLowerCase()
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('no checksum for yt-dlp in SHA2-256SUMS')
  return { version, sha256 }
}

async function downloadAndVerify(version: string, sha256: string): Promise<string> {
  const res = await fetch(`${RELEASES}/download/${encodeURIComponent(version)}/yt-dlp`, { redirect: 'follow' })
  if (!res.ok) throw new Error(`yt-dlp download: HTTP ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  const actual = createHash('sha256').update(body).digest('hex')
  if (actual !== sha256) throw new Error(`checksum mismatch: expected ${sha256}, got ${actual}`)

  await mkdir(updateDir, { recursive: true })
  const fileName = `yt-dlp-${version}`
  const part = join(updateDir, `${fileName}.part`)
  await writeFile(part, body, { mode: 0o755 })

  // Smoke test: the new zipapp must start under our bundled Python and
  // report the version we expect. Catches a release that needs a newer
  // Python than we ship, or any other "downloads fine, doesn't run" case.
  try {
    const python = pythonPathGetter!()
    const { stdout } = await run(python, [part, '--version'], {
      timeout: 60_000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    })
    if (stdout.trim() !== version) throw new Error(`--version printed "${stdout.trim()}"`)
  } catch (err) {
    await rm(part, { force: true })
    throw new Error(`smoke test failed: ${(err as Error).message}`)
  }

  const finalPath = join(updateDir, fileName)
  await rm(finalPath, { force: true })
  await rename(part, finalPath)
  return fileName
}

async function doCheck(): Promise<boolean> {
  const t0 = Date.now()
  const { version, sha256 } = await fetchLatest()
  const current = getYtdlpVersionInfo().active
  if (current && compareYtdlpVersions(version, current) <= 0) {
    console.log(`[ytdlp-update] up to date (${current})`)
    await writeState({ version: state?.version ?? '', file: state?.file ?? '', checkedAt: Date.now() })
    return false
  }
  console.log(`[ytdlp-update] ${current ?? 'unknown'} → ${version}, downloading`)
  const file = await downloadAndVerify(version, sha256)
  await writeState({ version, file, checkedAt: Date.now() })
  pickActivePath()
  console.log(`[ytdlp-update] installed ${version} in ${Date.now() - t0}ms`)
  onUpdated?.()
  return true
}

// Single-flight: concurrent callers share one check. Resolves true when a
// new version was installed. Never rejects — errors are logged and the
// current copy stays in use.
export function checkYtdlpUpdate(): Promise<boolean> {
  if (!checkInFlight) {
    checkInFlight = doCheck()
      .catch((err) => {
        console.warn('[ytdlp-update] check failed:', (err as Error).message)
        return false
      })
      .finally(() => {
        checkInFlight = null
      })
  }
  return checkInFlight
}

function checkIfDue(): void {
  const last = state?.checkedAt ?? 0
  if (Date.now() - last >= CHECK_INTERVAL_MS) void checkYtdlpUpdate()
}

// Called once at startup. First check is delayed so it never competes with
// the startup reconnect or the user's first click; after that we re-evaluate
// every few hours because eCoda often lives in the tray for days.
export function scheduleYtdlpUpdates(): void {
  setTimeout(checkIfDue, FIRST_CHECK_DELAY_MS)
  setInterval(checkIfDue, RECHECK_TICK_MS).unref?.()
}

// A resolve just failed. That's the moment a fresh yt-dlp is most likely to
// help, so check now instead of waiting for the daily tick (throttled).
export function checkYtdlpUpdateAfterFailure(): void {
  if (Date.now() - lastFailureCheck < FAILURE_CHECK_THROTTLE_MS) return
  lastFailureCheck = Date.now()
  console.log('[ytdlp-update] resolve failed, checking for a newer yt-dlp')
  void checkYtdlpUpdate()
}
