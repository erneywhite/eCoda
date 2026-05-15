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
// Always wipes the partition first. Without that, leftover cookies from a
// previous (broken) import would block this one — Chrome refuses to let
// programmatic .set overwrite a cookie that's marked HttpOnly, and the
// LSID / GAPS family won't take a domain attribute, so a partial earlier
// state would survive between imports.
export async function importCookiesToMusicSession(): Promise<number> {
  const path = getCookiesFilePath()
  if (!existsSync(path)) return 0

  const ses = session.fromPartition(MUSIC_PARTITION)
  ses.setUserAgent(CHROME_UA)

  await clearMusicSessionCookies()

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

    // __Host- prefixed cookies are host-only by spec — they MUST NOT carry
    // a Domain attribute, MUST be Secure, and MUST have Path=/. yt-dlp's
    // Netscape dump still lists them with a domain field, which Chrome
    // then rejects as "invalid __Host- prefix". Drop the domain so
    // Electron writes them as host-only cookies the way they should be.
    const isHostPrefixed = name.startsWith('__Host-')

    try {
      await ses.cookies.set({
        url,
        name,
        value,
        ...(isHostPrefixed ? {} : { domain }),
        path: isHostPrefixed ? '/' : cookiePath || '/',
        secure: isHostPrefixed ? true : secure,
        httpOnly,
        expirationDate:
          Number.isFinite(expirationDate) && expirationDate > 0 ? expirationDate : undefined,
        // SameSite=None requires Secure per modern Chrome rules. For cookies
        // that aren't secure we leave SameSite at the default (unspecified)
        // so Chrome doesn't reject them outright.
        ...(secure || isHostPrefixed ? { sameSite: 'no_restriction' as const } : {})
      })
      imported++
    } catch (err) {
      console.warn(`[library-session] failed to import cookie ${name}:`, err)
    }
  }
  // Synthetic SOCS/CONSENT cookies so YouTube doesn't redirect us to the
  // GDPR / cookie banner on every visit. The user's Firefox dump can lack
  // these (they're only set after explicitly clicking "Accept all" in the
  // EU consent UI; if the user never clicked it in Firefox they're absent).
  // The values below are the standard "consent accepted" payload widely
  // used by yt-dlp / youtubei.js community.
  await ensureConsentCookies(ses)

  console.log(`[library-session] imported ${imported} cookies into ${MUSIC_PARTITION}`)

  // Verification log — what does Electron actually have for youtube.com
  // now? Tells us at a glance whether the most critical auth cookies are
  // present, in case something we set silently got dropped during persist.
  try {
    const stored = await ses.cookies.get({ domain: '.youtube.com' })
    const names = new Set(stored.map((c) => c.name))
    const wanted = ['SAPISID', '__Secure-3PSID', 'LOGIN_INFO', 'SID', '__Secure-1PSID']
    const present = wanted.filter((n) => names.has(n))
    const missing = wanted.filter((n) => !names.has(n))
    console.log(`[library-session] stored .youtube.com cookies: ${stored.length} total`)
    console.log(`[library-session] critical auth present: ${present.join(', ') || '(none)'}`)
    if (missing.length) console.log(`[library-session] critical auth MISSING: ${missing.join(', ')}`)
  } catch (err) {
    console.warn('[library-session] failed to verify stored cookies:', err)
  }
  return imported
}

// Adds SOCS + CONSENT cookies on .youtube.com and .google.com to short-circuit
// the cookie-consent banner that otherwise blocks every navigation.
async function ensureConsentCookies(ses: Electron.Session): Promise<void> {
  // SOCS payload that says "accepted, English, recent" — works regardless
  // of detected region. CONSENT payload says "yes, callback Brian".
  const SOCS_VALUE = 'CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg'
  const CONSENT_VALUE = 'YES+cb.20210328-17-p0.en+FX+667'
  // 13 months from now — Chrome caps cookie max-age at 400 days, but
  // YouTube's own SOCS lives roughly this long.
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 390

  for (const host of ['youtube.com', 'google.com']) {
    for (const [name, value] of [
      ['SOCS', SOCS_VALUE],
      ['CONSENT', CONSENT_VALUE]
    ] as const) {
      try {
        await ses.cookies.set({
          url: `https://${host}/`,
          name,
          value,
          domain: `.${host}`,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
          expirationDate: exp
        })
      } catch (err) {
        console.warn(`[library-session] failed to set synthetic ${name} on .${host}:`, err)
      }
    }
  }
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
