// Checks whether real YouTube Music tracks (vs a plain YouTube clip)
// behave differently — i.e. do their formats come back with a real .url
// or .signature_cipher we can actually decipher. Uses the app's cookies.
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

// Pull a few real music track IDs straight from the user's library via
// the same auth path the app uses, so we test the exact category of
// content that's actually being played.
const cookie = readCookieHeader()
const yt = await Innertube.create(cookie ? { cookie } : {})

// Sample queries that should land on Topic-channel music tracks
const queries = ['blinding lights', 'bohemian rhapsody', 'shape of you']
const sampleIds = []
for (const q of queries) {
  try {
    const r = await yt.music.search(q, { type: 'song' })
    const items = r?.songs?.contents ?? []
    for (const it of items.slice(0, 2)) {
      const id = it?.id ?? it?.video_id
      if (id && /^[\w-]{11}$/.test(id)) sampleIds.push({ q, id, title: String(it?.title ?? '').slice(0, 50) })
    }
  } catch (e) {
    // ignore
  }
}

const results = []
for (const { q, id, title } of sampleIds) {
  let info
  try {
    info = await yt.getInfo(id)
  } catch (e) {
    results.push({ q, id, title, err: 'getInfo: ' + e.message })
    continue
  }
  const audioFmts = (info?.streaming_data?.adaptive_formats ?? []).filter(
    (f) => f.has_audio && !f.has_video
  )
  const first = audioFmts[0]
  const anyHasUrl = audioFmts.some((f) => typeof f.url === 'string' && f.url.length > 0)
  const anyHasCipher = audioFmts.some(
    (f) => typeof f.signature_cipher === 'string' || typeof f.cipher === 'string'
  )
  // Try chooseFormat + decipher end-to-end
  let endToEnd = null
  try {
    const f = info.chooseFormat({ type: 'audio', quality: 'best' })
    if (f) {
      const url = await f.decipher(yt.session.player)
      endToEnd = url ? 'OK len=' + url.length : 'empty url'
    } else {
      endToEnd = 'no format'
    }
  } catch (e) {
    endToEnd = 'THREW: ' + e.message
  }
  results.push({
    q,
    id,
    title,
    nAudio: audioFmts.length,
    firstItag: first?.itag,
    firstBitrate: first?.bitrate,
    anyHasUrl,
    anyHasCipher,
    poToken: yt.session.player?.po_token ?? null,
    endToEnd
  })
}

writeFileSync('probe-music.json', JSON.stringify(results, null, 2))
console.log('wrote probe-music.json (' + results.length + ' tracks)')
for (const r of results) {
  console.log(
    `${r.id}  "${r.title}"  audio=${r.nAudio} anyUrl=${r.anyHasUrl} anyCipher=${r.anyHasCipher}  =>  ${r.endToEnd}`
  )
}
