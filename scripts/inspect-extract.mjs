// Diagnostic — probes youtubei.js's video-info / stream-extraction API so
// we know which methods and fields to use.
// Usage: node scripts/inspect-extract.mjs [videoId]
import { Innertube } from 'youtubei.js'

const videoId = process.argv[2] || 'dQw4w9WgXcQ'
const yt = await Innertube.create()
const info = await yt.getInfo(videoId)

console.log('=== info ===')
console.log('constructor:', info?.constructor?.name)
console.log('own props :', Object.getOwnPropertyNames(info).slice(0, 25))
console.log('proto     :', Object.getOwnPropertyNames(Object.getPrototypeOf(info ?? {})).slice(0, 30))

console.log('\n=== basic_info ===')
const bi = info?.basic_info
console.log('exists:', !!bi)
if (bi) {
  console.log('keys :', Object.keys(bi).slice(0, 20))
  console.log('title:', String(bi.title).slice(0, 80))
}

console.log('\n=== streaming_data ===')
const sd = info?.streaming_data
console.log('exists:', !!sd)
if (sd) {
  console.log('keys              :', Object.keys(sd))
  console.log('adaptive_formats n:', sd.adaptive_formats?.length)
  const audio = (sd.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video)
  console.log('audio-only formats:', audio.length)
  if (audio[0]) {
    const f = audio[0]
    console.log('\n=== first audio format ===')
    console.log('own props :', Object.getOwnPropertyNames(f).slice(0, 25))
    console.log('proto     :', Object.getOwnPropertyNames(Object.getPrototypeOf(f)).slice(0, 30))
    console.log('mime_type :', f.mime_type)
    console.log('bitrate   :', f.bitrate)
    console.log('has_audio :', f.has_audio, '/ has_video :', f.has_video)
    console.log('has .url      :', typeof f.url, f.url ? '(len ' + f.url.length + ')' : '')
    console.log('has .decipher :', typeof f.decipher)
  }
}

console.log('\n=== chooseFormat({type:audio,quality:best}) ===')
try {
  const f = info.chooseFormat({ type: 'audio', quality: 'best' })
  console.log('returned:', f ? f.constructor?.name : 'none')
  if (f) {
    console.log('mime    :', f.mime_type)
    console.log('bitrate :', f.bitrate)
    console.log('has .url    :', typeof f.url, f.url ? '(len ' + f.url.length + ')' : '')
    console.log('has decipher:', typeof f.decipher)
    if (typeof f.decipher === 'function') {
      try {
        const url = f.decipher(yt.session.player)
        console.log('decipher OK, url len:', url?.length, 'preview:', String(url).slice(0, 110))
      } catch (e) {
        console.log('decipher threw:', e.message)
      }
    }
  }
} catch (e) {
  console.log('chooseFormat threw:', e.message)
}
