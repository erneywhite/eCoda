import { app } from 'electron'
import { join, dirname, delimiter } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import ytdlpRawPath from '../../resources/yt-dlp.exe?asset'
import denoRawPath from '../../resources/deno.exe?asset'
import { getAudioQuality, type AudioQuality } from './auth'

// `?asset` resolves to a path INSIDE app.asar in packaged builds. Files
// listed under build.asarUnpack live at app.asar.unpacked instead, and
// Electron's child_process patch transparently redirects execFile for
// those — but NOT spawn. Spawn-with-asar-path fails ENOENT in packaged
// builds, which broke 0.0.8 downloads completely. Rewriting `app.asar\`
// → `app.asar.unpacked\` ourselves gives spawn a real on-disk path; in
// dev there's no "app.asar" segment in the string so the replace is a
// no-op.
function asUnpackedPath(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}
const ytdlpPath = asUnpackedPath(ytdlpRawPath)
const denoPath = asUnpackedPath(denoRawPath)

// Map<videoId, ChildProcess> of in-flight yt-dlp downloads so cancel
// requests can target the right process. Bulk downloads check
// `bulkCancelled` between iterations to stop the loop without waiting
// for each remaining track to error out individually.
const runningProcesses = new Map<string, ReturnType<typeof spawn>>()
let bulkCancelled = false

// Cancels a single in-flight download (per-track ↓ in the playlist row
// or the player-bar chip). Returns true if a process was found and a
// kill was attempted. The killed process's runYtdlp promise rejects
// with the standard non-zero exit error; downloadOne propagates that
// as a download failure, which the renderer interprets as "cancelled"
// since we cleared its in-flight state at click time.
export function cancelDownload(videoId: string): boolean {
  const proc = runningProcesses.get(videoId)
  if (!proc) return false
  try {
    proc.kill()
  } catch (err) {
    console.warn(`[downloads] cancel kill failed for ${videoId}:`, err)
    return false
  }
  return true
}

// Cancels every in-flight download AND signals downloadMany to stop
// iterating. Used by the bulk-download cancel button so the user can
// abort a long playlist mid-way. Tracks that already finished stay on
// disk; the one currently mid-download is killed (partial file is
// cleaned up by the close-handler in downloadOne).
export function cancelAllDownloads(): void {
  bulkCancelled = true
  for (const [id, proc] of runningProcesses) {
    try {
      proc.kill()
    } catch (err) {
      console.warn(`[downloads] cancelAll kill failed for ${id}:`, err)
    }
  }
  runningProcesses.clear()
}

// Wraps yt-dlp in a streaming spawn so the caller can react to live
// progress lines. We add --newline so yt-dlp emits one progress update
// per line (instead of \r-overwriting), which makes parsing trivial.
// Resolves cleanly when the process exits 0; rejects with an Error
// carrying stderr/stdout when it exits non-zero, matching the shape
// summarizeDownloadError() expects.
async function runYtdlp(
  args: string[],
  onProgress?: (percent: number) => void,
  videoId?: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(ytdlpPath, args, { env: ytdlpEnv })
    let stderr = ''
    let stdout = ''
    let lastPct = -1

    // Register the proc so cancelDownload can find it. Always cleared
    // in the close handler so a finished download doesn't leak into
    // the map indefinitely.
    if (videoId) runningProcesses.set(videoId, proc)

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stdout += text
      if (!onProgress) return
      // yt-dlp prints e.g. `[download]  42.5% of  3.45MiB at 1.20MiB/s ETA 00:02`.
      // Multiple progress lines can land in one chunk if the OS pipe
      // buffered things together — pick the last percentage seen.
      let m: RegExpExecArray | null
      const re = /\[download\]\s+(\d+(?:\.\d+)?)%/g
      let captured: number | null = null
      while ((m = re.exec(text)) !== null) captured = parseFloat(m[1])
      if (captured !== null && captured !== lastPct) {
        lastPct = captured
        try {
          onProgress(captured)
        } catch {
          // ignore — progress reporting must not abort the download
        }
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    proc.on('error', (err) => {
      if (videoId) runningProcesses.delete(videoId)
      reject(err)
    })
    proc.on('close', (code, signal) => {
      if (videoId) runningProcesses.delete(videoId)
      if (code === 0) {
        resolve()
      } else {
        // Killed-by-signal (proc.kill from cancelDownload) ends with
        // code=null + a signal name. Tag the rejection so the renderer
        // can show "cancelled" rather than a real failure.
        const wasCancelled = code === null && signal != null
        const err = new Error(
          wasCancelled ? 'cancelled' : `yt-dlp exited with code ${code}`
        ) as Error & { stderr: string; stdout: string; cancelled?: boolean }
        err.stderr = stderr
        err.stdout = stdout
        if (wasCancelled) err.cancelled = true
        reject(err)
      }
    })
  })
}

