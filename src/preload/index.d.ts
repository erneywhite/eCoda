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
  // True when this is a playlist row YT returned without a playable
  // videoId (deleted / region-blocked / Premium-only after the user
  // added it). UI renders it dimmed + non-clickable; player skips it.
  unavailable?: boolean
  // YT's unique per-playlist row id. Two rows of the same videoId in
  // the same playlist have different setVideoIds — used as the key for
  // pin / reshuffle / drag-reorder persistence so duplicate rows can
  // be pinned independently. Absent on non-playlist surfaces (search,
  // Home, Downloaded) where the rendering falls back to videoId.
  setVideoId?: string
  // Whether the user has liked this track. Sourced from the row's
  // `likeStatus` in the page-proxy response (most playlist rows carry
  // it); forced to true for Liked Music. Drives the inline heart
  // toggle in the renderer.
  liked?: boolean
  // ChannelId ("UC…") of the primary artist on the row. Lets the
  // renderer make the artist line a clickable link into the artist
  // view. Absent on rows where YT didn't return a navigation endpoint.
  artistId?: string
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
  // Album-specific extras — present when the browseId resolved to an
  // album (MPRE… / OLAK…). The renderer uses these for header polish
  // (Album label, year line, clickable artist link).
  isAlbum?: boolean
  year?: string
  artistName?: string
  artistId?: string
}

export interface ArtistView {
  title: string
  subtitle: string
  thumbnail: string
  songs: SearchResult[]
  sections: HomeSection[]
}

export interface PinnedPlaylist {
  id: string
  title: string
  thumbnail: string
}

export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string; releaseNotes?: string | null }
  | { kind: 'not-available'; currentVersion: string }
  | { kind: 'progress'; percent: number; transferred: number; total: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

export type Lang = 'ru' | 'en'

export type AudioQuality = 'best' | 'medium' | 'low'

export type RepeatMode = 'off' | 'one' | 'all'

export interface PlaylistOverride {
  order: string[]
  pinned: string[]
  prependOnAdd?: boolean
}

export type Theme =
  | 'purple'
  | 'cyan'
  | 'sunset'
  | 'forest'
  | 'crimson'
  | 'mono'
  | 'ocean'
  | 'neon'

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
  errorReason?: string
}

export interface SessionTrack {
  id: string
  title: string
  artist: string
  thumbnail: string
  duration?: string
}

export interface LastSession {
  track: SessionTrack
  sourceList: SessionTrack[]
  sourceListId?: string
  sourceListTitle?: string
  currentTime: number
}

export interface CacheVerifyResult {
  manifestEntries: number
  filesOnDisk: number
  removedDeadEntries: number
  recoveredOrphans: number
  totalAfter: number
}

export interface DownloadManySummary {
  ok: number
  failed: Array<{ videoId: string; title: string; reason: string }>
}

export interface DownloadsPlaylistView {
  title: string
  subtitle: string
  thumbnail: string
  totalBytes: number
  tracks: Array<{
    id: string
    title: string
    artist: string
    duration: string
    thumbnail: string
    sizeBytes: number
  }>
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
    onRefreshed: (cb: () => void) => () => void
  }
  metadata: {
    search: (query: string) => Promise<SearchResult[]>
    home: () => Promise<HomeSection[]>
    playlist: (id: string) => Promise<PlaylistView>
    libraryPlaylists: () => Promise<HomeSection>
    like: (videoId: string, like: boolean) => Promise<boolean>
    radio: (videoId: string) => Promise<SearchResult[]>
    artist: (channelId: string) => Promise<ArtistView>
  }
  library: {
    prepare: () => Promise<{ ok: true; cookies: number } | { ok: false; error: string }>
  }
  downloads: {
    status: (ids: string[]) => Promise<string[]>
    list: () => Promise<DownloadedTrack[]>
    stats: () => Promise<{ tracks: number; bytes: number }>
    track: (info: DownloadInfo) => Promise<DownloadedTrack>
    playlist: (tracks: DownloadInfo[]) => Promise<DownloadManySummary>
    delete: (videoId: string) => Promise<boolean>
    clearAll: () => Promise<number>
    verify: () => Promise<CacheVerifyResult>
    asPlaylist: () => Promise<DownloadsPlaylistView>
    cancel: (videoId: string) => Promise<boolean>
    cancelAll: () => Promise<void>
    onProgress: (cb: (p: DownloadProgress) => void) => () => void
    onTrackProgress: (cb: (p: { videoId: string; percent: number }) => void) => () => void
  }
  app: {
    info: () => Promise<{
      name: string
      version: string
      userData: string
      logPath: string
      repoUrl: string
    }>
    openPath: (target: string) => Promise<boolean>
  }
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    isMaximized: () => Promise<boolean>
    onMaximizeChanged: (cb: (isMax: boolean) => void) => () => void
  }
  updater: {
    check: () => Promise<boolean>
    download: () => Promise<void>
    install: () => Promise<boolean>
    onEvent: (cb: (e: UpdaterEvent) => void) => () => void
  }
  settings: {
    getDefaultTab: () => Promise<'home' | 'search' | 'library'>
    setDefaultTab: (tab: 'home' | 'search' | 'library') => Promise<void>
    getPinned: () => Promise<PinnedPlaylist[]>
    togglePin: (item: PinnedPlaylist) => Promise<boolean>
    updatePinSnapshot: (item: PinnedPlaylist) => Promise<void>
    getTheme: () => Promise<Theme>
    setTheme: (theme: Theme) => Promise<void>
    getLang: () => Promise<Lang>
    setLang: (lang: Lang) => Promise<void>
    getAudioQuality: () => Promise<AudioQuality>
    setAudioQuality: (q: AudioQuality) => Promise<void>
    getShuffleMode: () => Promise<boolean>
    setShuffleMode: (on: boolean) => Promise<void>
    getRepeatMode: () => Promise<RepeatMode>
    setRepeatMode: (m: RepeatMode) => Promise<void>
    getPlaylistOverride: (id: string) => Promise<PlaylistOverride | null>
    setPlaylistOverride: (id: string, override: PlaylistOverride | null) => Promise<void>
  }
  session: {
    get: () => Promise<LastSession | null>
    set: (s: LastSession) => Promise<void>
    clear: () => Promise<void>
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
