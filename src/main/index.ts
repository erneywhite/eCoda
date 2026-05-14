import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { resolveAudio, verifyBrowserLogin } from './ytdlp'
import { detectBrowsers, getBrowser, setBrowser, disconnect } from './auth'

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
    const ok = await verifyBrowserLogin(browser)
    if (ok) await setBrowser(browser)
    return ok
  })
  ipcMain.handle('auth:disconnect', async () => {
    await disconnect()
    return true
  })
  ipcMain.handle('auth:open-youtube', () => {
    shell.openExternal('https://www.youtube.com/')
    return true
  })
  ipcMain.handle('audio:resolve', async (_event, input: string) => {
    const browser = await getBrowser()
    if (!browser) {
      throw new Error('No browser connected — connect a browser first.')
    }
    return resolveAudio(input, browser)
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
