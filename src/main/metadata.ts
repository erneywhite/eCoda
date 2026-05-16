// youtubei.js is ESM-only; our main bundle is CommonJS. The static import is
// kept as type-only (erased at compile time), and the module is loaded via
// dynamic import() at runtime — Node handles the ESM/CJS boundary cleanly.
import type { Innertube } from 'youtubei.js'
import { existsSync, readFileSync } from 'node:fs'
import { getCookiesFilePath, getLocale } from './auth'
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
    const { hl, gl } = await getLocale()
    const opts: Record<string, unknown> = { lang: hl, location: gl }
    if (cookie) opts.cookie = cookie
    if (tokens?.visitorData) opts.visitor_data = tokens.visitorData
    console.log(
      `[metadata] creating Innertube cookie=${!!cookie} visitor_data=${!!tokens?.visitorData} lang=${hl} gl=${gl}`
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
  // True when YT returned this row without a playable videoId — usually
  // a deleted / region-blocked / Premium-only track that the playlist
  // owner once added. We keep the row in the list (matches YT's UI and
  // the library-card count) but the player + next/prev skip over it.
  unavailable?: boolean
  // YT's unique row-id within a playlist (e.g. "31A22D0994588080"). Two
  // copies of the same videoId in one playlist have DIFFERENT setVideoIds,
  // which is how we tell them apart for dedup / pinning / drag-reorder
  // persistence. Absent on search results + Home items + the Downloaded
  // virtual playlist — the renderer falls back to videoId for those.
  setVideoId?: string
  // Whether the user has liked this track. Sourced from the row's
  // `likeStatus` field when the page-proxy includes it (most playlist
  // rows do), and forced to true for tracks served from Liked Music.
  // The renderer's inline heart toggle reads + writes this optimistically.
  liked?: boolean
  // BrowseId (channelId, "UC…") of the primary artist on this row,
  // when the page-proxy carries it (most playlist rows + artist-page
  // top-songs do). Lets the renderer make the artist line a clickable
  // link straight into the artist view. Missing on surfaces where YT
  // doesn't return a navigation endpoint (some search rows, Home
  // single-song cards, etc.) — the row then falls back to plain text.
  artistId?: string
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

// Walks a /browse response looking for the "next page" continuation token.
// YouTube has two shapes for this — newer continuationItemRenderer and the
// older nextContinuationData — and a single response can carry either.
// Returns the token, or null when there are no more pages.
function findContinuationToken(data: unknown): string | null {
  for (const r of findAll(data, 'continuationItemRenderer')) {
    const ep = r.continuationEndpoint as Record<string, unknown> | undefined
    const cmd = ep?.continuationCommand as Record<string, unknown> | undefined
    const token = cmd?.token
    if (typeof token === 'string' && token) return token
  }
  for (const r of findAll(data, 'nextContinuationData')) {
    const token = r.continuation
    if (typeof token === 'string' && token) return token
  }
  return null
}

// Finds the continuation token specifically for the playlist shelf —
// NOT for any other section (Suggested tracks / related / etc) that
// might also paginate independently. If we use a global findContinuationToken
// the response can return a Suggested-section token instead and our
// pagination loop ends up walking the wrong chain, adding non-playlist
// rows to the track list.
function findPlaylistContinuationToken(data: unknown): string | null {
  // Initial /browse VL<id> response — playlist's own continuation lives
  // inside musicPlaylistShelfRenderer.
  for (const shelf of findAll(data, 'musicPlaylistShelfRenderer')) {
    const t = findContinuationToken(shelf)
    if (t) return t
  }
  // Older continuation response shape — contents wrapped in
  // musicPlaylistShelfContinuation.
  for (const cont of findAll(data, 'musicPlaylistShelfContinuation')) {
    const t = findContinuationToken(cont)
    if (t) return t
  }
  // Modern continuation response shape: the rows live in
  // appendContinuationItemsAction.continuationItems, and the "load more"
  // token sits as the LAST entry in that array (a continuationItemRenderer).
  // We must look inside that array for the token, otherwise we stop
  // after one continuation page and big playlists cap at ~200.
  for (const arr of findAll(data, 'continuationItems')) {
    const t = findContinuationToken(arr)
    if (t) return t
  }
  return null
}

// Walks the subtitle column of a track row for the first run that
// carries an artist-pointing browseEndpoint (browseId starts with "UC").
// Returns the channelId for click-to-artist navigation, or null when
// the row's artist line is plain text (no nav endpoint).
function findArtistChannelId(item: Record<string, unknown>): string | null {
  const cols = item.flexColumns as Array<Record<string, unknown>> | undefined
  // Subtitle column. fall back to the first column if subtitle missing.
  const col = cols?.[1] ?? cols?.[0]
  if (!col) return null
  const inner = (col as Record<string, unknown>)
    .musicResponsiveListItemFlexColumnRenderer as Record<string, unknown> | undefined
  const text = inner?.text as Record<string, unknown> | undefined
  const runs = text?.runs as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(runs)) return null
  for (const r of runs) {
    const nav = r.navigationEndpoint as Record<string, unknown> | undefined
    const browse = nav?.browseEndpoint as Record<string, unknown> | undefined
    const id = browse?.browseId
    if (typeof id !== 'string') continue
    // Artist channels start with "UC". MPRE / OLAK are album browseIds,
    // which we don't want here. Defensive: also accept the explicit
    // pageType marker when present.
    const cfg = (browse?.browseEndpointContextSupportedConfigs as Record<string, unknown>)
      ?.browseEndpointContextMusicConfig as Record<string, unknown> | undefined
    const pageType = cfg?.pageType
    if (id.startsWith('UC') || pageType === 'MUSIC_PAGE_TYPE_ARTIST') {
      return id
    }
  }
  return null
}

