// Downloads a standalone Python runtime into resources/python-{mac,win}/
// so the packaged app can run the yt-dlp zipapp without depending on a
// system Python install. See src/main/ytdlp.ts (macPython3Path /
// winPython3Path) for how it's consumed.
//
// Why bundle Python at all:
//
//   macOS — `yt-dlp_macos` is a PyInstaller binary. At every launch it
//   extracts ~100 internal .so files to /tmp, and amfid validates each
//   one (~150ms per file) → 12-15s cold startup overhead before any
//   network call. The zipapp + signed standalone Python skips that
//   path entirely → ~0.05s startup.
//
//   Windows — no amfid, but `yt-dlp.exe` is also PyInstaller and pays
//   ~1.5-2s for the Python interpreter bootstrap on every spawn, plus
//   ~2-3s for `YoutubeDL` construction (1864 extractors). The
//   persistent daemon (resources/yt-dlp-daemon.py) amortises both —
//   but to spawn the daemon we need a system-independent Python.
//
// Linux is a no-op — users tend to have a system Python and we don't
// ship Linux builds yet.
//
// Uses astral-sh/python-build-standalone "install_only_stripped"
// distributions: full Python runtime + stdlib, no debug symbols, no
// headers/static libs.
//
// Runs as part of `npm install` postinstall.
import { createWriteStream } from 'node:fs'
import { mkdir, rm, mkdtemp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { existsSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

if (!isMac && !isWin) {
  // Linux / others — user's system Python is fine, no shipped builds.
  process.exit(0)
}

// Pinned release. Bump manually when bumping Python — pinning keeps
// builds reproducible. macOS and Windows MUST stay on the same release
// + version so behaviour is identical across our two shipped builds.
const RELEASE = '20260510'
const PY_VERSION = '3.13.13'

// Asset name + extension differ per platform:
//   macOS  — .tar.gz, arch in name
//   Windows — .tar.gz, single x64 build
const arch = isMac ? (process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin') : 'x86_64-pc-windows-msvc'
const assetName = `cpython-${PY_VERSION}+${RELEASE}-${arch}-install_only_stripped.tar.gz`
const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE}/${assetName}`

const destDirName = isMac ? 'python-mac' : 'python-win'
const dest = join(root, 'resources', destDirName)

// Skip if a Python matching this exact release is already present.
// Lets `npm install` be a fast no-op on second runs.
const versionMarker = join(dest, '.ecoda-version')
const stampValue = `${PY_VERSION}+${RELEASE}-${arch}`
if (existsSync(versionMarker)) {
  if (readFileSync(versionMarker, 'utf8').trim() === stampValue) {
    console.log(`Bundled Python ${PY_VERSION} already present at ${dest}, skipping`)
    process.exit(0)
  }
}

await mkdir(join(root, 'resources'), { recursive: true })
await rm(dest, { recursive: true, force: true })

const tmp = await mkdtemp(join(tmpdir(), 'ecoda-py-'))
const tarPath = join(tmp, 'python.tar.gz')

console.log(`Downloading bundled Python (${arch}): ${url}`)
const res = await fetch(url, { redirect: 'follow' })
if (!res.ok || !res.body) {
  console.error(`Failed to download bundled Python: ${res.status} ${res.statusText}`)
  process.exit(1)
}
await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath))

// Extraction layout (both platforms): tarball contains a top-level
// `python/` directory which we rename to our chosen folder name. On
// macOS this gives python/{bin,lib,include,share}; on Windows it
// gives python/{python.exe, pythonw.exe, python313.dll, DLLs, Lib, ...}.
//
// `tar` on Windows: if we just run `tar`, the PATH-resolved binary
// might be Git-Bash's GNU tar — which interprets `C:` in -C paths as
// a remote host. Use the absolute Windows system tar.exe (which IS
// bsdtar and handles drive letters) to avoid that. CMD's PATH does
// the right thing in production npm install, but being explicit makes
// the script work from any shell.
const tarExe = isWin
  ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar'
await run(tarExe, ['-xzf', tarPath, '-C', tmp])
renameSync(join(tmp, 'python'), dest)

// Stamp the version so the next postinstall can skip if unchanged.
writeFileSync(versionMarker, `${stampValue}\n`)

await rm(tmp, { recursive: true, force: true })
console.log(`Bundled Python ${PY_VERSION} installed at ${dest}`)
