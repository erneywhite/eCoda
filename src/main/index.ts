import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { verifyBrowserLogin } from './ytdlp'
import { detectBrowsers, getBrowser, setBrowser, disconnect, ytdlpBrowserArg } from './auth'
import { searchSongs, getHomeSections, getPlaylistTracks, resetInnertube } from './metadata'
import { resolveCached, queuePrefetch, clearResolverCache } from './resolver'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e0a16',
    title: 'eCoda',
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // DevTools open by default in dev only — easier to inspect renderer
    // logs and network without poking Ctrl+Shift+I every launch.
    if (!app.isPackaged) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Open external links in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('auth:browsers', () => detectBrowsers())
  ipcMain.handle('auth:status', () => getBrowser())
  ipcMain.handle('auth:connect', async (_event, browser: string) => {
    const arg = ytdlpBrowserArg(browser)
    if (!arg) return false
    const ok = await verifyBrowserLogin(arg)
    if (ok) {
      await setBrowser(browser)
      // The cookies file was just refreshed by verifyBrowserLogin; force
      // youtubei.js to pick them up on the next request.
      resetInnertube()
    }
    return ok
  })
  ipcMain.handle('auth:disconnect', async () => {
    await disconnect()
    resetInnertube()
    clearResolverCache()
    return true
  })
  ipcMain.handle('auth:open-youtube', () => {
    shell.openExternal('https://www.youtube.com/')
    return true
  })
  ipcMain.handle('metadata:search', (_event, query: string) => searchSongs(query))
  ipcMain.handle('metadata:home', () => getHomeSections())
  ipcMain.handle('metadata:playlist', (_event, id: string) => getPlaylistTracks(id))
  // Resolves a single track's stream URL. yt-dlp is the only working path —
  // youtubei.js can't get music streams without po_token (see metadata.ts).
  // Resolves go through resolver.ts so re-clicks and prefetched tracks come
  // back from the in-memory cache instantly.
  ipcMain.handle('audio:resolve', async (_event, input: string) => {
    const browser = await getBrowser()
    if (!browser) {
      throw new Error('No browser connected — connect a browser first.')
    }
    const arg = ytdlpBrowserArg(browser)
    if (!arg) {
      throw new Error('Could not resolve cookies for the connected browser.')
    }
    return resolveCached(input, arg)
  })
  // Fire-and-forget — renderer hands off "next N tracks" once playback
  // starts, so by the time the user clicks the next one its URL is ready.
  ipcMain.handle('audio:prefetch', async (_event, ids: string[]) => {
    const browser = await getBrowser()
    if (!browser) return false
    const arg = ytdlpBrowserArg(browser)
    if (!arg) return false
    queuePrefetch(Array.isArray(ids) ? ids : [], arg)
    return true
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
