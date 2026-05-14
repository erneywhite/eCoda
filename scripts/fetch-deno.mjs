// Downloads the Deno runtime into resources/ for the current platform.
// yt-dlp uses Deno to solve YouTube's signature/nsig JS challenges.
// Runs on `npm install` (postinstall); can be re-run to update Deno.
import { createWriteStream } from 'node:fs'
import { mkdir, chmod, copyFile, rm, mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const isMac = process.platform === 'darwin'

const target = isWin
  ? 'x86_64-pc-windows-msvc'
  : isMac
    ? process.arch === 'arm64'
      ? 'aarch64-apple-darwin'
      : 'x86_64-apple-darwin'
    : 'x86_64-unknown-linux-gnu'
const binName = isWin ? 'deno.exe' : 'deno'
const url = `https://github.com/denoland/deno/releases/latest/download/deno-${target}.zip`

await mkdir(join(root, 'resources'), { recursive: true })
const tmp = await mkdtemp(join(tmpdir(), 'ecoda-deno-'))
const zipPath = join(tmp, 'deno.zip')

console.log(`Downloading Deno: ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`Failed to download Deno: ${res.status} ${res.statusText}`)
  process.exit(1)
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))

// tar (bsdtar) ships with Windows 10+ and macOS and extracts .zip archives.
await run('tar', ['-xf', zipPath, '-C', tmp])

const dest = join(root, 'resources', binName)
await copyFile(join(tmp, binName), dest)
if (!isWin) await chmod(dest, 0o755)
await rm(tmp, { recursive: true, force: true })

console.log(`Saved ${dest}`)
