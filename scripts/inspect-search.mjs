// Diagnostic script — prints the actual shape of a youtubei.js music search
// result so we can write the right parsing code in src/main/metadata.ts.
// Usage: node scripts/inspect-search.mjs [query]
import { Innertube } from 'youtubei.js'

const query = process.argv[2] || 'rick astley never gonna give you up'
const yt = await Innertube.create()
const r = await yt.music.search(query, { type: 'song' })

console.log('=== top-level ===')
console.log('constructor:', r?.constructor?.name)
console.log('own props :', Object.getOwnPropertyNames(r))
console.log('proto     :', Object.getOwnPropertyNames(Object.getPrototypeOf(r ?? {})))

console.log('\n=== candidate fields on the result ===')
for (const k of ['songs', 'contents', 'results', 'header', 'sections', 'tracks', 'shelves']) {
  const v = r?.[k]
  if (v === undefined) continue
  const arr = Array.isArray(v) ? `array(${v.length})` : ''
  console.log(`r.${k}:`, typeof v, v?.constructor?.name ?? '', arr)
}

console.log('\n=== first usable array of items ===')
const candidates = [r?.songs?.contents, r?.songs, r?.contents, r?.results, r?.tracks]
for (const c of candidates) {
  if (Array.isArray(c) && c.length > 0) {
    const item = c[0]
    console.log('items in this array:', c.length)
    console.log('first item constructor:', item?.constructor?.name)
    console.log('first item own props :', Object.getOwnPropertyNames(item))
    console.log('first item proto     :', Object.getOwnPropertyNames(Object.getPrototypeOf(item ?? {})))
    console.log('\nFirst item JSON (truncated to 3 KB):')
    console.log(JSON.stringify(item, null, 2).slice(0, 3000))
    break
  }
}
