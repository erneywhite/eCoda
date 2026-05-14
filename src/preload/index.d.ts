export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

export interface EcodaApi {
  resolveAudio: (input: string) => Promise<ResolvedAudio>
  auth: {
    status: () => Promise<boolean>
    login: () => Promise<boolean>
    logout: () => Promise<boolean>
  }
}

declare global {
  interface Window {
    api: EcodaApi
  }
}
