// macOS-only: downloads a standalone Python runtime into
// resources/python-mac/ so the packaged .app can run the yt-dlp zipapp
// without depending on a system Python install. See ytdlp.ts comment
// next to macPython3Path() for the why — PyInstaller-based yt-dlp_macos
// has a 12+ second cold start on macOS because amfid validates each of
// the ~100 .so files it extracts to /tmp at every launch. The zipapp +
// a standalone Python avoids that path entirely.
//
// Uses astral-sh/python-build-standalone "install_only_stripped"
// distributions: full Python runtime + stdlib, no debug symbols, no
// headers/static libs. ~24 MB compressed, ~65 MB extracted.
//
// Runs as part of `npm install` postinstall. No-op on Windows/Linux.
import { createWriteStream } from 'node:fs'
import { mkdir, rm, mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { existsSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  // Other platforms use a system / PyInstaller route — no bundled Python needed.
  process.exit(0)
}

// Pinned release. Bump manually when bumping Python — pinning keeps
// builds reproducible (yt-dlp deprecates Python versions every ~2 years
// and a silent .latest bump could surprise us).
const RELEASE = '20260510'
const PY_VERSION = '3.13.13'
const arch = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
const assetName = `cpython-${PY_VERSION}+${RELEASE}-${arch}-install_only_stripped.tar.gz`
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${assetName}`

const dest = join(root, 'resources', 'python-mac')
// If a Python framework matching this release is already present, skip the
// download. Lets `npm install` be a fast no-op on second runs.
const versionMarker = join(dest, '.ecoda-version')
if (existsSync(versionMarker)) {
  const { readFileSync } = await import('node:fs')
  if (readFileSync(versionMarker, 'utf8').trim() === `${PY_VERSION}+${RELEASE}-${arch}`) {
    console.log(`Bundled Python ${PY_VERSION} already present at ${dest}, skipping`)
    process.exit(0)
  }
}

await mkdir(join(root, 'resources'), { recursive: true })
await rm(dest, { recursive: true, force: true })

const tmp = await mkdtemp(join(tmpdir(), 'ecoda-py-'))
const tarPath = join(tmp, 'python.tar.gz')

console.log(`Downloading bundled Python: ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`Failed to download bundled Python: ${res.status} ${res.statusText}`)
  process.exit(1)
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath))

// Tarball extracts as a top-level `python/` directory. Rename it to
// our chosen layout (resources/python-mac/{bin,lib,include,share}).
await run('tar', ['-xzf', tarPath, '-C', tmp])
renameSync(join(tmp, 'python'), dest)

// Stamp the version so the next postinstall can skip if unchanged.
const { writeFileSync } = await import('node:fs')
writeFileSync(versionMarker, `${PY_VERSION}+${RELEASE}-${arch}\n`)

await rm(tmp, { recursive: true, force: true })
console.log(`Bundled Python ${PY_VERSION} installed at ${dest}`)
