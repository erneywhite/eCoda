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
    playlist: (id: string) => ipcRenderer.invoke('metadata:playlist', id)
  },
  library: {
    prepare: () => ipcRenderer.invoke('library:prepare')
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
