import { contextBridge, ipcRenderer } from 'electron'

const api = {
  resolveAudio: (input: string) => ipcRenderer.invoke('audio:resolve', input),
  prefetchAudio: (ids: string[]) => ipcRenderer.invoke('audio:prefetch', ids),
  auth: {
    browsers: () => ipcRenderer.invoke('auth:browsers'),
    status: () => ipcRenderer.invoke('auth:status'),
    connect: (browser: string) => ipcRenderer.invoke('auth:connect', browser),
    disconnect: () => ipcRenderer.invoke('auth:disconnect'),
    openYouTube: () => ipcRenderer.invoke('auth:open-youtube'),
    // Fires after the main process silently refreshed cookies on launch.
    // The renderer should drop any auth-bound caches and re-fetch the
    // current view so an initially-empty Library/Home is repopulated.
    onRefreshed: (cb: () => void) => {
      const wrapped = (): void => cb()
      ipcRenderer.on('auth:refreshed', wrapped)
      return () => ipcRenderer.removeListener('auth:refreshed', wrapped)
    }
  },
  metadata: {
    search: (query: string) => ipcRenderer.invoke('metadata:search', query),
    home: () => ipcRenderer.invoke('metadata:home'),
    playlist: (id: string) => ipcRenderer.invoke('metadata:playlist', id),
    libraryPlaylists: () => ipcRenderer.invoke('metadata:library-playlists'),
    like: (videoId: string, like: boolean) =>
      ipcRenderer.invoke('metadata:like', videoId, like),
    radio: (videoId: string) => ipcRenderer.invoke('metadata:radio', videoId),
    artist: (channelId: string) => ipcRenderer.invoke('metadata:artist', channelId)
  },
  library: {
    prepare: () => ipcRenderer.invoke('library:prepare')
  },
  downloads: {
    status: (ids: string[]) => ipcRenderer.invoke('downloads:status', ids),
    list: () => ipcRenderer.invoke('downloads:list'),
    stats: () => ipcRenderer.invoke('downloads:stats'),
    track: (info: { videoId: string; title: string; artist: string; thumbnail: string }) =>
      ipcRenderer.invoke('downloads:track', info),
    playlist: (tracks: Array<{ videoId: string; title: string; artist: string; thumbnail: string }>) =>
      ipcRenderer.invoke('downloads:playlist', tracks),
    delete: (videoId: string) => ipcRenderer.invoke('downloads:delete', videoId),
    clearAll: () => ipcRenderer.invoke('downloads:clearAll'),
    verify: () => ipcRenderer.invoke('downloads:verify'),
    asPlaylist: () => ipcRenderer.invoke('downloads:asPlaylist'),
    cancel: (videoId: string) => ipcRenderer.invoke('downloads:cancel', videoId),
    cancelAll: () => ipcRenderer.invoke('downloads:cancelAll'),
    // The renderer subscribes once at mount; the unsubscribe function is
    // returned so $effect-style teardown can remove the listener cleanly.
    onProgress: (
      cb: (p: {
        done: number
        total: number
        videoId: string
        title: string
        errored: boolean
        errorReason?: string
      }) => void
    ) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        cb(
          payload as {
            done: number
            total: number
            videoId: string
            title: string
            errored: boolean
            errorReason?: string
          }
        )
      ipcRenderer.on('downloads:progress', wrapped)
      return () => ipcRenderer.removeListener('downloads:progress', wrapped)
    },
    // Live per-track progress (0–100) emitted as yt-dlp prints each
    // percentage tick. UI uses it to render a filling ring on the
    // track's download chip.
    onTrackProgress: (cb: (p: { videoId: string; percent: number }) => void) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        cb(payload as { videoId: string; percent: number })
      ipcRenderer.on('downloads:track-progress', wrapped)
      return () => ipcRenderer.removeListener('downloads:track-progress', wrapped)
    }
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openPath: (target: string) => ipcRenderer.invoke('app:openPath', target)
  },
  // Frameless-window controls. The native chrome is hidden in main,
  // so the renderer's custom titlebar buttons drive these.
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    // Push from main on maximize/unmaximize (including OS-driven
    // changes like Aero snap or double-click on the drag region) so
    // the maximize/restore button can swap its icon.
    onMaximizeChanged: (cb: (isMax: boolean) => void) => {
      const wrapped = (_e: unknown, isMax: unknown): void => cb(!!isMax)
      ipcRenderer.on('window:maximize-changed', wrapped)
      return () => ipcRenderer.removeListener('window:maximize-changed', wrapped)
    }
  },
  updater: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onEvent: (cb: (e: unknown) => void) => {
      const wrapped = (_e: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('update:event', wrapped)
      return () => ipcRenderer.removeListener('update:event', wrapped)
    }
  },
  settings: {
    getDefaultTab: () => ipcRenderer.invoke('settings:getDefaultTab'),
    setDefaultTab: (tab: 'home' | 'search' | 'library') =>
      ipcRenderer.invoke('settings:setDefaultTab', tab),
    getPinned: () => ipcRenderer.invoke('settings:getPinned'),
    togglePin: (item: { id: string; title: string; thumbnail: string }) =>
      ipcRenderer.invoke('settings:togglePin', item),
    updatePinSnapshot: (item: { id: string; title: string; thumbnail: string }) =>
      ipcRenderer.invoke('settings:updatePinSnapshot', item),
    getTheme: () => ipcRenderer.invoke('settings:getTheme'),
    setTheme: (theme: string) => ipcRenderer.invoke('settings:setTheme', theme),
    getLang: () => ipcRenderer.invoke('settings:getLang'),
    setLang: (lang: 'ru' | 'en') => ipcRenderer.invoke('settings:setLang', lang),
    getAudioQuality: () => ipcRenderer.invoke('settings:getAudioQuality'),
    setAudioQuality: (q: 'best' | 'medium' | 'low') =>
      ipcRenderer.invoke('settings:setAudioQuality', q),
    getShuffleMode: () => ipcRenderer.invoke('settings:getShuffleMode'),
    setShuffleMode: (on: boolean) => ipcRenderer.invoke('settings:setShuffleMode', on),
    getRepeatMode: () => ipcRenderer.invoke('settings:getRepeatMode'),
    setRepeatMode: (m: 'off' | 'one' | 'all') =>
      ipcRenderer.invoke('settings:setRepeatMode', m),
    getPlaylistOverride: (id: string) =>
      ipcRenderer.invoke('settings:getPlaylistOverride', id),
    setPlaylistOverride: (id: string, override: unknown) =>
      ipcRenderer.invoke('settings:setPlaylistOverride', id, override)
  },
  // Last-playing track + queue + position. Resume-on-launch is wired
  // around these three IPCs.
  session: {
    get: () => ipcRenderer.invoke('session:get'),
    set: (s: unknown) => ipcRenderer.invoke('session:set', s),
    clear: () => ipcRenderer.invoke('session:clear')
  },
  debug: {
    harvestTokens: () => ipcRenderer.invoke('debug:harvest-tokens'),
    browseViaPage: (browseId: string) => ipcRenderer.invoke('debug:browse-via-page', browseId),
    saveBrowse: (browseId: string) => ipcRenderer.invoke('debug:save-browse', browseId)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore — fallback path when context isolation is disabled
  window.api = api
}
