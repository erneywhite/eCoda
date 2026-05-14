export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

export interface DetectedBrowser {
  id: string
  name: string
}

export interface EcodaApi {
  resolveAudio: (input: string) => Promise<ResolvedAudio>
  auth: {
    browsers: () => Promise<DetectedBrowser[]>
    status: () => Promise<string | null>
    connect: (browser: string) => Promise<boolean>
    disconnect: () => Promise<boolean>
    openYouTube: () => Promise<boolean>
  }
}

declare global {
  interface Window {
    api: EcodaApi
  }
}