// Cache layout:
//   <userData>/offline/<videoId>.<ext>     — actual audio files
//   <userData>/offline/thumbs/<videoId>.jpg — cached thumbnails
//   <userData>/offline/manifest.json       — index keyed by videoId
//
// The manifest mirrors the on-disk reality. We keep both because
//   - the file is the source of truth for "is this track playable offline"
//   - the manifest carries metadata (title/artist/thumbnail) so the UI
//     can render saved tracks without going back to the server.
//
// HISTORICAL NOTE: this used to be `<userData>/cache/`. On Windows
// (case-insensitive file system) that path resolves to the SAME directory
// as Chromium's internal `Cache/`. Chromium owns its HTTP cache and
// evicts large entries under size pressure — our audio files (50–200 MB
// .webm Opus each) got wiped between launches that way. Renamed to
// `offline/` to escape the collision; migrateLegacyCache() below tries to
// copy any pre-rename leftovers exactly once.

export interface DownloadedTrack {
  videoId: string
  title: string
  artist: string
  thumbnail: string
  ext: string
  sizeBytes: number
  downloadedAt: number
  // True after we've also pulled the cover thumbnail down to disk. UI
  // can then render it from media://thumb/<id> and stay independent of
  // Google CDN throttling.
  hasThumb?: boolean
}

interface Manifest {
  version: 1
  tracks: Record<string, DownloadedTrack>
}

function getCacheDir(): string {
  // `offline/` — see HISTORICAL NOTE at the top of this file for why
  // this isn't called `cache/` even though that's the obvious name.
  const dir = join(app.getPath('userData'), 'offline')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    // Best-effort one-shot migration from the old cache/ location. After
    // it runs the directory creation is idempotent and migrate is a no-op
    // because there's nothing left to copy.
    migrateLegacyCache(dir)
  }
  return dir
}

// One-time copy of any surviving files from <userData>/cache/ to the new
// <userData>/offline/ location. Most users will have nothing left here
// (Chromium long since cleaned them) — this is just so the few who
// caught their audio files in the same launch window don't lose them.
let legacyMigrated = false
function migrateLegacyCache(target: string): void {
  if (legacyMigrated) return
  legacyMigrated = true
  const legacyDir = join(app.getPath('userData'), 'cache')
  if (!existsSync(legacyDir)) return
  try {
    let migrated = 0
    const files = readdirSync(legacyDir)
    for (const name of files) {
      const dot = name.indexOf('.')
      // Only adopt files that look like our naming: <11 char id>.<ext>
      // or `manifest.json` or `thumbs/`. Chromium's own files have wildly
      // different shapes; ignore them.
      if (name === 'manifest.json') {
        try {
          const buf = readFileSync(join(legacyDir, name))
          writeFileSync(join(target, name), buf)
          migrated++
        } catch (err) {
          console.warn(`[downloads] migrate: copy manifest failed:`, err)
        }
        continue
      }
      if (name === 'thumbs') {
        try {
          const subdir = join(legacyDir, 'thumbs')
          const tgtSub = join(target, 'thumbs')
          if (!existsSync(tgtSub)) mkdirSync(tgtSub, { recursive: true })
          for (const tn of readdirSync(subdir)) {
            try {
              const buf = readFileSync(join(subdir, tn))
              writeFileSync(join(tgtSub, tn), buf)
              migrated++
            } catch (err) {
              console.warn(`[downloads] migrate: copy thumb ${tn} failed:`, err)
            }
          }
        } catch (err) {
          console.warn('[downloads] migrate: thumbs dir failed:', err)
        }
        continue
      }
      if (dot !== 11) continue
      try {
        const buf = readFileSync(join(legacyDir, name))
        writeFileSync(join(target, name), buf)
        migrated++
      } catch (err) {
        console.warn(`[downloads] migrate: copy ${name} failed:`, err)
      }
    }
    console.log(`[downloads] migrate from legacy cache/: ${migrated} file(s) copied`)
  } catch (err) {
    console.warn('[downloads] migrate: enumeration failed:', err)
  }
}

