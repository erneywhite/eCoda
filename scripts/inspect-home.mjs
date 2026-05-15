// Look at the actual shape of one MusicCarouselShelf item from
// getHomeFeed so the parser in metadata.ts is grounded in real data.
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
const home = await yt.music.getHomeFeed()

for (let i = 0; i < (home.sections?.length ?? 0); i++) {
  const s = home.sections[i]
  const title = String(s?.header?.title?.text ?? s?.header?.title ?? '(no title)').slice(0, 40)
  console.log(`\n[${i}] ${s.constructor?.name}: ${title} — ${s.contents?.length ?? 0} items`)
  const first = s.contents?.[0]
  if (!first) continue
  console.log(`     first item: ${first.constructor?.name}`)
  const props = Object.getOwnPropertyNames(first).filter((k) => !k.startsWith('_'))
  for (const k of props) {
    const v = first[k]
    if (v === null || v === undefined) continue
    if (typeof v === 'string') console.log(`       ${k} = ${v.slice(0, 60)}`)
    else if (typeof v === 'number' || typeof v === 'boolean') console.log(`       ${k} = ${v}`)
    else if (Array.isArray(v)) console.log(`       ${k} = [Array(${v.length})]`)
    else if (typeof v === 'object') {
      const keys = Object.keys(v).slice(0, 4)
      const text = v.text ?? v.name ?? null
      console.log(
        `       ${k} = ${v.constructor?.name} { ${keys.join(', ')} }${text ? ` text="${String(text).slice(0, 40)}"` : ''}`
      )
    }
  }
}

writeFileSync(
  'inspect-home.json',
  JSON.stringify(home, (_, v) => (typeof v === 'function' ? '[fn]' : v), 2)
)
console.log('\nwrote inspect-home.json')
