// Diagnostic — for each item in a music search, print whether a thumbnail
// URL can be extracted via the same path our parser uses.
// Usage: node scripts/inspect-thumbs.mjs [query]
import { Innertube } from 'youtubei.js'

const query = process.argv[2] || 'Alone Edgars Bukovskis'
const yt = await Innertube.create()
const r = await yt.music.search(query, { type: 'song' })
const items = r.songs?.contents ?? []

console.log(`Query: "${query}" — ${items.length} items\n`)
for (let i = 0; i < items.length; i++) {
  const it = items[i]
  const t = it.thumbnail
  const list = t?.contents ?? (Array.isArray(t) ? t : null)
  const url = list?.[0]?.url
  const title = (it.title ?? '').toString().slice(0, 36)
  console.log(
    `[${String(i).padStart(2)}] ${title.padEnd(36)} ` +
      `thumb=${t ? t.constructor?.name ?? typeof t : 'null'} ` +
      `list=${Array.isArray(list) ? `array(${list.length})` : list === null ? 'null' : typeof list} ` +
      `url=${url ? 'YES (' + String(url).slice(0, 50) + ')' : 'NO'}`
  )
}