function getManifestPath(): string {
  return join(getCacheDir(), 'manifest.json')
}

function loadManifest(): Manifest {
  const path = getManifestPath()
  if (!existsSync(path)) {
    console.log(`[downloads] loadManifest: no file at ${path} — starting empty`)
    return { version: 1, tracks: {} }
  }
  try {
    const raw = readFileSync(path, 'utf-8')
    const m = JSON.parse(raw) as Manifest
    if (m && m.version === 1 && m.tracks) return m
    console.warn(
      `[downloads] loadManifest: file at ${path} has unexpected shape (version=${(m as { version?: unknown })?.version}), reset`
    )
  } catch (err) {
    console.warn(`[downloads] loadManifest: parse failed at ${path}, reset:`, err)
  }
  return { version: 1, tracks: {} }
}

function saveManifest(m: Manifest): void {
  const path = getManifestPath()
  writeFileSync(path, JSON.stringify(m, null, 2), 'utf-8')
}

function getThumbsDir(): string {
  const dir = join(getCacheDir(), 'thumbs')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// File path of a cached thumbnail. Null if we don't have one. We pick a
// `.jpg` extension regardless of the source content-type — every UI
// place that displays it uses `background-image` so the browser sniffs
// the real format.
export function getCachedThumbPath(videoId: string): string | null {
  const path = join(getThumbsDir(), `${videoId}.jpg`)
  return existsSync(path) ? path : null
}

// File path of a cached track. Null if not downloaded. Repairs a stale
// extension automatically (same recovery path as getDownloadedStatus).
export function getCachedFilePath(videoId: string): string | null {
  const m = loadManifest()
  const entry = m.tracks[videoId]
  if (!entry) return null
  const cacheDir = getCacheDir()
  const expected = join(cacheDir, `${videoId}.${entry.ext}`)
  if (existsSync(expected)) return expected
  // Manifest's extension drifted? Try the actual file.
  const stillThere = findCachedFile(cacheDir, videoId)
  if (stillThere) {
    const newExt = stillThere.slice(videoId.length + 1)
    console.warn(
      `[downloads] getCachedFilePath: ${videoId} repaired — manifest ext "${entry.ext}" vs disk "${newExt}"`
    )
    m.tracks[videoId] = { ...entry, ext: newExt }
    saveManifest(m)
    return join(cacheDir, stillThere)
  }
  // Trust but verify: if the file disappeared from disk, drop it from
  // the manifest so we don't keep serving a dead path.
  console.warn(
    `[downloads] getCachedFilePath: ${videoId} dropped — file missing at ${expected}`
  )
  delete m.tracks[videoId]
  saveManifest(m)
  return null
}

// Returns a Set of videoIds out of the input list that are present on disk.
// We also try to recover from the case where the manifest entry's stored
// extension stopped matching what's actually on disk (e.g. yt-dlp picked a
// different container on a re-download) — instead of dropping the entry we
// repair it. That stops the "cache appears empty after restart" failure
// mode the user hit on packaged builds.
export function getDownloadedStatus(videoIds: string[]): string[] {
  const m = loadManifest()
  const cacheDir = getCacheDir()
  const out: string[] = []
  let mutated = false
  for (const id of videoIds) {
    const entry = m.tracks[id]
    if (!entry) continue
    const expected = join(cacheDir, `${id}.${entry.ext}`)
    if (existsSync(expected)) {
      out.push(id)
      continue
    }
    // Look for any file in cacheDir whose stem matches this id —
    // covers the "manifest says .webm, file on disk is .m4a" case.
    const stillThere = findCachedFile(cacheDir, id)
    if (stillThere) {
      const newExt = stillThere.slice(id.length + 1)
      console.warn(
        `[downloads] getDownloadedStatus: ${id} repaired — manifest ext "${entry.ext}" vs disk "${newExt}"`
      )
      m.tracks[id] = { ...entry, ext: newExt }
      mutated = true
      out.push(id)
      continue
    }
    console.warn(
      `[downloads] getDownloadedStatus: ${id} dropped — file missing at ${expected}`
    )
    delete m.tracks[id]
    mutated = true
  }
  if (mutated) saveManifest(m)
  return out
}

// Finds any cached file in `dir` whose name starts with `<id>.` (case-
// sensitive — videoIds are case-sensitive). Returns just the file name,
// or null if none. Used by status/path lookups to survive a drifting
// manifest extension.
function findCachedFile(dir: string, id: string): string | null {
  try {
    const files = readdirSync(dir)
    const found = files.find((f) => f.startsWith(`${id}.`))
    return found ?? null
  } catch {
    return null
  }
}

// Lists every cached track (for a future "Downloaded" library tab).
export function listDownloadedTracks(): DownloadedTrack[] {
  const m = loadManifest()
  return Object.values(m.tracks).sort((a, b) => b.downloadedAt - a.downloadedAt)
}

// Materialises the offline cache as a synthetic playlist so the renderer
// can show it under the same UI as any other playlist (cover + track
// list + per-track controls). Sorted newest-first by download time.
// Thumbnails resolve to media://thumb/<id> when we have a local copy —
// otherwise we fall back to the YT CDN URL captured at download time.
export interface DownloadsPlaylistView {
  title: string
  subtitle: string
  thumbnail: string
  totalBytes: number
  tracks: Array<{
    id: string
    title: string
    artist: string
    duration: string
    thumbnail: string
    sizeBytes: number
  }>
}

export function getDownloadsAsPlaylist(): DownloadsPlaylistView {
  const m = loadManifest()
  const sorted = Object.values(m.tracks).sort((a, b) => b.downloadedAt - a.downloadedAt)
  let totalBytes = 0
  const tracks = sorted.map((t) => {
    totalBytes += t.sizeBytes ?? 0
    return {
      id: t.videoId,
      title: t.title,
      artist: t.artist,
      duration: '',
      // Prefer the locally-cached thumbnail when we have one — that
      // makes the row independent of the YT CDN, same as the per-track
      // thumbnailFor() helper in the renderer.
      thumbnail: t.hasThumb ? `media://thumb/${t.videoId}` : t.thumbnail,
      sizeBytes: t.sizeBytes ?? 0
    }
  })
  // Cover comes from whichever track was downloaded most recently —
  // gives the virtual playlist a real-looking thumbnail without having
  // to ship a generic placeholder.
  const cover = sorted[0]?.hasThumb
    ? `media://thumb/${sorted[0].videoId}`
    : sorted[0]?.thumbnail ?? ''
  return {
    // Title + subtitle filled by the renderer (locale-bound).
    title: '',
    subtitle: '',
    thumbnail: cover,
    totalBytes,
    tracks
  }
}

// Aggregate disk usage of the cache directory (audio + thumbnails) so
// Settings can render "Cache: 1.4 GB · 73 tracks" without the renderer
// having to walk anything itself.
export function getCacheStats(): { tracks: number; bytes: number } {
  const m = loadManifest()
  let bytes = 0
  for (const t of Object.values(m.tracks)) bytes += t.sizeBytes ?? 0
  return { tracks: Object.keys(m.tracks).length, bytes }
}

// Reconcile the manifest with what's actually on disk. Two failure modes
// it patches up:
//   1. Manifest entry, no file → drop the dead entry
//   2. File on disk, no manifest entry → adopt the orphan with a
//      placeholder title; user can re-download it later to fix metadata
// The summary is shown in Settings → Diagnostics so the user can see
// "Cache: removed 0 dead entries, recovered 7 orphans" after a flaky
// restart.
export interface CacheVerifyResult {
  manifestEntries: number
  filesOnDisk: number
  removedDeadEntries: number
  recoveredOrphans: number
  totalAfter: number
}

export function verifyCache(): CacheVerifyResult {
  const cacheDir = getCacheDir()
  const m = loadManifest()
  const initialEntries = Object.keys(m.tracks).length
  let removedDead = 0
  let recovered = 0
  let mutated = false

  // Scan disk first — anything that matches "<11 char id>.<ext>" is a
  // candidate audio file. Anything else (manifest.json, thumbs/, etc.)
  // is ignored.
  const onDisk = new Set<string>()
  const fileByIdOnDisk = new Map<string, string>()
  try {
    for (const name of readdirSync(cacheDir)) {
      const dot = name.indexOf('.')
      if (dot !== 11) continue // YouTube ids are always 11 chars
      const id = name.slice(0, dot)
      // Filter junk like "manifest.json" — alphabetic-only first chars
      // exist in real ids, but ".json" extension is a giveaway.
      const ext = name.slice(dot + 1)
      if (ext === 'json') continue
      onDisk.add(id)
      fileByIdOnDisk.set(id, name)
    }
  } catch (err) {
    console.warn('[downloads] verifyCache: readdir failed:', err)
  }

  // Drop manifest entries whose file is missing on disk.
  for (const id of Object.keys(m.tracks)) {
    if (!onDisk.has(id)) {
      console.warn(`[downloads] verifyCache: dead entry ${id} → removed`)
      delete m.tracks[id]
      removedDead++
      mutated = true
    }
  }

  // Recover files on disk that aren't in the manifest. Metadata is
  // minimal (placeholder title = id) — the user can re-trigger the row
  // from the playlist to populate it properly.
  for (const id of onDisk) {
    if (m.tracks[id]) continue
    const name = fileByIdOnDisk.get(id) ?? ''
    const ext = name.slice(id.length + 1)
    let sizeBytes = 0
    try {
      sizeBytes = readFileSync(join(cacheDir, name)).byteLength
    } catch {
      // not readable — skip
      continue
    }
    console.warn(`[downloads] verifyCache: orphan ${name} → adopted as ${id}`)
    m.tracks[id] = {
      videoId: id,
      title: `(${id})`,
      artist: '',
      thumbnail: '',
      ext,
      sizeBytes,
      downloadedAt: Date.now(),
      hasThumb: existsSync(join(getThumbsDir(), `${id}.jpg`))
    }
    recovered++
    mutated = true
  }

  if (mutated) saveManifest(m)
  const totalAfter = Object.keys(m.tracks).length
  console.log(
    `[downloads] verifyCache: initialEntries=${initialEntries} onDisk=${onDisk.size} removedDead=${removedDead} recovered=${recovered} totalAfter=${totalAfter} cacheDir=${cacheDir}`
  )
  return {
    manifestEntries: initialEntries,
    filesOnDisk: onDisk.size,
    removedDeadEntries: removedDead,
    recoveredOrphans: recovered,
    totalAfter
  }
}

// Nukes the entire offline cache (audio files, thumbnails, manifest).
// Used by the Settings "Clear cache" button when the user wants to
// reclaim disk space.
export function clearAllDownloads(): number {
  const m = loadManifest()
  const ids = Object.keys(m.tracks)
  for (const id of ids) deleteDownloadedTrack(id)
  return ids.length
}

export function deleteDownloadedTrack(videoId: string): boolean {
  const m = loadManifest()
  const entry = m.tracks[videoId]
  if (!entry) return false
  const path = join(getCacheDir(), `${videoId}.${entry.ext}`)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch (err) {
    console.warn(`[downloads] failed to delete ${path}:`, err)
  }
  // Drop the thumbnail too — they're cheap to re-download next time.
  const thumbPath = join(getThumbsDir(), `${videoId}.jpg`)
  try {
    if (existsSync(thumbPath)) unlinkSync(thumbPath)
  } catch {
    // ignore
  }
  delete m.tracks[videoId]
  saveManifest(m)
  return true
}

// yt-dlp environment (Deno on PATH, UTF-8 locale).
const ytdlpEnv: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `${dirname(denoPath)}${delimiter}${process.env.PATH ?? ''}`,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1'
}

