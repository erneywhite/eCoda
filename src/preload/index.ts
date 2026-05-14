import { contextBridge, ipcRenderer } from 'electron'

const api = {
  resolveAudio: (input: string) => ipcRenderer.invoke('audio:resolve', input)
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
