// youtubei.js is ESM-only; our main bundle is CommonJS. The static import is
// kept as type-only (erased at compile time), and the module is loaded via
// dynamic import() at runtime — Node handles the ESM/CJS boundary cleanly.
import type { Innertube } from 'youtubei.js'
import { existsSync, readFileSync } from 'node:fs'
import { getCookiesFilePath } from './auth'
import { harvestTokens, innertubeFetch } from './token-harvest'

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
    // Phase B: harvest visitor_data + client info from a hidden
    // music.youtube.com window. Passing visitor_data into Innertube.create
    // is what flips InnerTube responses from anonymous (logged_in=0,
    // streaming_data empty for music) to authenticated.
    const tokens = await harvestTokens().catch((err) => {
      console.warn('[metadata] token harvest failed:', err)
      return null
    })
    const mod = await import('youtubei.js')
    const opts: Record<string, unknown> = { lang: 'ru', location: 'RU' }
    if (cookie) opts.cookie = cookie
    if (tokens?.visitorData) opts.visitor_data = tokens.visitorData
    console.log(
      `[metadata] creating Innertube cookie=${!!cookie} visitor_data=${!!tokens?.visitorData} lang=ru gl=RU`
    )
    innertube = await mod.Innertube.create(opts)
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
// LIBRARY — user's own playlists / songs / etc., via the page proxy so
// the server treats us as logged-in.
// ===========================================================================

// Walks an arbitrary YouTube response shape and yields every nested object
// that has the named key. Tiny tree-walker, used to find the renderer we
// care about regardless of how deeply YouTube wraps it.
function* findAll(node: unknown, key: string): Generator<Record<string, unknown>> {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) yield* findAll(child, key)
    return
  }
  const obj = node as Record<string, unknown>
  if (key in obj && obj[key] && typeof obj[key] === 'object') {
    yield obj[key] as Record<string, unknown>
  }
  for (const v of Object.values(obj)) yield* findAll(v, key)
}

// Extracts the run text out of a Text { runs: [...] } shape (raw YT
// response uses this for every styled string).
function runsText(t: unknown): string {
  if (!t || typeof t !== 'object') return ''
  const obj = t as Record<string, unknown>
  if (typeof obj.simpleText === 'string') return obj.simpleText
  const runs = obj.runs
  if (Array.isArray(runs)) {
    return runs
      .map((r) => {
        const rr = r as Record<string, unknown>
        return typeof rr.text === 'string' ? rr.text : ''
      })
      .join('')
  }
  return ''
}

function thumbnailUrl(t: unknown): string {
  if (!t || typeof t !== 'object') return ''
  const obj = t as Record<string, unknown>
  const thumbs = (obj.thumbnails as Array<{ url?: unknown }>) ?? []
  // Take the last (= largest) thumbnail; YT lists them small → big.
  const last = thumbs[thumbs.length - 1]
  return typeof last?.url === 'string' ? last.url : ''
}

// Walks an arbitrary YT renderer subtree and returns the first thumbnails
// URL it finds. Saves us from having to know the exact nesting (sometimes
// item.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails[], sometimes
// shifted by a level depending on shelf type).
function findFirstThumbnail(node: unknown): string {
  if (!node || typeof node !== 'object') return ''
  if (Array.isArray(node)) {
    for (const child of node) {
      const r = findFirstThumbnail(child)
      if (r) return r
    }
    return ''
  }
  const obj = node as Record<string, unknown>
  if (Array.isArray(obj.thumbnails)) {
    const last = (obj.thumbnails as Array<{ url?: unknown }>).at(-1)
    if (typeof last?.url === 'string') return last.url
  }
  for (const v of Object.values(obj)) {
    const r = findFirstThumbnail(v)
    if (r) return r
  }
  return ''
}

// Parses a musicTwoRowItemRenderer (the playlist/album/artist card shape
// used in HomeFeed AND library landing) into our HomeItem.
function parseTwoRowItem(r: Record<string, unknown>): HomeItem | null {
  const title = runsText(r.title)
  const subtitle = runsText(r.subtitle)
  const thumbnail = thumbnailUrl(
    (r.thumbnailRenderer as Record<string, unknown>)?.musicThumbnailRenderer
      ? ((r.thumbnailRenderer as Record<string, unknown>).musicThumbnailRenderer as Record<string, unknown>).thumbnail
      : (r.thumbnail as Record<string, unknown>)?.musicThumbnailRenderer
        ? ((r.thumbnail as Record<string, unknown>).musicThumbnailRenderer as Record<string, unknown>).thumbnail
        : r.thumbnail
  )

  // The navigationEndpoint tells us what to do on tap AND which id to use.
  // browseEndpoint → playlist/album/artist; watchEndpoint → song/video.
  const nav = r.navigationEndpoint as Record<string, unknown> | undefined
  const browse = nav?.browseEndpoint as Record<string, unknown> | undefined
  const watch = nav?.watchEndpoint as Record<string, unknown> | undefined

  if (browse) {
    const browseId = typeof browse.browseId === 'string' ? browse.browseId : ''
    // pageType tells us playlist vs album vs artist
    const pageType =
      (
        (browse.browseEndpointContextSupportedConfigs as Record<string, unknown>)
          ?.browseEndpointContextMusicConfig as Record<string, unknown>
      )?.pageType ?? ''
    let type: HomeItemType = 'playlist'
    if (typeof pageType === 'string') {
      if (pageType.includes('ALBUM')) type = 'album'
      else if (pageType.includes('ARTIST')) type = 'artist'
      else if (pageType.includes('PLAYLIST')) type = 'playlist'
    }
    if (!browseId || !title) return null
    return { id: browseId, type, title, subtitle, thumbnail }
  }
  if (watch) {
    const videoId = typeof watch.videoId === 'string' ? watch.videoId : ''
    if (!videoId || !title) return null
    return { id: videoId, type: 'song', title, subtitle, thumbnail }
  }
  return null
}

