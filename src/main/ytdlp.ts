import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, delimiter } from 'node:path'
import ytdlpPath from '../../resources/yt-dlp.exe?asset'
import denoPath from '../../resources/deno.exe?asset'

const run = promisify(execFile)

// Cookies are read from the user's logged-in browser. Required for two
// reasons: an authenticated session unlocks Premium-quality streams, and
// it gets past YouTube's "confirm you're not a bot" check.
const COOKIES_BROWSER = 'firefox'

// yt-dlp solves YouTube's signature/nsig JS challenges with a JS runtime it
// finds on PATH. We ship our own Deno and put it on PATH for the child
// process, so extraction never depends on a system-wide install.
const ytdlpEnv = {
  ...process.env,
  PATH: `${dirname(denoPath)}${delimiter}${process.env.PATH ?? ''}`
}

export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

// Accepts a full YouTube / YouTube Music URL or a bare 11-char video id.
function toWatchUrl(input: string): string {
  const trimmed = input.trim()
  if (/^[\w-]{11}$/.test(trimmed)) {
    return `https://www.youtube.com/watch?v=${trimmed}`
  }
  return trimmed
}

export async function resolveAudio(input: string): Promise<ResolvedAudio> {
  const { stdout } = await run(
    ytdlpPath,
    [
      '-f',
      'bestaudio',
      '--no-playlist',
      '--no-warnings',
      '--cookies-from-browser',
      COOKIES_BROWSER,
      '--print',
      '%(title)s',
      '--print',
      '%(ext)s',
      '--print',
      '%(url)s',
      toWatchUrl(input)
    ],
    { maxBuffer: 10 * 1024 * 1024, env: ytdlpEnv }
  )
  const [title, format, streamUrl] = stdout.trim().split(/\r?\n/)
  if (!streamUrl) {
    throw new Error('yt-dlp did not return a stream URL')
  }
  return { title, format, streamUrl }
}
