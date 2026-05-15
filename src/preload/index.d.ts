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

export interface DownloadInfo {
  videoId: string
  title: string
  artist: string
  thumbnail: string
}

export interface DownloadedTrack {
  videoId: string
  title: string
  artist: string
  thumbnail: string
  ext: string
  sizeBytes: number
  downloadedAt: number
}

export interface DownloadProgress {
  done: number
  total: number
  videoId: string
  title: string
  errored: boolean
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
    libraryPlaylists: () => Promise<HomeSection>
  }
  library: {
    prepare: () => Promise<{ ok: true; cookies: number } | { ok: false; error: string }>
  }
  downloads: {
    status: (ids: string[]) => Promise<string[]>
    list: () => Promise<DownloadedTrack[]>
    track: (info: DownloadInfo) => Promise<DownloadedTrack>
    playlist: (tracks: DownloadInfo[]) => Promise<boolean>
    delete: (videoId: string) => Promise<boolean>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
  }
  debug: {
    harvestTokens: () => Promise<unknown>
    browseViaPage: (browseId: string) => Promise<unknown>
    saveBrowse: (browseId: string) => Promise<{ ok: true; file: string } | { ok: false; error: string }>
  }
}

declare global {
  interface Window {
    api: EcodaApi
  }
}
