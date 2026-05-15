// Bypasses the broken yt.music.getLibrary() parser by hitting InnerTube
// directly via yt.actions.execute('/browse', {browseId: ...}). Dumps the
// raw response so we can write our own parser for the library landing
// page and its tabs (Playlists / Songs / Albums / Artists / Subscriptions).
import { Innertube } from 'youtubei.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function readCookieHeader() {
  const path = join(process.env.APPDATA ?? '', 'ecoda', 'youtube-cookies.txt')
  if (!existsSync(path)) return ''
  const cookies = []
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [domain, , , , , name, value] = parts
    if (!domain.includes('youtube.com') && !domain.includes('google.com')) continue
    if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) continue
    cookies.push(`${name}=${value}`)
  }
  return cookies.join('; ')
}

const yt = await Innertube.create({ cookie: readCookieHeader() })

// browseId values to try. These come from the YT Music web client.
// "FEmusic_library_landing" is the main library page; the others are
// individual tabs you'd normally reach by clicking a chip on that page.
const candidates = [
  'FEmusic_library_landing',
  'FEmusic_liked_playlists',
  'FEmusic_library_corpus_track_artists',
  'FEmusic_history',
  'FEmusic_listening_review'
]

const out = {}
for (const browseId of candidates) {
  try {
    const t0 = Date.now()
    const r = await yt.actions.execute('/browse', { browseId, client: 'YTMUSIC' })
    const data = r.data
    const ms = Date.now() - t0
    out[browseId] = {
      ms,
      topKeys: Object.keys(data ?? {}),
      contentsShape: describeContents(data?.contents)
    }
    console.log(`OK ${browseId} (${ms}ms) — top keys: ${Object.keys(data).join(', ')}`)
  } catch (e) {
    out[browseId] = { err: e.message?.split('\n')[0] }
    console.log(`FAIL ${browseId} — ${e.message?.split('\n')[0]}`)
  }
}

// Dump the full landing response, that's the most useful one to study
try {
  const landing = await yt.actions.execute('/browse', {
    browseId: 'FEmusic_library_landing',
    client: 'YTMUSIC'
  })
  writeFileSync('inspect-library-landing.json', JSON.stringify(landing.data, null, 2))
  console.log('\nwrote inspect-library-landing.json')
} catch (e) {
  console.log('landing dump failed:', e.message)
}

writeFileSync('inspect-library-raw-summary.json', JSON.stringify(out, null, 2))

function describeContents(c) {
  if (!c) return null
  // Most YouTube responses wrap their actual content under one of a few
  // standard renderers. We give a flat overview.
  const top = c.singleColumnBrowseResultsRenderer ?? c.twoColumnBrowseResultsRenderer ?? c
  const tabs = top?.tabs ?? []
  return {
    tabsCount: tabs.length,
    tabTitles: tabs
      .map((t) => t.tabRenderer?.title ?? '(no title)')
      .filter(Boolean)
      .slice(0, 10)
  }
}
