import { session } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { getCookiesFilePath } from './auth'

// Webview <webview partition="persist:music"> shares this partition.
// Cookies imported here are seen by music.youtube.com when the Library tab
// loads — without that, Google sees the embedded webview as anonymous and
// shows the "Sign in" prompt instead of the user's actual library.
export const MUSIC_PARTITION = 'persist:music'

// Spoof a regular Windows Chrome user agent for music.youtube.com requests
// from the webview partition. Electron's default Chrome-Electron UA used to
// trip Google's "this browser may not be secure" heuristic for embedded
// browsers. We're not signing the user in inside the webview (cookies
// already give us a live session), but a plain Chrome UA still helps avoid
// any client-fingerprinting weirdness.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// Imports every YouTube/Google cookie from the Netscape file yt-dlp wrote at
// auth:connect into the persist:music session, so the webview-embedded
// music.youtube.com sees us as logged in.
//
// Idempotent: running it again just refreshes cookies (Electron .set
// overwrites by name+domain+path).
export async function importCookiesToMusicSession(): Promise<number> {
  const path = getCookiesFilePath()
  if (!existsSync(path)) return 0

  const ses = session.fromPartition(MUSIC_PARTITION)
  ses.setUserAgent(CHROME_UA)

  let imported = 0
  for (const rawLine of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    let line = rawLine
    // yt-dlp marks HttpOnly cookies by prefixing the domain field with
    // "#HttpOnly_" — that's exactly where every meaningful YouTube auth
    // cookie lives (__Secure-3PSID, LOGIN_INFO, SAPISID, etc). A naive
    // "lines starting with # are comments" filter would drop them all,
    // which leaves us logged out.
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true
      line = line.slice('#HttpOnly_'.length)
    } else if (line.trimStart().startsWith('#') || !line.trim()) {
      continue
    }
    const parts = line.split('\t')
    if (parts.length < 7) continue
    const [domain, , cookiePath, secureFlag, expirationStr, name, value] = parts
    if (!domain.includes('youtube.com') && !domain.includes('google.com')) continue
    if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(value)) continue

    // Strip the Netscape leading "." from the domain field — Electron's
    // cookies API normalises it via the `domain` property; the URL just
    // needs a host it can resolve.
    const bareDomain = domain.startsWith('.') ? domain.slice(1) : domain
    const url = `https://${bareDomain}${cookiePath || '/'}`
    const expirationDate = Number(expirationStr)
    const secure = secureFlag === 'TRUE'

    try {
      await ses.cookies.set({
        url,
        name,
        value,
        domain,
        path: cookiePath || '/',
        secure,
        httpOnly,
        expirationDate:
          Number.isFinite(expirationDate) && expirationDate > 0 ? expirationDate : undefined,
        // SameSite=None requires Secure per modern Chrome rules. For cookies
        // that aren't secure we leave SameSite at the default (unspecified)
        // so Chrome doesn't reject them outright.
        ...(secure ? { sameSite: 'no_restriction' as const } : {})
      })
      imported++
    } catch (err) {
      // A single bad cookie (rare — usually invalid sameSite/secure combo)
      // shouldn't kill the import. Just skip and keep going.
      console.warn(`[library-session] failed to import cookie ${name}:`, err)
    }
  }
  console.log(`[library-session] imported ${imported} cookies into ${MUSIC_PARTITION}`)
  return imported
}

// Clears every cookie from persist:music — fires on auth:disconnect so a
// later signed-in account can't accidentally see the previous user's library.
export async function clearMusicSessionCookies(): Promise<void> {
  const ses = session.fromPartition(MUSIC_PARTITION)
  const cookies = await ses.cookies.get({})
  await Promise.all(
    cookies.map((c) => {
      const bare = c.domain?.startsWith('.') ? c.domain.slice(1) : c.domain
      const url = `https://${bare}${c.path || '/'}`
      return ses.cookies.remove(url, c.name).catch(() => {})
    })
  )
}