export interface TrackInfo {
  videoId: string
  title: string
  artist: string
  thumbnail: string
}

// Maps the user-picked AudioQuality preset to a yt-dlp `-f` format
// selector. The selector reaches into YouTube's own format ladder —
// every option here is a stream YouTube already encodes server-side, so
// there's never any local re-encoding (ffmpeg-free, CPU-cheap).
//
//   best:   bestaudio                  → Format 251, Opus ~160 kbps  (Premium ceiling)
//   medium: bestaudio[abr<=128]/...    → Format 140, AAC ~128 kbps   (Premium tier)
//   low:    bestaudio[abr<=80]/...     → Format 250, Opus ~70 kbps   (general)
//
// The trailing `/bestaudio` fallback in medium/low covers tracks that
// don't expose the constrained tier (very short, rare formats, etc.).
function formatSelectorFor(q: AudioQuality): string {
  switch (q) {
    case 'medium':
      return 'bestaudio[abr<=128]/bestaudio'
    case 'low':
      return 'bestaudio[abr<=80]/bestaudio'
    case 'best':
    default:
      return 'bestaudio'
  }
}

// Downloads one track to <offline>/<videoId>.<ext> via yt-dlp. The
// resulting extension depends on yt-dlp's format choice (typically
// .webm Opus for Premium "best", .m4a AAC for "medium", .webm Opus for
// "low"). Returns the DownloadedTrack entry added to the manifest.
//
// onProgress, when supplied, is called every time yt-dlp prints a new
// percentage line during the actual byte transfer (0–100). The caller
// uses it to drive a progress ring in the UI; we never read the value
// back, only forward it.
export async function downloadOne(
  info: TrackInfo,
  browser: string,
  onProgress?: (percent: number) => void
): Promise<DownloadedTrack> {
  const cacheDir = getCacheDir()
  // Already downloaded? short-circuit — we don't re-download to a higher
  // quality if the user bumps the preset later. They can delete + redownload
  // a specific track if they want.
  const existing = getCachedFilePath(info.videoId)
  if (existing) {
    return loadManifest().tracks[info.videoId]
  }

  const quality = await getAudioQuality()
  const formatSelector = formatSelectorFor(quality)
  const outTemplate = join(cacheDir, `${info.videoId}.%(ext)s`)
  try {
    await runYtdlp(
      [
        '-f',
        formatSelector,
        '--no-playlist',
        '--no-warnings',
        // --newline ensures yt-dlp prints each progress update on its own
        // line instead of \r-overwriting, so our line-oriented regex
        // catches every percentage tick. --progress is the default, so no
        // need to add it; we just removed the old --no-progress.
        '--newline',
        '--cookies-from-browser',
        browser,
        '-o',
        outTemplate,
        `https://www.youtube.com/watch?v=${info.videoId}`
      ],
      onProgress,
      info.videoId
    )
  } catch (err) {
    // If a kill cancelled the download, sweep up any partial file yt-dlp
    // left on disk so the user doesn't end up with a 30%-of-a-track
    // playable file. yt-dlp normally writes `<id>.<ext>.part` during
    // transfer and only renames on success; killing mid-flight leaves
    // the .part behind.
    if ((err as { cancelled?: boolean }).cancelled) {
      try {
        for (const f of readdirSync(cacheDir)) {
          if (f.startsWith(`${info.videoId}.`)) {
            try { unlinkSync(join(cacheDir, f)) } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
    throw err
  }

  // yt-dlp picked the extension itself — find the file it wrote.
  const written = readdirSync(cacheDir).find((f) => f.startsWith(`${info.videoId}.`))
  if (!written) throw new Error('yt-dlp returned but no file was written')
  const ext = written.slice(info.videoId.length + 1)
  const fullPath = join(cacheDir, written)
  const sizeBytes = readFileSync(fullPath).byteLength

  // Pull the cover down to disk too so playback (and the playlist UI for
  // already-downloaded tracks) is independent of Google CDN throttling.
  let hasThumb = false
  if (info.thumbnail) {
    try {
      const res = await fetch(info.thumbnail)
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer())
        writeFileSync(join(getThumbsDir(), `${info.videoId}.jpg`), buf)
        hasThumb = true
      }
    } catch (err) {
      console.warn(`[downloads] failed to fetch thumbnail for ${info.videoId}:`, err)
    }
  }

  const entry: DownloadedTrack = {
    videoId: info.videoId,
    title: info.title,
    artist: info.artist,
    thumbnail: info.thumbnail,
    ext,
    sizeBytes,
    downloadedAt: Date.now(),
    hasThumb
  }

  const m = loadManifest()
  m.tracks[info.videoId] = entry
  saveManifest(m)
  return entry
}

// Best-effort one-line summary of why yt-dlp rejected. The Node `execFile`
// rejection bundles stdout/stderr into the error, so we pull the last
// non-empty stderr line — that's almost always the actual yt-dlp diagnostic
// (e.g. "ERROR: [youtube] xxx: Video unavailable" / "Sign in to confirm...").
function summarizeDownloadError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  // execFile errors carry .stderr / .stdout
  const e = err as Error & { stderr?: string; stdout?: string }
  const lines: string[] = []
  if (typeof e.stderr === 'string') lines.push(...e.stderr.split(/\r?\n/))
  if (typeof e.stdout === 'string') lines.push(...e.stdout.split(/\r?\n/))
  const last = lines
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.length > 0 && !l.startsWith('[debug]') && !l.startsWith('[download]'))
  if (last) return last.slice(0, 240)
  return e.message
}

