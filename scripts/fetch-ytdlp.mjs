// Downloads the yt-dlp zipapp into resources/ for any platform.
// Runs automatically on `npm install` (postinstall); can also be re-run
// manually to update yt-dlp: `node scripts/fetch-ytdlp.mjs`.
//
// We use the cross-platform Python zipapp (single-file archive of the
// yt-dlp source) rather than the PyInstaller binaries. The persistent
// daemon (resources/yt-dlp-daemon.py) imports `yt_dlp` from this
// archive via zipimport; the per-call fallback runs it through a
// bundled Python (resources/python-{mac,win}/) so we don't depend on
// a system Python install.
//
// Historical: we used to fetch `yt-dlp.exe` on Windows and
// `yt-dlp_macos` on macOS. The macOS binary triggered 12-15s of amfid
// validation on every launch (PyInstaller extracts ~100 .so files
// each cold start); the Windows binary paid ~1.5-2s of Python init
// per spawn. The zipapp + bundled Python combo amortises both costs
// across the lifetime of the daemon worker.
import { createWriteStream } from 'node:fs'
import { mkdir, chmod, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

const fileName = 'yt-dlp'
const dest = join(root, 'resources', fileName)
const releases = 'https://github.com/yt-dlp/yt-dlp/releases'

// Resolve the latest tag first (`releases/latest` redirects to
// `releases/tag/<tag>`), then download that exact tag, so the version we
// record below is guaranteed to match the file. The app's yt-dlp updater
// (src/main/ytdlp-updater.ts) compares this version against the copy it
// may have downloaded into userData and runs the newer one.
let tag = null
try {
  const latest = await fetch(`${releases}/latest`, { redirect: 'manual' })
  const m = /\/releases\/tag\/([^/?#]+)/.exec(latest.headers.get('location') ?? '')
  if (m) tag = decodeURIComponent(m[1])
} catch (err) {
  console.warn(`Could not resolve the latest yt-dlp tag: ${err.message}`)
}
const url = tag
  ? `${releases}/download/${encodeURIComponent(tag)}/yt-dlp`
  : `${releases}/latest/download/yt-dlp`

await mkdir(join(root, 'resources'), { recursive: true })

console.log(`Downloading yt-dlp zipapp: ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`Failed to download yt-dlp: ${res.status} ${res.statusText}`)
  process.exit(1)
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
if (!isWin) await chmod(dest, 0o755)
console.log(`Saved ${dest}`)

if (tag) {
  await writeFile(`${dest}.version`, `${tag}
`)
  console.log(`yt-dlp version ${tag}`)
} else {
  await rm(`${dest}.version`, { force: true })
  console.warn('yt-dlp version unknown; the app updater will treat the bundled copy as outdated')
}
