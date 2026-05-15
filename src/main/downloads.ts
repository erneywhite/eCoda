import { app } from 'electron'
import { join, dirname, delimiter } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ytdlpPath from '../../resources/yt-dlp.exe?asset'
import denoPath from '../../resources/deno.exe?asset'

const run = promisify(execFile)

// Cache layout:
//   <userData>/cache/<videoId>.<ext>     — actual audio files
//   <userData>/cache/manifest.json       — index keyed by videoId
//
// The manifest mirrors the on-disk reality. We keep both because
//   - the file is the source of truth for "is this track playable offline"
//   - the manifest carries metadata (title/artist/thumbnail) so the UI
//     can render saved tracks without going back to the server.

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
  const dir = join(app.getPath('userData'), 'cache')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getManifestPath(): string {
  return join(getCacheDir(), 'manifest.json')
}

function loadManifest(): Manifest {
  const path = getManifestPath()
  if (!existsSync(path)) return { version: 1, tracks: {} }
  try {
    const m = JSON.parse(readFileSync(path, 'utf-8')) as Manifest
    if (m && m.version === 1 && m.tracks) return m
  } catch {
    // fall through to a fresh manifest
  }
  return { version: 1, tracks: {} }
}

function saveManifest(m: Manifest): void {
  writeFileSync(getManifestPath(), JSON.stringify(m, null, 2), 'utf-8')
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

// File path of a cached track. Null if not downloaded.
export function getCachedFilePath(videoId: string): string | null {
  const m = loadManifest()
  const entry = m.tracks[videoId]
  if (!entry) return null
  const path = join(getCacheDir(), `${videoId}.${entry.ext}`)
  // Trust but verify: if the file disappeared from disk, drop it from
  // the manifest so we don't keep serving a dead path.
  if (!existsSync(path)) {
    delete m.tracks[videoId]
    saveManifest(m)
    return null
  }
  return path
}

// Returns a Set of videoIds out of the input list that are present on disk.
export function getDownloadedStatus(videoIds: string[]): string[] {
  const m = loadManifest()
  const cacheDir = getCacheDir()
  const out: string[] = []
  let mutated = false
  for (const id of videoIds) {
    const entry = m.tracks[id]
    if (!entry) continue
    if (!existsSync(join(cacheDir, `${id}.${entry.ext}`))) {
      delete m.tracks[id]
      mutated = true
      continue
    }
    out.push(id)
  }
  if (mutated) saveManifest(m)
  return out
}

// Lists every cached track (for a future "Downloaded" library tab).
export function listDownloadedTracks(): DownloadedTrack[] {
  const m = loadManifest()
  return Object.values(m.tracks).sort((a, b) => b.downloadedAt - a.downloadedAt)
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

// Downloads one track to <cache>/<videoId>.<ext> via yt-dlp. The
// resulting extension depends on yt-dlp's format choice (typically
// .webm Opus for Premium accounts, .m4a otherwise). Returns the
// DownloadedTrack entry that was added to the manifest.
export async function downloadOne(info: TrackInfo, browser: string): Promise<DownloadedTrack> {
  const cacheDir = getCacheDir()
  // Already downloaded? short-circuit.
  const existing = getCachedFilePath(info.videoId)
  if (existing) {
    return loadManifest().tracks[info.videoId]
  }

  const outTemplate = join(cacheDir, `${info.videoId}.%(ext)s`)
  await run(
    ytdlpPath,
    [
      '-f',
      'bestaudio',
      '--no-playlist',
      '--no-warnings',
      '--no-progress',
      '--cookies-from-browser',
      browser,
      '-o',
      outTemplate,
      `https://www.youtube.com/watch?v=${info.videoId}`
    ],
    { maxBuffer: 50 * 1024 * 1024, env: ytdlpEnv }
  )

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

// Sequentially downloads a list of tracks. Calls onProgress after each
// completion (success or failure) so the renderer can update a "12 / 95"
// counter. Skips tracks that are already cached.
export async function downloadMany(
  tracks: TrackInfo[],
  browser: string,
  onProgress: (done: number, total: number, current: TrackInfo, errored: boolean) => void
): Promise<void> {
  const total = tracks.length
  let done = 0
  for (const t of tracks) {
    let errored = false
    try {
      await downloadOne(t, browser)
    } catch (err) {
      errored = true
      console.warn(`[downloads] failed for ${t.videoId} (${t.title}):`, err)
    }
    done++
    try {
      onProgress(done, total, t, errored)
    } catch {
      // ignore renderer-side errors
    }
  }
}