// Sequentially downloads a list of tracks. Calls onProgress after each
// completion (success or failure) so the renderer can update a "12 / 95"
// counter. Skips tracks that are already cached.
export interface DownloadManySummary {
  ok: number
  failed: Array<{ videoId: string; title: string; reason: string }>
}

export async function downloadMany(
  tracks: TrackInfo[],
  browser: string,
  onProgress: (
    done: number,
    total: number,
    current: TrackInfo,
    errored: boolean,
    errorReason?: string
  ) => void,
  onTrackPercent?: (videoId: string, percent: number) => void
): Promise<DownloadManySummary> {
  // Reset the cancellation flag for this batch — a previous bulk that
  // was cancelled would otherwise refuse to run anything for the next.
  bulkCancelled = false
  const total = tracks.length
  let done = 0
  let ok = 0
  const failed: DownloadManySummary['failed'] = []
  console.log(`[downloads] downloadMany: starting batch of ${total}`)
  for (const t of tracks) {
    // Honour a bulk-cancel between tracks. The currently-running yt-dlp
    // was killed in cancelAllDownloads; we just need to stop dispatching
    // new ones.
    if (bulkCancelled) {
      console.log(`[downloads] downloadMany: cancelled at ${done}/${total}`)
      break
    }
    let errored = false
    let reason: string | undefined
    try {
      await downloadOne(t, browser, (pct) => onTrackPercent?.(t.videoId, pct))
      ok++
    } catch (err) {
      errored = true
      reason = summarizeDownloadError(err)
      if ((err as { cancelled?: boolean }).cancelled) reason = 'cancelled'
      failed.push({ videoId: t.videoId, title: t.title, reason })
      console.warn(`[downloads] failed for ${t.videoId} (${t.title}): ${reason}`)
    }
    done++
    try {
      onProgress(done, total, t, errored, reason)
    } catch {
      // ignore renderer-side errors
    }
  }
  console.log(`[downloads] downloadMany: done ok=${ok} failed=${failed.length} total=${total}`)
  return { ok, failed }
}
