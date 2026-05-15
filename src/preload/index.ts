import { contextBridge, ipcRenderer } from 'electron'

const api = {
  resolveAudio: (input: string) => ipcRenderer.invoke('audio:resolve', input),
  prefetchAudio: (ids: string[]) => ipcRenderer.invoke('audio:prefetch', ids),
  auth: {
    browsers: () => ipcRenderer.invoke('auth:browsers'),
    status: () => ipcRenderer.invoke('auth:status'),
    connect: (browser: string) => ipcRenderer.invoke('auth:connect', browser),
    disconnect: () => ipcRenderer.invoke('auth:disconnect'),
    openYouTube: () => ipcRenderer.invoke('auth:open-youtube')
  },
  metadata: {
    search: (query: string) => ipcRenderer.invoke('metadata:search', query),
    home: () => ipcRenderer.invoke('metadata:home'),
    playlist: (id: string) => ipcRenderer.invoke('metadata:playlist', id),
    libraryPlaylists: () => ipcRenderer.invoke('metadata:library-playlists')
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
    // The renderer subscribes once at mount; the unsubscribe function is
    // returned so $effect-style teardown can remove the listener cleanly.
    onProgress: (
      cb: (p: { done: number; total: number; videoId: string; title: string; errored: boolean }) => void
    ) => {
      const wrapped = (_event: unknown, payload: unknown) =>
        cb(payload as { done: number; total: number; videoId: string; title: string; errored: boolean })
      ipcRenderer.on('downloads:progress', wrapped)
      return () => ipcRenderer.removeListener('downloads:progress', wrapped)
    }
  },
  app: {
    info: () => ipcRenderer.invoke('app:info')
  },
  settings: {
    getDefaultTab: () => ipcRenderer.invoke('settings:getDefaultTab'),
    setDefaultTab: (tab: 'home' | 'search' | 'library') =>
      ipcRenderer.invoke('settings:setDefaultTab', tab),
    getPinned: () => ipcRenderer.invoke('settings:getPinned'),
    togglePin: (item: { id: string; title: string; thumbnail: string }) =>
      ipcRenderer.invoke('settings:togglePin', item),
    updatePinSnapshot: (item: { id: string; title: string; thumbnail: string }) =>
      ipcRenderer.invoke('settings:updatePinSnapshot', item)
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
