// Focused check: does the YTMUSIC client (a.k.a. WEB_REMIX) return real
// stream URLs for YouTube Music tracks when called with the user's
// Premium cookies? This is the lever I missed in earlier probes.
//
// Per the yt-dlp PO-Token wiki (March 2026): "GVS PO Token is not required
// for YouTube Premium subscribers." SimpMusic confirms WEB_REMIX + Premium
// cookies is the working combo on Android. Here we verify on Node.
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
  console.error('NO COOKIES on disk — connect a browser in eCoda first.')
  process.exit(1)
}
console.log(`cookies: ${cookie.length} chars, ${cookie.split(';').length} pairs`)

const yt = await Innertube.create({ cookie })

// Pull a few real music track IDs via the same path the app uses
const queries = ['blinding lights weeknd', 'bohemian rhapsody queen', 'shape of you sheeran']
const tracks = []
for (const q of queries) {
  try {
    const r = await yt.music.search(q, { type: 'song' })
    const items = r?.songs?.contents ?? []
    for (const it of items.slice(0, 1)) {
      const id = it?.id ?? it?.video_id
      if (id && /^[\w-]{11}$/.test(id)) {
        tracks.push({ q, id, title: String(it?.title?.text ?? it?.title ?? '').slice(0, 50) })
      }
    }
  } catch {
    // ignore
  }
}

const CLIENTS_TO_TRY = ['YTMUSIC', 'WEB', 'IOS', 'TV_EMBEDDED']
const results = []

for (const track of tracks) {
  for (const client of CLIENTS_TO_TRY) {
    const t0 = performance.now()
    let info
    try {
      info = await yt.getInfo(track.id, client)
    } catch (e) {
      results.push({ ...track, client, err: 'getInfo: ' + e.message })
      continue
    }
    const tInfo = performance.now()
    const sd = info?.streaming_data
    const audioFmts = (sd?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video)
    const withUrl = audioFmts.filter((f) => typeof f.url === 'string' && f.url.length > 0)
    const withCipher = audioFmts.filter(
      (f) => typeof f.signature_cipher === 'string' || typeof f.cipher === 'string'
    )

    let decipherResult = null
    let bestBitrate = null
    let qualityLabel = null
    if (audioFmts.length > 0) {
      try {
        const fmt = info.chooseFormat({ type: 'audio', quality: 'best' })
        if (fmt) {
          bestBitrate = fmt.bitrate
          qualityLabel = fmt.audio_quality
          const url = await fmt.decipher(yt.session.player)
          decipherResult = url ? `OK len=${url.length}` : 'empty'
        }
      } catch (e) {
        decipherResult = 'THREW: ' + e.message
      }
    }
    const tDone = performance.now()

    results.push({
      ...track,
      client,
      nAudio: audioFmts.length,
      withUrl: withUrl.length,
      withCipher: withCipher.length,
      bestBitrate,
      qualityLabel,
      decipherResult,
      msInfo: +(tInfo - t0).toFixed(0),
      msTotal: +(tDone - t0).toFixed(0)
    })
  }
}

writeFileSync('probe-ytmusic.json', JSON.stringify(results, null, 2))
console.log('\nResults:')
for (const r of results) {
  if (r.err) {
    console.log(`  ${r.client.padEnd(13)} ${r.id} "${r.title}"  ERR ${r.err}`)
    continue
  }
  const verdict =
    r.decipherResult && r.decipherResult.startsWith('OK')
      ? `✓ PLAYABLE bps=${r.bestBitrate} q=${r.qualityLabel} (info=${r.msInfo}ms total=${r.msTotal}ms)`
      : `✗ ${r.decipherResult ?? 'no-format'}  audio=${r.nAudio} url=${r.withUrl} cipher=${r.withCipher}`
  console.log(`  ${r.client.padEnd(13)} ${r.id} "${r.title}"  ${verdict}`)
}
