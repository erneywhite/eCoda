// Downloads the yt-dlp binary into resources/ for the current platform.
// Runs automatically on `npm install` (postinstall); can also be re-run
// manually to update yt-dlp: `node scripts/fetch-ytdlp.mjs`.
import { createWriteStream } from 'node:fs'
import { mkdir, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

// macOS gets the Python zipapp (executed via system `python3 <file>`)
// instead of the `yt-dlp_macos` PyInstaller binary. The PyInstaller
// bundle on macOS extracts ~100 internal .so files at every launch, each
// of which amfid validates (~150ms apiece) → 12-15s cold start. The
// zipapp imports Python modules from the system Python install (all
// Apple-signed) → no amfid overhead, ~0.05s startup. See ytdlp.ts for
// the matching change in how we spawn it.
const assetName = isWin ? 'yt-dlp.exe' : isMac ? 'yt-dlp' : 'yt-dlp'
const fileName = isWin ? 'yt-dlp.exe' : 'yt-dlp'
const dest = join(root, 'resources', fileName)
const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${assetName}`

await mkdir(join(root, 'resources'), { recursive: true })

console.log(`Downloading yt-dlp: ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`Failed to download yt-dlp: ${res.status} ${res.statusText}`)
  process.exit(1)
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
if (!isWin) await chmod(dest, 0o755)
console.log(`Saved ${dest}`)
