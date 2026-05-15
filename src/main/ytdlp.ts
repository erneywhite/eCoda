import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, delimiter } from 'node:path'
import { writeFileSync } from 'node:fs'
import ytdlpPath from '../../resources/yt-dlp.exe?asset'
import denoPath from '../../resources/deno.exe?asset'
import { getCookiesFilePath } from './auth'

const run = promisify(execFile)

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

// Resolves a track's title and audio stream URL. `browser` is the browser
// yt-dlp reads the YouTube login cookies from — that authenticated session
// unlocks Premium quality and gets past YouTube's bot check.
export async function resolveAudio(input: string, browser: string): Promise<ResolvedAudio> {
  const { stdout } = await run(
    ytdlpPath,
    [
      '-f',
      'bestaudio',
      '--no-playlist',
      '--no-warnings',
      '--cookies-from-browser',
      browser,
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

// Checks whether a browser has a usable YouTube login by trying to reach the
// user's private "Liked videos" playlist (LL), which requires authentication.
// Side effect: also dumps the cookies to disk for youtubei.js to use later.
export async function verifyBrowserLogin(browser: string): Promise<boolean> {
  const cookieFile = getCookiesFilePath()
  // ALWAYS reset the cookies file before yt-dlp runs. With --cookies <file>
  // present, yt-dlp merges its contents with --cookies-from-browser; if the
  // file still holds last session's cookies (which YouTube has since
  // rotated/invalidated), the merged jar fails auth even though the live
  // browser cookies on their own would have worked. Truncating gives
  // yt-dlp a clean slate to dump into.
  try {
    writeFileSync(cookieFile, '# Netscape HTTP Cookie File\n', 'utf-8')
  } catch (err) {
    console.warn('[verifyBrowserLogin] could not reset cookies file:', err)
  }
  try {
    await run(
      ytdlpPath,
      [
        '--cookies-from-browser',
        browser,
        '--cookies',
        cookieFile,
        '--flat-playlist',
        '--playlist-items',
        '1',
        '--simulate',
        '--no-warnings',
        'https://www.youtube.com/playlist?list=LL'
      ],
      { maxBuffer: 10 * 1024 * 1024, env: ytdlpEnv }
    )
    return true
  } catch (err) {
    // Surface the actual yt-dlp stderr so we can tell whether the failure
    // is "Firefox profile is locked, close the browser", "no YouTube login
    // in this browser", or something else. Otherwise the user just sees a
    // generic "not signed in" UI message and has nothing to act on.
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const detail = (e.stderr ?? e.stdout ?? e.message ?? '')
      .toString()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-5)
      .join('\n')
    console.warn(`[verifyBrowserLogin] yt-dlp failed for browser=${browser}:\n${detail}`)
    return false
  }
}
