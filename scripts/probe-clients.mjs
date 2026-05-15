// Diagnostic — probes which youtubei.js InnerTube client actually returns
// streaming_data for a given video, with and without cookies. Helps when
// YouTube tightens what a given client is allowed to fetch.
//
// Usage: node scripts/probe-clients.mjs [videoId]
import { Innertube } from 'youtubei.js'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const VIDEO_ID = process.argv[2] || 'dQw4w9WgXcQ'
const CLIENTS = [
  'WEB',
  'IOS',
  'ANDROID',
  'TV',
  'TV_EMBEDDED',
  'WEB_EMBEDDED',
  'MWEB',
  'YTMUSIC_ANDROID'
]

function readCookieHeader() {
  const path = join(process.env.APPDATA ?? '', 'ecoda', 'youtube-cookies.txt')
  if (!existsSync(path)) return ''
  const cookies = []
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [domain, , , , , name, value] = parts
    if (!domain.includes('youtube.com') && !domain.includes('google.com')) continue
    if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) continue
    cookies.push(`${name}=${value}`)
  }
  return cookies.join('; ')
}

async function probe(client, withCookies) {
  const cookie = withCookies ? readCookieHeader() : ''
  if (withCookies && !cookie) return { skip: 'no cookies on disk' }

  const t0 = performance.now()
  let yt
  try {
    yt = await Innertube.create(cookie ? { cookie } : {})
  } catch (e) {
    return { err: 'create: ' + e.message }
  }
  const tInit = performance.now()

  let info
  try {
    info = await yt.getInfo(VIDEO_ID, client)
  } catch (e) {
    return { err: 'getInfo: ' + e.message, tInit: tInit - t0 }
  }
  const tInfo = performance.now()

  const sd = info?.streaming_data
  const audioFmts = (sd?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video)

  let format = null
  let chooseErr = null
  try {
    format = info.chooseFormat({ type: 'audio', quality: 'best' })
  } catch (e) {
    chooseErr = e.message
  }
  const tChoose = performance.now()

  let urlPreview = null
  let decErr = null
  if (format) {
    try {
      const url = await format.decipher(yt.session.player)
      urlPreview = url ? `len=${url.length}` : 'empty'
    } catch (e) {
      decErr = e.message
    }
  }
  const tDecipher = performance.now()

  return {
    tInit: tInit - t0,
    tInfo: tInfo - tInit,
    tChoose: tChoose - tInfo,
    tDecipher: tDecipher - tChoose,
    hasSD: !!sd,
    nAudio: audioFmts.length,
    bestBitrate: format?.bitrate ?? null,
    chooseErr,
    decErr,
    urlPreview
  }
}

console.log(`probing video=${VIDEO_ID}\n`)

for (const client of CLIENTS) {
  for (const withCookies of [false, true]) {
    const label = `${client.padEnd(18)} ${withCookies ? 'with cookies' : 'no cookies  '}`
    const r = await probe(client, withCookies)
    if (r.skip) {
      console.log(`${label}  SKIP (${r.skip})`)
      continue
    }
    if (r.err) {
      console.log(`${label}  FAIL ${r.err}`)
      continue
    }
    const t = `init=${r.tInit.toFixed(0)} info=${r.tInfo.toFixed(0)} choose=${r.tChoose.toFixed(0)} decipher=${r.tDecipher.toFixed(0)}`
    const ok = r.urlPreview && !r.decErr ? 'OK' : 'NO_URL'
    const detail = r.chooseErr
      ? `chooseFormat: ${r.chooseErr}`
      : r.decErr
        ? `decipher: ${r.decErr}`
        : r.urlPreview
    console.log(
      `${label}  ${ok}  hasSD=${r.hasSD} audio=${r.nAudio} ${r.bestBitrate ? `bps=${r.bestBitrate}` : ''}  ${t}  ${detail}`
    )
  }
}
