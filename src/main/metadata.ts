// youtubei.js is ESM-only; our main bundle is CommonJS. The static import is
// kept as type-only (erased at compile time), and the module is loaded via
// dynamic import() at runtime — Node handles the ESM/CJS boundary cleanly.
import type { Innertube } from 'youtubei.js'
import { existsSync, readFileSync } from 'node:fs'
import { getCookiesFilePath } from './auth'

let innertube: Innertube | null = null

// Parses the Netscape cookies file yt-dlp writes at connect time and returns
// a Cookie header string with only YouTube/Google cookies. Empty string if
// the file doesn't exist or has nothing usable.
function readCookieHeader(): string {
  const path = getCookiesFilePath()
  if (!existsSync(path)) return ''
  try {
    const cookies: string[] = []
    // Split on both \r\n and \n so a trailing \r from Windows line endings
    // doesn't end up inside cookie values and break HTTP header validation.
    for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const parts = line.split('\t')
      if (parts.length < 7) continue
      const [domain, , , , , name, value] = parts
      if (!domain.includes('youtube.com') && !domain.includes('google.com')) continue
      // Defensive: skip any cookie whose name or value carries a control
      // character — those are rejected by HTTP header validation.
      if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) continue
      cookies.push(`${name}=${value}`)
    }
    return cookies.join('; ')
  } catch {
    return ''
  }
}

async function getInnertube(): Promise<Innertube> {
  if (!innertube) {
    const cookie = readCookieHeader()
    const mod = await import('youtubei.js')
    innertube = await mod.Innertube.create(cookie ? { cookie } : {})
  }
  return innertube
}

// Forces a fresh Innertube on the next request — call after the user
// (dis)connects so cookies for the new session take effect.
export function resetInnertube(): void {
  innertube = null
}

export interface SearchResult {
  id: string
  title: string
  artist: string
  duration: string
  thumbnail: string
}

export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

function fmtDuration(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Pulls a string out of either a plain string or an object with a .text field
// (the shape YouTube responses often use for runs of styled text).
function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'text' in v) {
    const t = (v as { text: unknown }).text
    if (typeof t === 'string') return t
  }
  return ''
}

function pickArtist(item: Record<string, unknown>): string {
  if (Array.isArray(item.artists)) {
    return item.artists
      .map((a) => asText((a as Record<string, unknown> | null)?.name))
      .filter(Boolean)
      .join(', ')
  }
  if (item.author && typeof item.author === 'object') {
    return asText((item.author as Record<string, unknown>).name)
  }
  return ''
}

// youtubei.js wraps thumbnails in a MusicThumbnail-like object whose
// .contents array holds the actual thumbnail entries; we also accept a raw
// array shape just in case.
function pickThumbnail(item: Record<string, unknown>): string {
  const field = item.thumbnail ?? item.thumbnails
  if (!field || typeof field !== 'object') return ''
  const list = Array.isArray(field)
    ? field
    : Array.isArray((field as { contents?: unknown }).contents)
      ? (field as { contents: unknown[] }).contents
      : []
  if (list.length > 0 && list[0] && typeof list[0] === 'object') {
    const url = (list[0] as { url?: unknown }).url
    if (typeof url === 'string') return url
  }
  return ''
}

// Searches YouTube Music for songs.
export async function searchSongs(query: string): Promise<SearchResult[]> {
  const yt = await getInnertube()
  const raw = (await yt.music.search(query, { type: 'song' })) as unknown
  const top = raw as { songs?: { contents?: unknown[] } }
  const items: unknown[] = top.songs?.contents ?? []

  const out: SearchResult[] = []
  for (const i of items) {
    if (!i || typeof i !== 'object') continue
    const item = i as Record<string, unknown>
    const id =
      typeof item.id === 'string'
        ? item.id
        : typeof item.video_id === 'string'
          ? item.video_id
          : ''
    if (!id) continue
    const title = asText(item.title) || asText(item.name)
    if (!title) continue
    const artist = pickArtist(item)
    const duration =
      item.duration && typeof item.duration === 'object'
        ? fmtDuration((item.duration as Record<string, unknown>).seconds)
        : ''
    const thumbnail = pickThumbnail(item)
    out.push({ id, title, artist, duration, thumbnail })
  }
  return out.slice(0, 30)
}

function toVideoId(input: string): string {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed
  try {
    const u = new URL(trimmed)
    const v = u.searchParams.get('v')
    if (v && /^[\w-]{11}$/.test(v)) return v
  } catch {
    // not a URL
  }
  return trimmed
}

// Resolves a track's title and an audio stream URL via youtubei.js. Uses the
// authenticated session built from the cookies yt-dlp dumped at connect time.
// This is the fast path — no yt-dlp.exe / Deno subprocess. Falls back to
// yt-dlp upstream (see index.ts) if this fails for any given video.
export async function extractStreamUrl(input: string): Promise<ResolvedAudio> {
  const yt = await getInnertube()
  const videoId = toVideoId(input)
  // NOTE: must be getInfo, not getBasicInfo. youtubei.js's getBasicInfo
  // returns a response WITHOUT streaming_data, so chooseFormat throws
  // "Streaming data not available" on every call and we fall back to
  // yt-dlp — defeating the whole point of the fast path.
  const info = await yt.getInfo(videoId)

  const format = info.chooseFormat({ type: 'audio', quality: 'best' })
  if (!format) throw new Error('No audio format available')

  // `decipher` resolves the signed URL; it's async and may throw if the
  // signature/player cipher can't be resolved (e.g. no session player yet).
  const streamUrl = await format.decipher(yt.session.player)
  if (!streamUrl) throw new Error('Failed to derive a playable URL')

  const title = info.basic_info?.title ?? ''
  const mime = format.mime_type ?? ''
  const ext = mime.split(';')[0].split('/')[1] || 'audio'

  return { title, format: ext, streamUrl }
}
