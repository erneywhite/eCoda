import { BrowserWindow, session, app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const PARTITION = 'persist:youtube'
const LOGIN_URL = 'https://music.youtube.com/'

// A normal Chrome user-agent so Google doesn't flag the window as an
// "insecure browser" and refuse the login.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

// Presence of any of these cookies means the session is signed in.
const AUTH_COOKIE_NAMES = ['SAPISID', '__Secure-3PAPISID', 'LOGIN_INFO']

function ytSession() {
  return session.fromPartition(PARTITION)
}

function cookiesFilePath(): string {
  return join(app.getPath('userData'), 'youtube-cookies.txt')
}

export async function isLoggedIn(): Promise<boolean> {
  const cookies = await ytSession().cookies.get({})
  return cookies.some((c) => AUTH_COOKIE_NAMES.includes(c.name))
}

// Writes the persisted session's cookies in the Netscape format yt-dlp
// expects, and returns the file path.
export async function writeCookiesFile(): Promise<string> {
  const cookies = await ytSession().cookies.get({})
  const lines = ['# Netscape HTTP Cookie File']
  for (const c of cookies) {
    const domain = c.domain ?? ''
    const includeSub = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const secure = c.secure ? 'TRUE' : 'FALSE'
    const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 0
    lines.push([domain, includeSub, c.path, secure, expiry, c.name, c.value].join('\t'))
  }
  const path = cookiesFilePath()
  await writeFile(path, lines.join('\n') + '\n', 'utf8')
  return path
}

// Opens a real Chromium window on YouTube Music for the user to sign in.
// Resolves true once the session is authenticated, false if cancelled.
export function openLoginWindow(parent: BrowserWindow): Promise<boolean> {
  return new Promise((resolve) => {
    const ses = ytSession()
    ses.setUserAgent(CHROME_UA)

    const win = new BrowserWindow({
      parent,
      width: 520,
      height: 720,
      title: 'Вход в YouTube Music',
      autoHideMenuBar: true,
      backgroundColor: '#0e0a16',
      webPreferences: { partition: PARTITION }
    })

    let settled = false
    let poll: ReturnType<typeof setInterval>

    const finish = async (success: boolean): Promise<void> => {
      if (settled) return
      settled = true
      clearInterval(poll)
      if (success) await writeCookiesFile()
      if (!win.isDestroyed()) win.close()
      resolve(success)
    }

    poll = setInterval(() => {
      isLoggedIn().then((yes) => {
        if (yes) finish(true)
      })
    }, 1500)

    win.on('closed', () => {
      clearInterval(poll)
      if (!settled) {
        settled = true
        resolve(false)
      }
    })

    win.loadURL(LOGIN_URL)
  })
}

export async function logout(): Promise<void> {
  await ytSession().clearStorageData()
  await writeFile(cookiesFilePath(), '# Netscape HTTP Cookie File\n', 'utf8')
}
