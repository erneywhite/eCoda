export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

export interface EcodaApi {
  resolveAudio: (input: string) => Promise<ResolvedAudio>
}

declare global {
  interface Window {
    api: EcodaApi
  }
}
