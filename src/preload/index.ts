import { contextBridge } from 'electron'

// Renderer-facing API surface. Empty in Phase 0 — IPC bridges for stream
// extraction, downloads and the library get added here as we build them.
const api = {}

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
