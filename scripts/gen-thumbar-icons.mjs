// One-shot generator for the Windows taskbar thumbnail-toolbar button icons
// (prev / play / pause / next). White Material glyphs on transparent, 16×16
// (the size Windows expects for thumbbar buttons). Run once; the PNGs are
// committed to resources/thumbar/ and imported in src/main/index.ts via
// electron-vite's `?asset`. Re-run if the glyphs change.
//
//   node scripts/gen-thumbar-icons.mjs
//
// sharp is already a devDependency (used by resize-branding.mjs).
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'resources', 'thumbar')
mkdirSync(outDir, { recursive: true })

const SIZE = 16
// 24×24-viewBox Material paths, scaled down to 16×16 by sharp.
const GLYPHS = {
  prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  next: 'M6 18l8.5-6L6 6zM16 6h2v12h-2z'
}

for (const [name, d] of Object.entries(GLYPHS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><path fill="#ffffff" d="${d}"/></svg>`
  await sharp(Buffer.from(svg)).png().toFile(join(outDir, `${name}.png`))
  console.log('wrote', join('resources', 'thumbar', `${name}.png`))
}
