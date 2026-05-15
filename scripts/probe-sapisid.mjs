// Critical experiment: does adding the SAPISIDHASH Authorization header
// (which Google requires for authenticated InnerTube calls and which
// youtubei.js doesn't synthesise on its own) make the server treat us
// as logged in?
//
// If yes:
//   - library endpoints will return our real data, not "Sign in" prompts
//   - streaming_data for music might also start coming back with URLs,
//     unlocking the youtubei.js fast path we previously had to drop
//
// SAPISIDHASH recipe (well-documented in many YouTube reversing posts):
//   timestamp = Math.floor(Date.now() / 1000)
//   origin    = "https://music.youtube.com"
//   sapisid   = the SAPISID (or __Secure-3PAPISID) cookie value
//   hash      = sha1(`${timestamp} ${sapisid} ${origin}`)
//   header    = `SAPISIDHASH ${timestamp}_${hash}`
import { Innertube } from 'youtubei.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

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

function extractCookie(cookieHeader, name) {
  const m = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]+)`))
  return m?.[1] ?? null
}

function makeSapisidHash(sapisid, origin) {
  const ts = Math.floor(Date.now() / 1000)
  const hash = createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex')
  return `SAPISIDHASH ${ts}_${hash}`
}

const cookieHeader = readCookieHeader()
const origin = 'https://music.youtube.com'
const sapisid =
  extractCookie(cookieHeader, '__Secure-3PAPISID') ?? extractCookie(cookieHeader, 'SAPISID')

if (!sapisid) {
  console.error('No SAPISID / __Secure-3PAPISID in cookies. Auth header impossible.')
  process.exit(1)
}
console.log(`SAPISID: ${sapisid.slice(0, 6)}…(len ${sapisid.length})`)

// Custom fetch — injects Authorization SAPISIDHASH + X-Origin on every
// youtubei.js-issued request. We rebuild the timestamp each call so it
// stays within the ~10-minute validity window Google enforces.
function authedFetch(input, init = {}) {
  const headers = new Headers(init.headers)
  const auth = makeSapisidHash(sapisid, origin)
  headers.set('Authorization', auth)
  headers.set('X-Origin', origin)
  headers.set('X-Goog-AuthUser', '0')
  return fetch(input, { ...init, headers })
}

const yt = await Innertube.create({ cookie: cookieHeader, fetch: authedFetch })

// 1. Library landing — was "Sign in" before. If auth works, this should
//    now have real tabs and content.
console.log('\n=== /browse FEmusic_library_landing (with SAPISIDHASH) ===')
const lib = await yt.actions.execute('/browse', {
  browseId: 'FEmusic_library_landing',
  client: 'YTMUSIC'
})
const trackingParams = lib.data?.responseContext?.serviceTrackingParams ?? []
const flat = {}
for (const grp of trackingParams) {
  for (const p of grp.params ?? []) flat[`${grp.service}.${p.key}`] = p.value
}
console.log('  logged_in     :', flat['GFEEDBACK.logged_in'])
console.log('  yt_li         :', flat['CSI.yt_li'])
console.log('  client.name   :', flat['ECATCHER.client.name'])

const tabs = lib.data?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? []
console.log('  tabs          :', tabs.length)
for (const t of tabs) {
  console.log('    - ', t.tabRenderer?.title ?? '(no title)')
}
// Look for the actual content shape (Grid? MusicShelf? messageRenderer?)
const firstTabContent = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents
const firstItemShape = firstTabContent?.[0] ? Object.keys(firstTabContent[0])[0] : null
console.log('  first section :', firstItemShape ?? '(none)')

writeFileSync('inspect-library-authed.json', JSON.stringify(lib.data, null, 2))
console.log('  wrote inspect-library-authed.json')

// 2. The big one — does streaming_data for music tracks come back filled in?
console.log('\n=== getInfo on Blinding Lights (with SAPISIDHASH) ===')
try {
  const info = await yt.getInfo('J7p4bzqLvCw', 'YTMUSIC')
  const sd = info?.streaming_data
  const audio = (sd?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video)
  console.log('  hasSD              :', !!sd)
  console.log('  audio formats      :', audio.length)
  const first = audio[0]
  if (first) {
    console.log('  first.bitrate      :', first.bitrate)
    console.log('  first.audio_quality:', first.audio_quality)
    console.log('  has .url           :', typeof first.url, first.url ? `len=${first.url.length}` : '')
    console.log('  has .signature_cipher :', typeof first.signature_cipher)
  }
  // Try chooseFormat + decipher end-to-end
  try {
    const fmt = info.chooseFormat({ type: 'audio', quality: 'best' })
    const url = await fmt.decipher(yt.session.player)
    console.log('  end-to-end          :', url ? `OK len=${url.length}` : 'empty url')
  } catch (e) {
    console.log('  end-to-end          : THREW', e.message?.split('\n')[0])
  }
} catch (e) {
  console.log('  getInfo THREW:', e.message?.split('\n')[0])
}
