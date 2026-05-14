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

const assetName = isWin ? 'yt-dlp.exe' : isMac ? 'yt-dlp_macos' : 'yt-dlp'
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
