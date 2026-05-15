export interface ResolvedAudio {
  title: string
  format: string
  streamUrl: string
}

export interface DetectedBrowser {
  id: string
  name: string
}

export interface SearchResult {
  id: string
  title: string
  artist: string
  duration: string
  thumbnail: string
}

export type HomeItemType = 'playlist' | 'album' | 'song' | 'video' | 'artist'

export interface HomeItem {
  id: string
  type: HomeItemType
  title: string
  subtitle: string
  thumbnail: string
}

export interface HomeSection {
  title: string
  items: HomeItem[]
}

export interface PlaylistView {
  title: string
  subtitle: string
  thumbnail: string
  tracks: SearchResult[]
}

export interface EcodaApi {
  resolveAudio: (input: string) => Promise<ResolvedAudio>
  prefetchAudio: (ids: string[]) => Promise<boolean>
  auth: {
    browsers: () => Promise<DetectedBrowser[]>
    status: () => Promise<string | null>
    connect: (browser: string) => Promise<boolean>
    disconnect: () => Promise<boolean>
    openYouTube: () => Promise<boolean>
  }
  metadata: {
    search: (query: string) => Promise<SearchResult[]>
    home: () => Promise<HomeSection[]>
    playlist: (id: string) => Promise<PlaylistView>
  }
  library: {
    prepare: () => Promise<{ ok: true; cookies: number } | { ok: false; error: string }>
  }
}

declare global {
  interface Window {
    api: EcodaApi
  }
}