// Deep-walks a row subtree looking for the row's like state. YT encodes
// it in different shapes depending on the view: `likeStatus: 'LIKE'`
// inside `likeButtonRenderer`, OR as a toggle-menu-item where the
// `defaultServiceEndpoint.likeEndpoint.status` says what the DEFAULT
// click would do — if the default action is "INDIFFERENT" (i.e. remove
// like), the track must already be liked. Returns the literal status
// string when found, null otherwise.
function findLikeStatus(node: unknown): 'LIKE' | 'DISLIKE' | 'INDIFFERENT' | null {
  if (!node || typeof node !== 'object') return null
  const stack: unknown[] = [node]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (Array.isArray(cur)) {
      for (const c of cur) stack.push(c)
      continue
    }
    const obj = cur as Record<string, unknown>
    const ls = obj.likeStatus
    if (ls === 'LIKE' || ls === 'DISLIKE' || ls === 'INDIFFERENT') return ls
    for (const v of Object.values(obj)) stack.push(v)
  }
  return null
}

// Walks a response subtree, pulls every track row out, and appends them
// to `out` (deduped via the shared `seen` set, keyed by playlistSetVideoId
// when present so the same videoId added twice to a playlist shows up
// twice — YT lets users add duplicates and counts them as separate rows
// in the library card subtitle). Used for both the initial /browse
// VL<id> response AND every continuation page that follows.
//
// Scopes the search to the playlist shelf when possible — otherwise a
// global `findAll('musicResponsiveListItemRenderer')` also picks up
// "Suggested tracks" rows that YT bolts on after the real playlist
// contents, inflating the count past what the library card reports.
function parseTrackRowsInto(
  data: unknown,
  seen: Set<string>,
  out: SearchResult[]
): void {
  // Initial /browse VL<id> response: tracks live under
  // musicPlaylistShelfRenderer. Continuation pages (modern shape):
  // appendContinuationItemsAction.continuationItems — an ARRAY field, not
  // a renderer object, but findAll yields objects-of-the-key so it works.
  // Older shape: musicPlaylistShelfContinuation, or musicShelfRenderer.
  const shelves: unknown[] = []
  let pickedFrom = 'fallback-whole-tree'
  for (const c of findAll(data, 'musicPlaylistShelfRenderer')) shelves.push(c)
  if (shelves.length > 0) pickedFrom = `musicPlaylistShelfRenderer×${shelves.length}`
  if (shelves.length === 0) {
    for (const c of findAll(data, 'musicPlaylistShelfContinuation')) shelves.push(c)
    if (shelves.length > 0) pickedFrom = `musicPlaylistShelfContinuation×${shelves.length}`
  }
  if (shelves.length === 0) {
    for (const c of findAll(data, 'continuationItems')) shelves.push(c)
    if (shelves.length > 0) pickedFrom = `continuationItems×${shelves.length}`
  }
  if (shelves.length === 0) {
    for (const c of findAll(data, 'musicShelfRenderer')) shelves.push(c)
    if (shelves.length > 0) pickedFrom = `musicShelfRenderer×${shelves.length}`
  }
  // Fallback: if we couldn't identify a shelf, walk the whole subtree.
  // Lossy on count but better than missing the tracks entirely.
  const searchRoot: unknown = shelves.length > 0 ? shelves : data
  console.log(`[parseTrackRowsInto] container=${pickedFrom}`)

  let index = 0
  for (const item of findAll(searchRoot, 'musicResponsiveListItemRenderer')) {
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
    const hasPlayableId = videoId && /^[\w-]{11}$/.test(videoId)

    // playlistSetVideoId is YT's unique row-id within a playlist (a hex
    // string like "31A22D0994588080"). Using it for dedup lets a user
    // who added the same track twice see both rows — YT's library card
    // counts those as 2.  Fall back to "videoId@index" so two dupes that
    // somehow don't carry setVideoId still survive.
    const itemData = item.playlistItemData as Record<string, unknown> | undefined
    const setVideoId = typeof itemData?.playlistSetVideoId === 'string'
      ? itemData.playlistSetVideoId
      : ''

    const trackTitle = flexColText(item, 0)
    // A row with no playable videoId AND no setVideoId is genuine
    // garbage (header/footer/decorative) — skip it. A row with no
    // playable videoId but a setVideoId is an unavailable track that
    // YT still keeps in the playlist for ownership/order purposes.
    // Keep those with an `unavailable: true` marker so the count
    // matches the card and the user can see / remove them.
    if (!hasPlayableId && !setVideoId) continue
    if (!trackTitle) continue

    const dedupKey = setVideoId || `${videoId}@${index}`
    index++
    if (seen.has(dedupKey)) continue
    seen.add(dedupKey)

    const col1 = flexColText(item, 1)
    const artist = col1.split(/\s*[•·]\s*/)[0]
    const duration = fixedColText(item, 0) || flexColText(item, 2)
    const thumb = findFirstThumbnail(item)

    const likeStatus = findLikeStatus(item)
    const liked = likeStatus === 'LIKE' ? true : undefined
    const artistId = findArtistChannelId(item) ?? undefined

    if (hasPlayableId) {
      out.push({
        id: videoId,
        title: trackTitle,
        artist,
        duration,
        thumbnail: thumb,
        setVideoId: setVideoId || undefined,
        liked,
        artistId
      })
    } else {
      // Synthetic id so Svelte's keyed iteration stays unique and the
      // player can hard-detect "this isn't playable" by the prefix.
      out.push({
        id: `__unavail__${setVideoId}`,
        title: trackTitle,
        artist,
        duration,
        thumbnail: thumb,
        unavailable: true,
        setVideoId: setVideoId || undefined,
        liked,
        artistId
      })
    }
  }
}

