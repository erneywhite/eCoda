import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

// Stream of update lifecycle events the renderer can subscribe to. Kept
// flat so a renderer switch-case can render the right Settings string
// without us inventing a parallel state machine in the UI.
export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string | null }
  | { kind: 'not-available'; currentVersion: string }
  | { kind: 'progress'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

let mainWindowRef: BrowserWindow | null = null

export function registerMainWindow(win: BrowserWindow): void {
  mainWindowRef = win
}

function send(event: UpdaterEvent): void {
  mainWindowRef?.webContents.send('update:event', event)
}

// We want to drive the download from a button click, not silently —
// users should see "available, want to install?" before bandwidth gets
// spent. Same for install: hold the relaunch until the user is ready.
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.logger = {
  info: (...args: unknown[]) => console.log('[updater]', ...args),
  warn: (...args: unknown[]) => console.warn('[updater]', ...args),
  error: (...args: unknown[]) => console.error('[updater]', ...args),
  debug: () => undefined
}

autoUpdater.on('checking-for-update', () => send({ kind: 'checking' }))
autoUpdater.on('update-available', (info) => {
  send({
    kind: 'available',
    version: info.version,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null
  })
})
autoUpdater.on('update-not-available', (info) => {
  send({ kind: 'not-available', currentVersion: info.version })
})
autoUpdater.on('download-progress', (p) => {
  send({ kind: 'progress', percent: p.percent, transferred: p.transferred, total: p.total })
})
autoUpdater.on('update-downloaded', (info) => {
  send({ kind: 'downloaded', version: info.version })
})
autoUpdater.on('error', (err) => {
  send({ kind: 'error', message: err?.message ?? String(err) })
})

// Manually triggered "Check for updates" — surfaces every state to the UI.
// Returns true if it actually ran (false in dev / unpackaged).
export async function checkForUpdates(): Promise<boolean> {
  if (!app.isPackaged) {
    send({
      kind: 'error',
      message: 'Автообновления отключены в режиме разработки. Запусти установленный билд.'
    })
    return false
  }
  try {
    await autoUpdater.checkForUpdates()
    return true
  } catch (err) {
    // GitHub returns 404 when no release has been cut yet — that's not
    // an error from the user's perspective, just "nothing newer".
    const msg = err instanceof Error ? err.message : String(err)
    if (/404|not found/i.test(msg)) {
      send({ kind: 'not-available', currentVersion: app.getVersion() })
      return true
    }
    send({ kind: 'error', message: msg })
    return true
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    send({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}

export function installUpdate(): void {
  // quitAndInstall closes the app and runs the NSIS installer with the
  // standard "replace + relaunch" flow.
  autoUpdater.quitAndInstall(false, true)
}

// Fire a silent check shortly after launch — if there's a newer release
// the Settings tab will already show "available" by the time the user
// opens it. Failures are swallowed so an offline launch doesn't bother
// anyone with a popup.
export function silentCheckOnStartup(): void {
  if (!app.isPackaged) return
  // Small delay so the app finishes booting before we hit the network.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[updater] silent check failed:', err)
    })
  }, 3000)
}
