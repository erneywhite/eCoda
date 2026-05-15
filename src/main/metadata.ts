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
    for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
      // yt-dlp prefixes HttpOnly cookies with "#HttpOnly_" — and the
      // important auth cookies (__Secure-3PSID, SAPISID, LOGIN_INFO) all
      // come through that way. A blanket "lines starting with # are
      // comments" rule drops them all, leaving Innertube anonymous.
      let line = rawLine
      if (line.startsWith('#HttpOnly_')) {
        line = line.slice('#HttpOnly_'.length)
      } else if (line.trimStart().startsWith('#') || !line.trim()) {
        continue
      }
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
    const joined = item.artists
      .map((a) => asText((a as Record<string, unknown> | null)?.name))
      .filter(Boolean)
      .join(', ')
    if (joined) return joined
  }
  if (item.author && typeof item.author === 'object') {
    const n = asText((item.author as Record<string, unknown>).name)
    if (n) return n
  }
  // MusicResponsiveListItem (used inside playlists/albums) exposes the
  // artist line as `subtitle` — a Text with the format "Artist • Album".
  // Take the part before the first bullet so we don't render the album too.
  const subtitle = asText(item.subtitle)
  if (subtitle) return subtitle.split(/\s*[•·]\s*/)[0]
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

// ===========================================================================
// HOME FEED — landing-page carousels (recommended playlists / albums / etc.)
// ===========================================================================

export type HomeItemType = 'playlist' | 'album' | 'song' | 'video' | 'artist'

export interface HomeItem {
  id: string
  type: HomeItemType
  title: string
  subtitle: string
  thumbnail: string
}

export interface HomeSection {
  title: string
  items: HomeItem[]
}

// Maps a youtubei.js home-feed item_type to our narrower union. Unknown
// types are dropped (caller filters nulls).
function normaliseType(t: unknown): HomeItemType | null {
  if (t === 'playlist' || t === 'album' || t === 'song' || t === 'video' || t === 'artist') {
    return t
  }
  return null
}

function pickItemTitle(item: Record<string, unknown>): string {
  return asText(item.title) || asText(item.name) || ''
}

function pickItemSubtitle(item: Record<string, unknown>): string {
  return asText(item.subtitle) || asText(item.description) || pickArtist(item)
}

// Returns the home-feed sections: title + a flat list of cards.  Cards can
// be playlists, albums, songs, videos, or artists — we surface the type so
// the UI knows whether to open another view or play directly.
export async function getHomeSections(): Promise<HomeSection[]> {
  const yt = await getInnertube()
  const home = (await yt.music.getHomeFeed()) as unknown
  const rawSections = (home as { sections?: unknown[] }).sections ?? []
  const out: HomeSection[] = []
  for (const s of rawSections) {
    if (!s || typeof s !== 'object') continue
    const section = s as Record<string, unknown>
    const title =
      asText((section.header as Record<string, unknown> | undefined)?.title) ||
      asText(section.title) ||
      ''
    const rawItems = Array.isArray(section.contents) ? section.contents : []
    const items: HomeItem[] = []
    for (const it of rawItems) {
      if (!it || typeof it !== 'object') continue
      const item = it as Record<string, unknown>
      const type = normaliseType(item.item_type)
      const id = typeof item.id === 'string' ? item.id : ''
      const cardTitle = pickItemTitle(item)
      if (!type || !id || !cardTitle) continue
      items.push({
        id,
        type,
        title: cardTitle,
        subtitle: pickItemSubtitle(item),
        thumbnail: pickThumbnail(item)
      })
    }
    if (items.length > 0) out.push({ title, items })
  }
  return out
}

// ===========================================================================
// PLAYLIST — open a playlist (or album) and return its tracks as SearchResults
// ===========================================================================

export async function getPlaylistTracks(id: string): Promise<{
  title: string
  subtitle: string
  thumbnail: string
  tracks: SearchResult[]
}> {
  const yt = await getInnertube()
  const pl = (await yt.music.getPlaylist(id)) as unknown
  const obj = pl as Record<string, unknown>
  const header = (obj.header ?? {}) as Record<string, unknown>
  const rawItems = Array.isArray(obj.items)
    ? obj.items
    : Array.isArray(obj.contents)
      ? obj.contents
      : []

  const tracks: SearchResult[] = []
  for (const it of rawItems) {
    if (!it || typeof it !== 'object') continue
    const item = it as Record<string, unknown>
    const videoId =
      typeof item.id === 'string'
        ? item.id
        : typeof item.video_id === 'string'
          ? item.video_id
          : ''
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) continue
    const trackTitle = asText(item.title) || asText(item.name)
    if (!trackTitle) continue
    const duration =
      item.duration && typeof item.duration === 'object'
        ? fmtDuration((item.duration as Record<string, unknown>).seconds)
        : ''
    tracks.push({
      id: videoId,
      title: trackTitle,
      artist: pickArtist(item),
      duration,
      thumbnail: pickThumbnail(item)
    })
  }

  return {
    title: asText(header.title) || '',
    subtitle: asText(header.subtitle) || asText(header.description) || '',
    thumbnail: pickThumbnail(header),
    tracks
  }
}

// NOTE: extracting playable stream URLs via youtubei.js does NOT work for
// YouTube Music tracks in the current YouTube backend. Music tracks return
// `streaming_data` as empty (0 audio formats) without a valid po_token
// (Proof-of-Origin Token). Switching the InnerTube client (IOS / ANDROID /
// TV_EMBEDDED / YTMUSIC_ANDROID) does not help — the gate is po_token, not
// the client. Stream extraction is handled by yt-dlp in `ytdlp.ts`.
//
// If we ever want to drop the yt-dlp dependency, the path is to integrate
// `LuanRT/bgutils-js` to emulate BotGuard and synthesise a po_token, then
// pass it to Innertube.create({ po_token, visitor_data, ... }). Until then,
// yt-dlp handles this for us — it generates po_token via its own Deno-run
// JS challenges. See probe-music.json + probe-format.json in repo root for
// the empirical evidence that drove this decision.
