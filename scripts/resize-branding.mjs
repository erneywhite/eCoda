// Resizes the brand assets the artist delivers into branding/ down to
// the sizes the app actually uses, and copies them to the three
// destinations electron-builder + the renderer read from:
//
//   branding/wordmark.png → src/renderer/src/assets/wordmark.png  (header lettering)
//   branding/icon.png     → resources/icon.png                    (window + tray + Dock)
//   branding/icon.png     → build/icon.png                        (electron-builder NSIS/dmg/icns source)
//
// Source PNGs from the artist are typically very large (4900×4900 and
// up). Shipping them as-is would bloat the installer and force every
// renderer paint to downscale a 14k-wide bitmap. Sharp does the resize
// once at build-asset time.
//
// Usage:  node scripts/resize-branding.mjs
import sharp from 'sharp'
import { existsSync, statSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const branding = join(root, 'branding')
const wordmarkSrc = join(branding, 'wordmark.png')
const iconSrc = join(branding, 'icon.png')

for (const p of [wordmarkSrc, iconSrc]) {
  if (!existsSync(p)) {
    console.error(`Missing source asset: ${p}`)
    process.exit(1)
  }
}

// Wordmark target: rendered at 200×72 in a slot with object-fit:
// contain. We multiply by 3x for HiDPI displays so it stays sharp on
// retina / 4K — 600×216 covers the 200×72 paint at any sane device-
// pixel-ratio without obvious aliasing. Width-based fit preserves the
// natural aspect ratio (~3.05:1 for the current art).
const wordmarkDst = join(root, 'src', 'renderer', 'src', 'assets', 'wordmark.png')
const wordmarkMeta = await sharp(wordmarkSrc).metadata()
console.log(
  `wordmark.png source: ${wordmarkMeta.width}×${wordmarkMeta.height}, ${(
    statSync(wordmarkSrc).size /
    1024 /
    1024
  ).toFixed(1)} MB`
)
await sharp(wordmarkSrc)
  .resize({ width: 600, withoutEnlargement: true, fit: 'inside' })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(wordmarkDst)
const wordmarkOutMeta = await sharp(wordmarkDst).metadata()
console.log(
  `  → ${wordmarkDst} (${wordmarkOutMeta.width}×${wordmarkOutMeta.height}, ${(
    statSync(wordmarkDst).size / 1024
  ).toFixed(1)} KB)`
)

// Icon target: a single 1024×1024 master PNG, used for:
//   resources/icon.png  — window + tray + Dock icon (we resize at
//                         runtime via nativeImage.resize(...) so the
//                         source needs to be big enough to downscale
//                         cleanly to 22-32 px without artifacts)
//   build/icon.png      — electron-builder reads this to generate the
//                         platform-specific .ico (Windows) and .icns
//                         (macOS) icon bundles. The recommended
//                         source size is 1024×1024 — anything smaller
//                         and the high-DPI sizes in .icns look soft.
const iconDst1 = join(root, 'resources', 'icon.png')
const iconDst2 = join(root, 'build', 'icon.png')
const iconMeta = await sharp(iconSrc).metadata()
console.log(
  `icon.png source: ${iconMeta.width}×${iconMeta.height}, ${(
    statSync(iconSrc).size /
    1024 /
    1024
  ).toFixed(1)} MB`
)
await sharp(iconSrc)
  .resize({ width: 1024, height: 1024, withoutEnlargement: true, fit: 'inside' })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(iconDst1)
await copyFile(iconDst1, iconDst2)
const iconOutMeta = await sharp(iconDst1).metadata()
console.log(
  `  → ${iconDst1} (${iconOutMeta.width}×${iconOutMeta.height}, ${(
    statSync(iconDst1).size / 1024
  ).toFixed(1)} KB)`
)
console.log(`  → ${iconDst2} (copy)`)

console.log('\nDone. Run `npm run build:win` (or :mac) to bundle.')
