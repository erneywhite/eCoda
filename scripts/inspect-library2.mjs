// Round 2: getLibrary failed on a parser bug. Try direct entry points:
//   - yt.music.getPlaylist('LM')  — "Liked Music" pseudo-playlist
//   - yt.music.getPlaylist('SE')  — "Episodes for later" (podcasts)
//   - yt.music.getHomeFeed()      — sections we can use as a landing page
//   - yt.music.getLibrary(...)    — with various args, in case it works
//                                    when restricted to one section
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

async function tryCall(name, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    console.log(`\n--- ${name} (${Date.now() - t0}ms) ---  OK`)
    return r
  } catch (e) {
    console.log(`\n--- ${name} ---  FAIL: ${e.message?.split('\n')[0]}`)
    return null
  }
}

// Liked Music — well-known playlist id, every signed-in user has it
const lm = await tryCall('getPlaylist("LM")', () => yt.music.getPlaylist('LM'))
if (lm) {
  console.log('  header type :', lm.header?.constructor?.name)
  console.log('  header title:', String(lm.header?.title?.text ?? lm.header?.title ?? '').slice(0, 60))
  console.log('  items       :', lm.items?.length ?? lm.contents?.length ?? '?')
  // Dump first item to understand the shape
  const first = lm.items?.[0] ?? lm.contents?.[0]
  if (first) {
    console.log('  first item  :', first.constructor?.name)
    console.log('  first keys  :', Object.getOwnPropertyNames(first).slice(0, 20))
    console.log('  first title :', String(first.title?.text ?? first.title ?? '').slice(0, 60))
    console.log('  first id    :', first.id ?? first.video_id ?? first.videoId)
  }
  writeFileSync('inspect-library-lm.json', JSON.stringify(lm, replacer, 2))
  console.log('  wrote inspect-library-lm.json')
}

// Try getLibrary with various optional args (the lib might accept a type)
await tryCall('getLibrary({ tab: "playlists" })', () => yt.music.getLibrary({ tab: 'playlists' }))
await tryCall('getLibrary("playlists")', () => yt.music.getLibrary('playlists'))

// HomeFeed with details
const home = await tryCall('getHomeFeed()', () => yt.music.getHomeFeed())
if (home) {
  console.log('  sections:', home.sections?.length)
  home.sections?.slice(0, 5).forEach((s, i) => {
    const t = s?.header?.title?.text ?? s?.header?.title ?? '(no title)'
    console.log(`    [${i}] ${s.constructor?.name}: ${String(t).slice(0, 40)} (${s.contents?.length ?? 0} items)`)
  })
}

function replacer(key, value) {
  if (typeof value === 'function') return '[fn]'
  if (value instanceof Map) return Object.fromEntries(value)
  if (typeof value === 'string' && value.length > 200) return value.slice(0, 200) + '…'
  return value
}
