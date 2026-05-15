// Diagnostic — probes youtubei.js's YouTube Music library API.
// Goal: understand which methods exist (getLibrary / getLibraryPlaylists /
// getLikedSongs / etc.) and what shape they return, so we can wire it
// into the app without guessing.
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

const cookie = readCookieHeader()
if (!cookie) {
  console.error('NO COOKIES — connect a browser in eCoda first.')
  process.exit(1)
}

const yt = await Innertube.create({ cookie })

console.log('=== yt.music methods ===')
const musicProto = Object.getOwnPropertyNames(Object.getPrototypeOf(yt.music))
console.log(musicProto.filter((n) => !n.startsWith('_') && n !== 'constructor'))

// Try a handful of likely candidates. Wrap each in try/catch so one
// missing method doesn't kill the whole probe.
async function tryCall(name, fn) {
  const t0 = Date.now()
  try {
    const r = await fn()
    const ms = Date.now() - t0
    const shape = describe(r)
    console.log(`\n--- ${name} (${ms}ms) ---`)
    console.log(shape)
    return r
  } catch (e) {
    console.log(`\n--- ${name} ---  FAIL: ${e.message?.split('\n')[0]}`)
    return null
  }
}

function describe(x, depth = 0) {
  if (x === null || x === undefined) return String(x)
  if (typeof x !== 'object') return `${typeof x}: ${String(x).slice(0, 80)}`
  if (Array.isArray(x)) return `[Array(${x.length})] ${x[0] ? `first=${describe(x[0], depth + 1)}` : ''}`
  if (depth > 2) return '{…}'
  const keys = Object.keys(x).slice(0, 10)
  return `{ ${keys.map((k) => `${k}: ${describe(x[k], depth + 1)}`).join(', ')} }`
}

const lib = await tryCall('yt.music.getLibrary()', () => yt.music.getLibrary())
const libPl = await tryCall('yt.music.getLibraryPlaylists()', () => yt.music.getLibraryPlaylists?.())
const libSongs = await tryCall('yt.music.getLibrarySongs()', () => yt.music.getLibrarySongs?.())
const libArtists = await tryCall('yt.music.getLibraryArtists()', () => yt.music.getLibraryArtists?.())
const libAlbums = await tryCall('yt.music.getLibraryAlbums()', () => yt.music.getLibraryAlbums?.())
const home = await tryCall('yt.music.getHomeFeed()', () => yt.music.getHomeFeed?.())

// Dump first library response with deeper inspection
if (lib) {
  writeFileSync('inspect-library.json', JSON.stringify(lib, replacer, 2))
  console.log('\nwrote inspect-library.json')
}

function replacer(key, value) {
  if (typeof value === 'function') return `[fn]`
  if (value instanceof Map) return Object.fromEntries(value)
  if (typeof value === 'string' && value.length > 200) return value.slice(0, 200) + '…'
  return value
}
