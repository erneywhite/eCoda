// Direct InnerTube call with manually built headers, bypassing youtubei.js
// entirely. If THIS lights up logged_in=1, the recipe is correct and the
// remaining work is "find a way to make youtubei.js use it". If THIS also
// fails, we're missing something (visitor data, signed-token, etc.) and
// have to dig deeper.
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

function extractCookie(c, n) {
  const m = c.match(new RegExp(`(?:^|; )${n}=([^;]+)`))
  return m?.[1] ?? null
}

const cookieHeader = readCookieHeader()
const origin = 'https://music.youtube.com'

// YouTube checks both __Secure-3PAPISID (the modern one) and SAPISID.
// Try the modern one first.
const sapisid =
  extractCookie(cookieHeader, '__Secure-3PAPISID') ?? extractCookie(cookieHeader, 'SAPISID')

if (!sapisid) {
  console.error('No SAPISID cookie. Stop.')
  process.exit(1)
}

const ts = Math.floor(Date.now() / 1000)
const authHash = createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex')

// Build all three of the auth-header variants Google accepts at once —
// belt-and-suspenders, lets us see which one (if any) the server picks up.
const authHeaderModern = `SAPISIDHASH ${ts}_${authHash}`
// Some endpoints want the SAPISID1PHASH variant for first-party (1P) sessions.
const authHash1P = createHash('sha1').update(`${ts} ${sapisid} ${origin}`).digest('hex')
const authHeaders1P = {
  Authorization: `SAPISIDHASH ${ts}_${authHash} SAPISID1PHASH ${ts}_${authHash1P} SAPISID3PHASH ${ts}_${authHash}`
}

const body = {
  context: {
    client: {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20260304.03.00',
      hl: 'en',
      gl: 'US'
    },
    user: {
      lockedSafetyMode: false
    },
    request: {
      useSsl: true
    }
  },
  browseId: 'FEmusic_library_landing'
}

const headers = {
  'Content-Type': 'application/json',
  'X-Origin': origin,
  'X-Goog-AuthUser': '0',
  Origin: origin,
  Referer: origin + '/',
  Cookie: cookieHeader,
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ...authHeaders1P
}

console.log('POST', `${origin}/youtubei/v1/browse?prettyPrint=false`)
console.log('Authorization header preview:', authHeaders1P.Authorization.slice(0, 100), '…')
console.log()

const res = await fetch(`${origin}/youtubei/v1/browse?prettyPrint=false`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body)
})

console.log('HTTP', res.status, res.statusText)
const data = await res.json()
const flat = {}
for (const grp of data?.responseContext?.serviceTrackingParams ?? []) {
  for (const p of grp.params ?? []) flat[`${grp.service}.${p.key}`] = p.value
}
console.log('  logged_in :', flat['GFEEDBACK.logged_in'])
console.log('  yt_li     :', flat['CSI.yt_li'])
console.log('  client    :', flat['ECATCHER.client.name'])

const tabs = data?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? []
console.log('  tabs      :', tabs.length)
for (const t of tabs) {
  console.log('    - ', t.tabRenderer?.title ?? '(no title)')
}

writeFileSync('inspect-library-direct.json', JSON.stringify(data, null, 2))
console.log('wrote inspect-library-direct.json')