// Walks any text renderer (`{ runs: [...] }`) looking for the first
// run whose navigationEndpoint points at an artist (browseId starts
// with "UC"). Used to make the artist line in an album header clickable
// into the artist view.
function findArtistRunInText(textObj: unknown): { name: string; id: string } | null {
  if (!textObj || typeof textObj !== 'object') return null
  const runs = (textObj as Record<string, unknown>).runs as
    | Array<Record<string, unknown>>
    | undefined
  if (!Array.isArray(runs)) return null
  for (const r of runs) {
    const nav = r.navigationEndpoint as Record<string, unknown> | undefined
    const browse = nav?.browseEndpoint as Record<string, unknown> | undefined
    const id = browse?.browseId
    if (typeof id === 'string' && id.startsWith('UC')) {
      return { name: typeof r.text === 'string' ? r.text : '', id }
    }
  }
  return null
}

// Pulls the first 4-digit year (19xx / 20xx) out of any text. Album
// subtitles are locale-specific ("Album · 2024 · 12 songs" / "Альбом ·
// 2024 · 12 песен"), so we scan the whole string rather than parse a
// specific segment.
function findYear(text: string): string {
  const m = /\b(19|20)\d{2}\b/.exec(text)
  return m ? m[0] : ''
}

export async function getPlaylistTracks(id: string): Promise<{
  title: string
  subtitle: string
  thumbnail: string
  tracks: SearchResult[]
  // Album-specific extras: present when the browseId resolves to an
  // album (MPRE…) or single/EP. The renderer uses these for header
  // polish — display the year line, make the artist line a clickable
  // link into the artist view, and prefer "Album" over the generic
  // "Playlist" subtitle label.
  isAlbum?: boolean
  year?: string
  artistName?: string
  artistId?: string
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
  // Album-specific extras — populated below when the header carries
  // the relevant runs / strings. The MPRE-prefix browseId is the
  // primary "this is an album" signal; the renderer uses isAlbum to
  // switch the header label.
  let artistName = ''
  let artistId = ''
  for (const h of findAll(data, 'musicDetailHeaderRenderer')) {
    title = runsText(h.title)
    subtitle = runsText(h.subtitle)
    thumbnail = thumbnailUrl(
      ((h.thumbnail as Record<string, unknown>)?.croppedSquareThumbnailRenderer as Record<string, unknown>)
        ?.thumbnail ??
        (h.thumbnail as Record<string, unknown>)?.musicThumbnailRenderer ??
        h.thumbnail
    )
    const artistRun = findArtistRunInText(h.subtitle)
    if (artistRun) {
      artistName = artistRun.name
      artistId = artistRun.id
    }
    if (title) break
  }
  if (!title) {
    for (const h of findAll(data, 'musicResponsiveHeaderRenderer')) {
      title = runsText(h.title)
      subtitle = runsText((h.subtitle as unknown) ?? (h.straplineTextOne as unknown))
      thumbnail = thumbnailUrl(
        (h.thumbnail as Record<string, unknown>)?.musicThumbnailRenderer ?? h.thumbnail
      )
      // straplineTextOne is where the artist link sits on the modern
      // album header shape; subtitle is the fallback (sometimes carries
      // it on older responses).
      const artistRun =
        findArtistRunInText(h.straplineTextOne) ?? findArtistRunInText(h.subtitle)
      if (artistRun) {
        artistName = artistRun.name
        artistId = artistRun.id
      }
      if (title) break
    }
  }
  const isAlbum = id.startsWith('MPRE') || id.startsWith('OLAK')
  const year = isAlbum ? findYear(subtitle) : ''

  const tracks: SearchResult[] = []
  const seenTrackIds = new Set<string>()
  const firstPageBefore = tracks.length
  parseTrackRowsInto(data, seenTrackIds, tracks)
  const firstPageAdded = tracks.length - firstPageBefore
  console.log(
    `[getPlaylistTracks] ${id} page 1: added ${firstPageAdded} (total ${tracks.length})`
  )

  // YT's /browse returns at most ~100 tracks per page; the rest live behind
  // continuation tokens. Follow them until we get a page with no further
  // token. The MAX_PAGES cap is a safety net — most "long" playlists are
  // under 1000 tracks, and 50 pages × 100 = 5000 is a generous ceiling.
  // The token lookup is scoped to the playlist shelf (not the global
  // tree) so a Suggested-tracks pagination chain doesn't get followed
  // instead of the real playlist chain.
  const MAX_PAGES = 50
  let nextToken = findPlaylistContinuationToken(data)
  let page = 0
  while (nextToken && page < MAX_PAGES) {
    page++
    const before = tracks.length
    try {
      const next = await innertubeFetch('/browse', { continuation: nextToken })
      parseTrackRowsInto(next, seenTrackIds, tracks)
      const added = tracks.length - before
      const newToken = findPlaylistContinuationToken(next)
      console.log(
        `[getPlaylistTracks] ${id} page ${page + 1}: added ${added} (total ${tracks.length}) nextToken=${newToken ? 'yes' : 'no'}`
      )
      // Belt-and-suspenders: if a page brings nothing new, bail out.
      // YT shouldn't ever respond with an "empty playlist page that also
      // has a token to a different chunk" — if it does, we'd loop adding
      // zero useful rows forever.
      if (added === 0) break
      nextToken = newToken
    } catch (err) {
      console.warn(`[getPlaylistTracks] continuation page ${page} failed:`, err)
      break
    }
  }
  if (page > 0) {
    console.log(`[getPlaylistTracks] ${id}: fetched ${tracks.length} tracks across ${page + 1} pages`)
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

  // Tracks fetched from Liked Music are liked by definition — the page-
  // proxy's likeStatus walk catches most of them but is occasionally
  // empty for older rows; force the flag so the inline heart renders
  // filled even when the per-row signal didn't survive.
  const rawId = id.startsWith('VL') ? id.slice(2) : id
  if (rawId === 'LM') {
    for (const t of tracks) t.liked = true
  }

  return {
    title,
    subtitle,
    thumbnail,
    tracks,
    isAlbum: isAlbum || undefined,
    year: year || undefined,
    artistName: artistName || undefined,
    artistId: artistId || undefined
  }
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

// ===========================================================================
// LIKE / UNLIKE — POST /like/like + /like/removelike via the page proxy.
// The page-proxy supplies the SAPISIDHASH triple-auth + cookies + visitor
// data for us, so this is a one-liner POST per action. Track shows up in
// the user's Liked Music auto-playlist after a like.
// ===========================================================================

export async function likeTrack(videoId: string, like: boolean): Promise<boolean> {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return false
  try {
    await innertubeFetch(like ? '/like/like' : '/like/removelike', {
      target: { videoId }
    })
    return true
  } catch (err) {
    console.warn(`[like] ${like ? 'like' : 'removelike'} failed for ${videoId}:`, err)
    return false
  }
}

// ===========================================================================
// RADIO — yt.music.getUpNext(videoId) returns YT's "Up next" radio for a
// track. We parse it into SearchResult[] so the renderer can drop the
// items straight into the player's sourceList or the user queue.
// ===========================================================================

export async function getRadioForTrack(videoId: string): Promise<SearchResult[]> {
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) return []
  const yt = await getInnertube()
  try {
    const raw = (await yt.music.getUpNext(videoId)) as unknown
    const obj = raw as Record<string, unknown>
    // Walk the response defensively — youtubei.js exposes UpNext under
    // a few different shapes across versions. `items` is the common one;
    // `contents` is the raw renderer shape.
    const rawItems: unknown[] = Array.isArray(obj.items)
      ? (obj.items as unknown[])
      : Array.isArray(obj.contents)
        ? (obj.contents as unknown[])
        : []
    const out: SearchResult[] = []
    const seen = new Set<string>()
    for (const it of rawItems) {
      if (!it || typeof it !== 'object') continue
      const item = it as Record<string, unknown>
      const id =
        typeof item.id === 'string'
          ? item.id
          : typeof item.video_id === 'string'
            ? item.video_id
            : ''
      if (!id || !/^[\w-]{11}$/.test(id)) continue
      if (seen.has(id)) continue
      seen.add(id)
      const title = asText(item.title) || asText(item.name)
      if (!title) continue
      const duration =
        item.duration && typeof item.duration === 'object'
          ? fmtDuration((item.duration as Record<string, unknown>).seconds)
          : ''
      out.push({
        id,
        title,
        artist: pickArtist(item),
        duration,
        thumbnail: pickThumbnail(item)
      })
    }
    // Strip the seed track if YT included it (it sometimes does — we
    // play the seed ourselves and don't want a duplicate at the top).
    return out.filter((t) => t.id !== videoId)
  } catch (err) {
    console.warn(`[radio] getUpNext failed for ${videoId}:`, err)
    return []
  }
}

// ===========================================================================
// ARTIST VIEW — /browse on a channelId returns a stack of shelves:
//   musicImmersiveHeaderRenderer (header, photo, subscriber count)
//   musicShelfRenderer            (Top songs — 5 tracks usually)
//   musicCarouselShelfRenderer    (Albums)
//   musicCarouselShelfRenderer    (Singles, optional)
//   musicCarouselShelfRenderer    (Featured on, optional)
//   musicCarouselShelfRenderer    (Fans might also like — related artists)
//   musicDescriptionShelfRenderer (About — bio + monthly listeners — skipped)
// We expose the header, the top-songs as SearchResult[], and every
// carousel as a HomeSection so the renderer can re-use its grid/tile.
// ===========================================================================

export interface ArtistView {
  title: string
  // Free text under the artist name — usually "<N> subscribers" in the
  // user's locale. Best-effort: YT's response shape varies, so this is
  // empty when we couldn't extract anything sensible.
  subtitle: string
  thumbnail: string
  // Up to ~5 tracks from the artist's Top Songs shelf. Same shape as
  // playlist tracks (carries setVideoId where YT supplies it, plus
  // likeStatus + artistId), so they play through the existing player
  // path and the inline heart / radio / queue actions all work.
  songs: SearchResult[]
  // Albums / Singles / Featured on / related-artist carousels — each
  // an `HomeSection`, items are `HomeItem` cards. The renderer treats
  // playlist/album items as "click to open the playlist view" and
  // artist items as "click to navigate to that artist".
  sections: HomeSection[]
}

export async function getArtistView(channelId: string): Promise<ArtistView> {
  if (!channelId || !channelId.startsWith('UC')) {
    throw new Error(`invalid channelId: ${channelId}`)
  }
  const data = await innertubeFetch('/browse', { browseId: channelId })

  // Header parsing — try the immersive (big banner) shape first, then
  // the visual one as fallback. Older responses may use a third shape
  // (musicHeaderRenderer); we walk for runs deep enough to catch it.
  let title = ''
  let subtitle = ''
  let thumbnail = ''
  for (const h of findAll(data, 'musicImmersiveHeaderRenderer')) {
    title = runsText(h.title) || title
    thumbnail = findFirstThumbnail(h.thumbnail) || thumbnail
    if (title) break
  }
  if (!title) {
    for (const h of findAll(data, 'musicVisualHeaderRenderer')) {
      title = runsText(h.title) || title
      thumbnail =
        findFirstThumbnail(h.foregroundThumbnail) ||
        findFirstThumbnail(h.thumbnail) ||
        thumbnail
      if (title) break
    }
  }
  // Subscriber count lives in different places depending on the header
  // shape. Walk for any subscriberCountText anywhere in the response
  // and take the first non-empty one.
  for (const node of findAll(data, 'subscriberCountText')) {
    const t = runsText(node)
    if (t) {
      subtitle = t
      break
    }
  }
  if (!subtitle) {
    // Some immersive headers stash the count inside the subscribe button.
    for (const node of findAll(data, 'subscribeButtonRenderer')) {
      const t =
        runsText(node.subscriberCountText) ||
        runsText(node.longSubscriberCountText)
      if (t) {
        subtitle = t
        break
      }
    }
  }

  // Top songs: the first musicShelfRenderer in the response that
  // actually contains musicResponsiveListItemRenderer rows. Later
  // shelves on an artist page are carousels (musicCarouselShelfRenderer),
  // not list shelves, so this catches the right one.
  const songs: SearchResult[] = []
  const seen = new Set<string>()
  for (const shelf of findAll(data, 'musicShelfRenderer')) {
    let hasTracks = false
    for (const _ of findAll(shelf, 'musicResponsiveListItemRenderer')) {
      hasTracks = true
      break
    }
    if (hasTracks) {
      parseTrackRowsInto(shelf, seen, songs)
      if (songs.length > 0) break
    }
  }

  // Carousels: every musicCarouselShelfRenderer with a header title +
  // musicTwoRowItemRenderer children. Header title is locale-specific
  // ("Albums" / "Альбомы" / "Singles" / "Синглы" / etc.) — we just
  // pass it through so the renderer shows whatever YT shows.
  const sections: HomeSection[] = []
  for (const shelf of findAll(data, 'musicCarouselShelfRenderer')) {
    const header = shelf.header as Record<string, unknown> | undefined
    const headerRenderer = header?.musicCarouselShelfBasicHeaderRenderer as
      | Record<string, unknown>
      | undefined
    const shelfTitle = runsText(headerRenderer?.title)
    const contents = shelf.contents as unknown[] | undefined
    if (!Array.isArray(contents) || !shelfTitle) continue
    const items: HomeItem[] = []
    for (const c of contents) {
      if (!c || typeof c !== 'object') continue
      const renderer = (c as Record<string, unknown>).musicTwoRowItemRenderer as
        | Record<string, unknown>
        | undefined
      if (!renderer) continue
      const parsed = parseTwoRowItem(renderer)
      if (parsed) items.push(parsed)
    }
    if (items.length > 0) sections.push({ title: shelfTitle, items })
  }

  return { title, subtitle, thumbnail, songs, sections }
}
