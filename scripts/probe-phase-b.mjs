// Phase B verification — does feeding visitor_data into Innertube.create()
// finally make the server treat us as logged in? Probes three things:
//
//   1. raw /browse FEmusic_library_landing — does logged_in flip to 1?
//   2. getLibrary() — does the parser still die on a Sign-in messageRenderer,
//      or do we now get real Grid/MusicShelf data?
//   3. getInfo on a music track — does streaming_data come back with URLs?
//      (If yes, the fast extraction path is back.)
//
// visitor_data is harvested by hand the same way the app does it: load
// music.youtube.com in a Node-side puppeteer would be the "real" way, but
// for the probe we just paste in whatever the app most recently harvested
// (we read it from the main process's log file).
import { Innertube } from 'youtubei.js'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function readCookieHeader() {
  const path = join(process.env.APPDATA ?? '', 'ecoda', 'youtube-cookies.txt')
  if (!existsSync(path)) return ''
  const cookies = []
  for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
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
    if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) continue
    cookies.push(`${name}=${value}`)
  }
  return cookies.join('; ')
}

// Pass visitor_data via argv so we can use the live one from the app's log
const visitorData = process.argv[2]
if (!visitorData) {
  console.error('Usage: node scripts/probe-phase-b.mjs <visitor_data>')
  process.exit(1)
}

const cookie = readCookieHeader()
console.log(`cookie: ${cookie.length} chars`)
console.log(`visitor_data: ${visitorData.slice(0, 30)}… (${visitorData.length} chars)`)

const yt = await Innertube.create({ cookie, visitor_data: visitorData })

// 1) raw /browse FEmusic_library_landing
console.log('\n=== 1) raw /browse FEmusic_library_landing ===')
const lib = await yt.actions.execute('/browse', {
  browseId: 'FEmusic_library_landing',
  client: 'YTMUSIC'
})
const flat = {}
for (const grp of lib.data?.responseContext?.serviceTrackingParams ?? []) {
  for (const p of grp.params ?? []) flat[`${grp.service}.${p.key}`] = p.value
}
console.log('  logged_in :', flat['GFEEDBACK.logged_in'])
console.log('  yt_li     :', flat['CSI.yt_li'])
const tabs = lib.data?.contents?.singleColumnBrowseResultsRenderer?.tabs ?? []
console.log('  tabs      :', tabs.length, tabs.map((t) => t.tabRenderer?.title ?? '(no title)').join(', '))
writeFileSync('probe-phase-b-library.json', JSON.stringify(lib.data, null, 2))

// 2) getLibrary() via youtubei.js
console.log('\n=== 2) yt.music.getLibrary() ===')
try {
  const r = await yt.music.getLibrary()
  console.log('  OK, top keys:', Object.keys(r))
  console.log('  shelves    :', r?.shelves?.length ?? r?.contents?.length)
} catch (e) {
  console.log('  THREW:', e.message?.split('\n')[0])
}

// 3) getInfo on a music track for streaming_data
console.log('\n=== 3) getInfo on a music track (Blinding Lights) ===')
try {
  const info = await yt.getInfo('J7p4bzqLvCw')
  const audio = (info?.streaming_data?.adaptive_formats ?? []).filter(
    (f) => f.has_audio && !f.has_video
  )
  console.log('  audio formats:', audio.length)
  if (audio[0]) {
    const f = audio[0]
    console.log('  itag        :', f.itag, 'bitrate:', f.bitrate)
    console.log('  has .url    :', typeof f.url, f.url ? `len=${f.url.length}` : '')
    console.log('  has .signature_cipher:', typeof f.signature_cipher)
    try {
      const fmt = info.chooseFormat({ type: 'audio', quality: 'best' })
      const url = await fmt.decipher(yt.session.player)
      console.log('  end-to-end  :', url ? `OK len=${url.length}` : 'empty')
    } catch (e) {
      console.log('  end-to-end  : THREW', e.message?.split('\n')[0])
    }
  }
} catch (e) {
  console.log('  getInfo THREW:', e.message?.split('\n')[0])
}