// Pulls the user's playlists tab from FEmusic_liked_playlists (the
// browseId YT Music uses for "My library → Playlists"). Returns a single
// HomeSection so the renderer can re-use the home grid layout.
export async function getLibraryPlaylists(): Promise<HomeSection> {
  const data = await innertubeFetch('/browse', { browseId: 'FEmusic_liked_playlists' })
  const items: HomeItem[] = []
  // The "Liked Music" / Auto-Playlist tile renders as a SECOND copy of an
  // existing playlist in some libraries — and big libraries surface the
  // same item under multiple shelves. Dedupe by id so Svelte's keyed each
  // doesn't see the same key twice.
  const seen = new Set<string>()
  for (const renderer of findAll(data, 'musicTwoRowItemRenderer')) {
    const item = parseTwoRowItem(renderer)
    if (item && !seen.has(item.id)) {
      seen.add(item.id)
      items.push(item)
    }
  }
  return { title: 'Мои плейлисты', items }
}

// ===========================================================================
// PLAYLIST — open a playlist (or album) and return its tracks as SearchResults
// ===========================================================================

// Pulls a flex-column's text out of a musicResponsiveListItemRenderer.
function flexColText(item: Record<string, unknown>, idx: number): string {
  const cols = item.flexColumns as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(cols) || !cols[idx]) return ''
  const inner = (cols[idx] as Record<string, unknown>).musicResponsiveListItemFlexColumnRenderer
  if (!inner || typeof inner !== 'object') return ''
  return runsText((inner as Record<string, unknown>).text)
}

function fixedColText(item: Record<string, unknown>, idx: number): string {
  const cols = item.fixedColumns as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(cols) || !cols[idx]) return ''
  const inner = (cols[idx] as Record<string, unknown>).musicResponsiveListItemFixedColumnRenderer
  if (!inner || typeof inner !== 'object') return ''
  return runsText((inner as Record<string, unknown>).text)
}

export async function getPlaylistTracks(id: string): Promise<{
  title: string
  subtitle: string
  thumbnail: string
  tracks: SearchResult[]
}> {
  // Playlist browse IDs need a "VL" prefix when fed through /browse —
  // YouTube treats VL<id> as "view this playlist as a page". Our Home /
  // Library cards already give us VL... for library; albums use MPRE...
  // which works as-is.
  const browseId = id.startsWith('VL') || id.startsWith('MPRE') ? id : `VL${id}`
  const data = await innertubeFetch('/browse', { browseId })

  // Header may live as musicDetailHeaderRenderer (old) or
  // musicResponsiveHeaderRenderer (newer). Find whichever shows up.
  let title = ''
  let subtitle = ''
  let thumbnail = ''
  for (const h of findAll(data, 'musicDetailHeaderRenderer')) {
    title = runsText(h.title)
    subtitle = runsText(h.subtitle)
    thumbnail = thumbnailUrl(
      ((h.thumbnail as Record<string, unknown>)?.croppedSquareThumbnailRenderer as Record<string, unknown>)
        ?.thumbnail ??
        (h.thumbnail as Record<string, unknown>)?.musicThumbnailRenderer ??
        h.thumbnail
    )
    if (title) break
  }
  if (!title) {
    for (const h of findAll(data, 'musicResponsiveHeaderRenderer')) {
      title = runsText(h.title)
      subtitle = runsText((h.subtitle as unknown) ?? (h.straplineTextOne as unknown))
      thumbnail = thumbnailUrl(
        (h.thumbnail as Record<string, unknown>)?.musicThumbnailRenderer ?? h.thumbnail
      )
      if (title) break
    }
  }

  const tracks: SearchResult[] = []
  const seenTrackIds = new Set<string>()
  for (const item of findAll(data, 'musicResponsiveListItemRenderer')) {
    // Track item: has a navigationEndpoint with watchEndpoint.videoId.
    // Filter out non-track rows (artists, related, etc.) by requiring
    // a videoId.
    const flexCols = item.flexColumns as Array<Record<string, unknown>> | undefined
    const firstCol = flexCols?.[0]
    const firstColRenderer = (firstCol as Record<string, unknown>)
      ?.musicResponsiveListItemFlexColumnRenderer
    const titleRuns = (firstColRenderer as Record<string, unknown>)?.text as
      | Record<string, unknown>
      | undefined
    const navEndpoint = (titleRuns?.runs as Array<Record<string, unknown>> | undefined)?.[0]
      ?.navigationEndpoint as Record<string, unknown> | undefined
    const watch = navEndpoint?.watchEndpoint as Record<string, unknown> | undefined
    const videoId = typeof watch?.videoId === 'string' ? watch.videoId : ''
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) continue
    if (seenTrackIds.has(videoId)) continue
    seenTrackIds.add(videoId)

    const trackTitle = flexColText(item, 0)
    if (!trackTitle) continue
    // flex column 1 typically holds "Artist • Album" — take everything
    // before the first bullet as the artist.
    const col1 = flexColText(item, 1)
    const artist = col1.split(/\s*[•·]\s*/)[0]
    // duration in fixedColumns[0] (some shapes) or flexColumns[2] (others)
    const duration = fixedColText(item, 0) || flexColText(item, 2)
    // Thumbnail nesting varies per shelf type. Just walk the item subtree
    // and use the first thumbnails[] we find.
    const thumb = findFirstThumbnail(item)

    tracks.push({
      id: videoId,
      title: trackTitle,
      artist,
      duration,
      thumbnail: thumb
    })
  }

  // Public playlists from Home (RDCLAK… ids) sometimes come back through
  // /browse without musicResponsiveListItemRenderer rows we can parse —
  // page-proxy got the header but no track list. Fall back to
  // youtubei.js getPlaylist for those, which knows the public-playlist
  // shape and works anonymously.
  if (tracks.length === 0) {
    try {
      const yt = await getInnertube()
      const rawId = id.startsWith('VL') ? id.slice(2) : id
      const pl = (await yt.music.getPlaylist(rawId)) as unknown
      const obj = pl as Record<string, unknown>
      const rawItems = Array.isArray(obj.items)
        ? obj.items
        : Array.isArray(obj.contents)
          ? obj.contents
          : []
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
      // Also try to recover header info if our proxy parse missed it.
      if (!title) {
        const header = (obj.header ?? {}) as Record<string, unknown>
        if (asText(header.title)) title = asText(header.title)
        if (!subtitle && (asText(header.subtitle) || asText(header.description))) {
          subtitle = asText(header.subtitle) || asText(header.description)
        }
        if (!thumbnail) thumbnail = pickThumbnail(header)
      }
    } catch (err) {
      console.warn('[getPlaylistTracks] youtubei.js fallback failed:', err)
    }
  }

  return { title, subtitle, thumbnail, tracks }
}

// ===========================================================================
// STREAMING FAST PATH — /player through the page-proxy
// ===========================================================================

export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

// Calls /youtubei/v1/player through the authenticated page-proxy with the
// ANDROID_MUSIC client spliced into the request body. The WEB_REMIX client
// always returns signatureCipher (Web can run JS to decipher), but
// ANDROID_MUSIC returns plain `url` strings because Android can't —
// Google strips the cipher for it.
//
// Authentication still comes from the page session (cookies + SAPISIDHASH
// + visitor_data), so for our Premium account this gets us 256 kbps Opus
// directly. Resolves in ~200-400ms once the proxy window is warm.
//
// Returns null when something doesn't line up (response shape change, no
// streamingData, no direct url even from ANDROID_MUSIC) — caller falls
// back to yt-dlp.
export async function extractStreamUrlViaPage(videoId: string): Promise<ResolvedAudio | null> {
  const data = (await innertubeFetch(
    '/player',
    { videoId },
    {
      clientName: 'ANDROID_MUSIC',
      clientVersion: '7.27.52',
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14'
    }
  )) as Record<string, unknown>
  const streaming = data.streamingData as Record<string, unknown> | undefined
  const details = data.videoDetails as Record<string, unknown> | undefined
  if (!streaming) return null

  type Fmt = {
    itag?: number
    mimeType?: string
    bitrate?: number
    audioQuality?: string
    url?: string
    signatureCipher?: string
    cipher?: string
  }
  const adaptive = Array.isArray(streaming.adaptiveFormats)
    ? (streaming.adaptiveFormats as Fmt[])
    : []
  const audio = adaptive.filter((f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('audio/'))
  if (audio.length === 0) return null

  // Highest bitrate wins. Premium opens up the 256 kbps Opus tier (itag
  // 251 / audioQuality AUDIO_QUALITY_HIGH); for non-Premium accounts the
  // best is usually itag 140 (128 kbps AAC).
  audio.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
  const best = audio[0]
  if (!best.url) return null

  const mime = best.mimeType ?? ''
  const ext = mime.split(';')[0].split('/')[1] || 'audio'
  const title = typeof details?.title === 'string' ? details.title : ''
  return { title, format: ext, streamUrl: best.url }
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
