<script lang="ts">
  import { onMount, tick } from 'svelte'
  import wordmark from './assets/wordmark.png'
  import { translate, LANG_LABELS, type Lang } from './i18n'
  import type {
    CacheVerifyResult,
    DownloadProgress,
    HomeItem,
    HomeSection,
    LastSession,
    PinnedPlaylist,
    PlaylistOverride,
    PlaylistView,
    RepeatMode,
    SearchResult,
    SessionTrack,
    Theme,
    UpdaterEvent
  } from '../../preload/index.d'

  type View = 'home' | 'search' | 'playlist' | 'library' | 'settings'
  type PlayStatus = 'idle' | 'resolving' | 'playing' | 'error'

  // ---- auth state -----------------------------------------------------------
  let connectedBrowser = $state<string | null>(null)
  let browsers = $state<{ id: string; name: string }[]>([])
  let connecting = $state<string | null>(null)
  let connectError = $state('')

  // ---- navigation -----------------------------------------------------------
  // Browser-style back/forward over a history stack of HistoryEntry. The
  // `view` variable is derived from the current entry but we keep it as
  // a $state for the existing template to read.
  type HistoryEntry =
    | { kind: 'home' }
    | { kind: 'search' }
    | { kind: 'library' }
    | { kind: 'playlist'; id: string }
    | { kind: 'settings' }

  let view = $state<View>('home')
  let historyStack = $state<HistoryEntry[]>([{ kind: 'home' }])
  let historyIndex = $state(0)

  const canBack = $derived(historyIndex > 0)
  const canForward = $derived(historyIndex < historyStack.length - 1)

  // Push a new entry. Discards any forward history (matching browser
  // semantics — once you navigate from a back-stack point, the forward
  // trail is gone). No-op if the entry is identical to the current one
  // so re-clicking the active sidebar tab doesn't pile up dupes.
  function navigate(entry: HistoryEntry): void {
    const current = historyStack[historyIndex]
    if (
      current &&
      current.kind === entry.kind &&
      (entry.kind !== 'playlist' || current.kind === 'playlist' && current.id === entry.id)
    ) {
      applyEntry(entry)
      return
    }
    historyStack = [...historyStack.slice(0, historyIndex + 1), entry]
    historyIndex = historyStack.length - 1
    applyEntry(entry)
  }

  function goBack(): void {
    if (!canBack) return
    historyIndex--
    applyEntry(historyStack[historyIndex])
  }

  function goForward(): void {
    if (!canForward) return
    historyIndex++
    applyEntry(historyStack[historyIndex])
  }

  function applyEntry(entry: HistoryEntry): void {
    view = entry.kind
    if (entry.kind === 'home') {
      if (!homeSections && !homeLoading) void loadHome()
    } else if (entry.kind === 'library') {
      if (!libraryPlaylists && !libraryLoading) void loadLibraryData()
    } else if (entry.kind === 'playlist') {
      // If we're returning to a playlist we already loaded, the existing
      // playlistView is what we want. Only re-fetch when navigating to a
      // different id. Downloaded is the exception — it's a synthetic
      // virtual playlist whose contents may have changed between visits
      // (user downloaded/deleted tracks elsewhere), so always refresh.
      if (entry.id === DOWNLOADED_ID || openPlaylistId !== entry.id) {
        void loadPlaylistData(entry.id)
      }
    } else if (entry.kind === 'settings') {
      void loadSettings()
    }
  }

  // ---- home view ------------------------------------------------------------
  let homeSections = $state<HomeSection[] | null>(null)
  let homeLoading = $state(false)
  let homeError = $state('')

  // ---- search view ----------------------------------------------------------
  let query = $state('')
  let searching = $state(false)
  let searchError = $state('')
  let searchResults = $state<SearchResult[]>([])
  let searched = $state(false)

  // ---- playlist view --------------------------------------------------------
  // Special id for the synthetic "Downloaded" virtual playlist. Anything
  // that compares against this constant is doing the right thing — the
  // value just needs to be unique vs every InnerTube playlist id.
  const DOWNLOADED_ID = 'DOWNLOADED'
  function isDownloadedId(id: string | null): boolean {
    return id === DOWNLOADED_ID
  }

  let openPlaylistId = $state<string | null>(null)
  let playlistView = $state<PlaylistView | null>(null)
  let playlistLoading = $state(false)
  let playlistError = $state('')

  // ---- per-playlist override state (reshuffle / pin / drag) --------------
  // Set of pinned row-ids in the currently-open playlist. Rows live in
  // this set by their unique key (setVideoId, falling back to videoId
  // for surfaces without setVideoId — e.g. the Downloaded virtual list).
  // Reshuffle leaves pinned rows where they are and reflows the rest.
  // Re-loaded from config on every playlist open.
  let playlistPinned = $state<Set<string>>(new Set())
  // True when the open playlist has a saved override (the user has
  // reshuffled / dragged / pinned at some point). Drives the visibility
  // of the "Reset to default order" button — no point showing it when
  // YT's natural order is already what's on screen.
  let hasPlaylistOverride = $state(false)
  // Drag state for the playlist track list. dragIndex = the index of
  // the row being dragged; dragOverIndex = the row currently under the
  // cursor (used to render a visual drop indicator).
  let dragIndex = $state<number | null>(null)
  let dragOverIndex = $state<number | null>(null)

  // The key used to identify a row in pin / order persistence. For YT
  // playlists this is the row-id YT itself uses; for the Downloaded
  // virtual playlist where setVideoId isn't available, fall back to
  // videoId — duplicates in Downloaded would have collapsed already
  // during the manifest's videoId-keyed dedup, so this is safe.
  function rowKey(t: SearchResult): string {
    return t.setVideoId || t.id
  }

  // Playlists that show newest-first by nature — when YT adds a row,
  // it should land at the TOP of our stored order, not the bottom.
  // Library card "Liked Music" sorts newest like first; our Downloaded
  // virtual playlist sorts newest download first.
  function isPrependPlaylist(id: string | null): boolean {
    return id != null && (isLikedMusicId(id) || isDownloadedId(id))
  }

  // Applies a stored override to YT's natural track list. Drops rows
  // YT no longer returns (track was removed from the playlist) and
  // injects rows YT returns but the override hasn't seen yet (track
  // was added). New rows go to the top for prepend-lists, to the
  // bottom otherwise.
  function applyOverride(
    ytTracks: SearchResult[],
    override: PlaylistOverride | null,
    playlistId: string | null
  ): SearchResult[] {
    if (!override) return ytTracks
    const ytByKey = new Map<string, SearchResult>()
    for (const t of ytTracks) ytByKey.set(rowKey(t), t)

    // Walk override.order, dropping entries no longer in YT.
    const ordered: SearchResult[] = []
    const orderedKeys = new Set<string>()
    for (const k of override.order) {
      const t = ytByKey.get(k)
      if (t) {
        ordered.push(t)
        orderedKeys.add(k)
      }
    }
    // New rows YT returned that the override doesn't have yet.
    const added: SearchResult[] = []
    for (const t of ytTracks) {
      if (!orderedKeys.has(rowKey(t))) added.push(t)
    }
    return isPrependPlaylist(playlistId) ? [...added, ...ordered] : [...ordered, ...added]
  }

  // Builds a PlaylistOverride from the current display order + pinned set.
  // Stored on every action that changes the order (reshuffle / pin /
  // drag) so the next playlist open reproduces what the user saw.
  async function savePlaylistOverride(): Promise<void> {
    if (!openPlaylistId || !playlistView) return
    const order = playlistView.tracks.map(rowKey)
    const pinned = order.filter((k) => playlistPinned.has(k))
    const prependOnAdd = isPrependPlaylist(openPlaylistId)
    try {
      await window.api.settings.setPlaylistOverride(openPlaylistId, {
        order,
        pinned,
        prependOnAdd
      })
      hasPlaylistOverride = true
    } catch (err) {
      console.warn('savePlaylistOverride failed', err)
    }
  }

  // Drop the override entirely for the currently-open playlist. Next
  // load (which we trigger here) shows YT's natural order, fresh. The
  // confirm dialog guards against accidentally throwing away pins +
  // reshuffles that took the streamer hours to set up.
  async function resetPlaylistOrder(): Promise<void> {
    if (!openPlaylistId || !hasPlaylistOverride) return
    const ok = await askConfirm(t('playlist.resetConfirm'), { danger: true })
    if (!ok) return
    const id = openPlaylistId
    try {
      await window.api.settings.setPlaylistOverride(id, null)
    } catch (err) {
      console.warn('resetPlaylistOrder failed', err)
      return
    }
    hasPlaylistOverride = false
    playlistPinned = new Set()
    // Force loadPlaylistData to re-fetch (it short-circuits when
    // openPlaylistId matches the id arg, but the Downloaded virtual
    // playlist always re-fetches anyway and YT playlists are cheap
    // enough on the page-proxy).
    openPlaylistId = null
    await loadPlaylistData(id)
    syncPlayingSourceList()
  }

  // Fisher-Yates over the non-pinned subset, then reassemble with
  // pinned rows back at their original indices. The streamer's intro
  // stays at position 0 across reshuffles as long as it's pinned.
  function reshuffleTracks(tracks: SearchResult[], pinned: Set<string>): SearchResult[] {
    const pinnedByIndex = new Map<number, SearchResult>()
    const unpinned: SearchResult[] = []
    tracks.forEach((t, i) => {
      if (pinned.has(rowKey(t))) pinnedByIndex.set(i, t)
      else unpinned.push(t)
    })
    // Fisher-Yates on the unpinned slice.
    for (let i = unpinned.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[unpinned[i], unpinned[j]] = [unpinned[j], unpinned[i]]
    }
    const result: SearchResult[] = new Array(tracks.length)
    let cursor = 0
    for (let i = 0; i < tracks.length; i++) {
      if (pinnedByIndex.has(i)) result[i] = pinnedByIndex.get(i)!
      else result[i] = unpinned[cursor++]
    }
    return result
  }

  // ---- theme system (colour palettes) -------------------------------------
  // Each palette is a small map of CSS variables. applyTheme() writes them
  // to :root so every existing var(--accent), var(--accent-rgb), etc in
  // the stylesheet swaps in one place.
  interface ThemeDef {
    label: string
    accent: string
    accent2: string
    accentRgb: string // "201, 125, 246" — used in rgba() wrappers
    aurora1: string
    aurora2: string
    aurora3: string
    swatch: string // gradient string for the picker dot
  }
  const THEMES: Record<Theme, ThemeDef> = {
    purple: {
      label: 'Фиолетовая',
      accent: '#c97df6',
      accent2: '#ff6dc8',
      accentRgb: '201, 125, 246',
      aurora1: 'rgba(201, 125, 246, 0.32)',
      aurora2: 'rgba(255, 109, 200, 0.18)',
      aurora3: 'rgba(80, 110, 255, 0.14)',
      swatch: 'linear-gradient(135deg, #c97df6, #ff6dc8)'
    },
    cyan: {
      label: 'Кибер-циан',
      accent: '#7df9ff',
      accent2: '#4ecdc4',
      accentRgb: '125, 249, 255',
      aurora1: 'rgba(125, 249, 255, 0.28)',
      aurora2: 'rgba(78, 205, 196, 0.18)',
      aurora3: 'rgba(100, 200, 220, 0.14)',
      swatch: 'linear-gradient(135deg, #7df9ff, #4ecdc4)'
    },
    sunset: {
      label: 'Закат',
      accent: '#ff8a5b',
      accent2: '#ffd166',
      accentRgb: '255, 138, 91',
      aurora1: 'rgba(255, 138, 91, 0.30)',
      aurora2: 'rgba(255, 209, 102, 0.18)',
      aurora3: 'rgba(255, 100, 60, 0.14)',
      swatch: 'linear-gradient(135deg, #ff8a5b, #ffd166)'
    },
    forest: {
      label: 'Лесная',
      accent: '#a8e063',
      accent2: '#56ab2f',
      accentRgb: '168, 224, 99',
      aurora1: 'rgba(168, 224, 99, 0.24)',
      aurora2: 'rgba(86, 171, 47, 0.18)',
      aurora3: 'rgba(60, 140, 80, 0.14)',
      swatch: 'linear-gradient(135deg, #a8e063, #56ab2f)'
    },
    crimson: {
      label: 'Кровавая',
      accent: '#ff4f6b',
      accent2: '#ff8a9c',
      accentRgb: '255, 79, 107',
      aurora1: 'rgba(255, 79, 107, 0.28)',
      aurora2: 'rgba(255, 138, 156, 0.18)',
      aurora3: 'rgba(200, 60, 100, 0.14)',
      swatch: 'linear-gradient(135deg, #ff4f6b, #ff8a9c)'
    },
    mono: {
      label: 'Монохром',
      accent: '#e5e5e5',
      accent2: '#a3a3a3',
      accentRgb: '229, 229, 229',
      aurora1: 'rgba(200, 200, 200, 0.14)',
      aurora2: 'rgba(150, 150, 150, 0.10)',
      aurora3: 'rgba(100, 100, 100, 0.08)',
      swatch: 'linear-gradient(135deg, #e5e5e5, #a3a3a3)'
    },
    ocean: {
      label: 'Океан',
      accent: '#4ea8de',
      accent2: '#1bb1ff',
      accentRgb: '78, 168, 222',
      aurora1: 'rgba(78, 168, 222, 0.28)',
      aurora2: 'rgba(27, 177, 255, 0.18)',
      aurora3: 'rgba(50, 100, 200, 0.14)',
      swatch: 'linear-gradient(135deg, #4ea8de, #1bb1ff)'
    },
    neon: {
      label: 'Розовый неон',
      accent: '#ff3d96',
      accent2: '#ff80b5',
      accentRgb: '255, 61, 150',
      aurora1: 'rgba(255, 61, 150, 0.30)',
      aurora2: 'rgba(255, 128, 181, 0.18)',
      aurora3: 'rgba(200, 50, 130, 0.14)',
      swatch: 'linear-gradient(135deg, #ff3d96, #ff80b5)'
    }
  }

  let theme = $state<Theme>('purple')

  function applyTheme(name: Theme): void {
    const t = THEMES[name] ?? THEMES.purple
    const r = document.documentElement.style
    r.setProperty('--accent', t.accent)
    r.setProperty('--accent-2', t.accent2)
    r.setProperty('--accent-rgb', t.accentRgb)
    r.setProperty('--aurora-1', t.aurora1)
    r.setProperty('--aurora-2', t.aurora2)
    r.setProperty('--aurora-3', t.aurora3)
  }

  async function changeTheme(name: Theme): Promise<void> {
    theme = name
    applyTheme(name)
    await window.api.settings.setTheme(name)
  }

  // ---- i18n (UI language) --------------------------------------------------
  // The translate helper is parameterised by `lang`; calling t() inside
  // the template re-evaluates whenever lang changes, so flipping the
  // switcher updates every visible string instantly.
  let lang = $state<Lang>('ru')
  function t(key: string, vars?: Record<string, string | number>): string {
    return translate(lang, key, vars)
  }
  async function changeLang(next: Lang): Promise<void> {
    lang = next
    await window.api.settings.setLang(next)
    // Drop the locale-bound caches so the next visit to Home / Library /
    // a playlist re-fetches with the new hl/gl. Pinned snapshots stay
    // because they were saved by the user explicitly and might be in
    // either language.
    homeSections = null
    libraryPlaylists = null
    playlistView = null
    openPlaylistId = null
    // If the user is currently looking at any of those views, reload now.
    if (view === 'home') void loadHome()
    else if (view === 'library') void loadLibraryData()
  }

  // ---- updater state -------------------------------------------------------
  // updaterStatus drives the "Обновления" Settings card. Stays at 'idle'
  // until either silentCheckOnStartup or a user click pushes an event.
  type UpdaterStatus =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'available'; version: string }
    | { kind: 'not-available' }
    | { kind: 'downloading'; percent: number }
    | { kind: 'downloaded'; version: string }
    | { kind: 'error'; message: string }

  let updaterStatus = $state<UpdaterStatus>({ kind: 'idle' })

  function handleUpdaterEvent(e: UpdaterEvent): void {
    if (e.kind === 'checking') updaterStatus = { kind: 'checking' }
    else if (e.kind === 'available') updaterStatus = { kind: 'available', version: e.version }
    else if (e.kind === 'not-available') updaterStatus = { kind: 'not-available' }
    else if (e.kind === 'progress')
      updaterStatus = { kind: 'downloading', percent: Math.round(e.percent) }
    else if (e.kind === 'downloaded') updaterStatus = { kind: 'downloaded', version: e.version }
    else if (e.kind === 'error') updaterStatus = { kind: 'error', message: e.message }
  }

  async function checkForUpdate(): Promise<void> {
    await window.api.updater.check()
  }
  async function downloadUpdate(): Promise<void> {
    await window.api.updater.download()
  }
  async function installUpdate(): Promise<void> {
    await window.api.updater.install()
  }

  // ---- pinned playlists (sidebar shortcuts under Library) ------------------
  let pinnedPlaylists = $state<PinnedPlaylist[]>([])

  async function loadPinned(): Promise<void> {
    pinnedPlaylists = await window.api.settings.getPinned()
  }

  function isPinned(id: string | null): boolean {
    if (!id) return false
    return pinnedPlaylists.some((p) => p.id === id)
  }
  function isLikedMusicId(id: string | null): boolean {
    return id === 'LM' || id === 'VLLM'
  }

  // Pin or unpin the currently-open playlist. Liked Music is special — it's
  // always pinned, so the button hides on that view.
  async function togglePinCurrent(): Promise<void> {
    if (!playlistView || !openPlaylistId) return
    if (isLikedMusicId(openPlaylistId)) return
    await window.api.settings.togglePin({
      id: openPlaylistId,
      title: playlistView.title || 'Без названия',
      thumbnail: playlistView.thumbnail || ''
    })
    await loadPinned()
  }

  // Toggle a playlist's pin straight from a Library card-tile, without
  // opening the playlist. Liked Music is no-op (always pinned).
  async function togglePinFromItem(item: HomeItem): Promise<void> {
    if (item.type !== 'playlist' && item.type !== 'album') return
    if (isLikedMusicId(item.id)) return
    await window.api.settings.togglePin({
      id: item.id,
      title: item.title,
      thumbnail: item.thumbnail
    })
    await loadPinned()
  }

  // ---- settings -----------------------------------------------------------
  let appInfo = $state<{
    name: string
    version: string
    userData: string
    logPath: string
    repoUrl: string
  } | null>(null)
  let cacheStats = $state<{ tracks: number; bytes: number } | null>(null)
  let clearingCache = $state(false)
  let defaultTab = $state<'home' | 'search' | 'library'>('home')
  // Diagnostics card state — Verify cache button + last result.
  let verifying = $state(false)
  let verifyResult = $state<CacheVerifyResult | null>(null)
  // Audio quality preset for new downloads. Defaults to 'best' on a
  // fresh install (handled by the IPC default).
  let audioQuality = $state<'best' | 'medium' | 'low'>('best')

  async function loadSettings(): Promise<void> {
    appInfo = await window.api.app.info()
    cacheStats = await window.api.downloads.stats()
    defaultTab = await window.api.settings.getDefaultTab()
    audioQuality = await window.api.settings.getAudioQuality()
  }

  async function changeAudioQuality(q: 'best' | 'medium' | 'low'): Promise<void> {
    audioQuality = q
    await window.api.settings.setAudioQuality(q)
  }

  async function verifyCacheAction(): Promise<void> {
    if (verifying) return
    verifying = true
    try {
      verifyResult = await window.api.downloads.verify()
      cacheStats = await window.api.downloads.stats()
    } finally {
      verifying = false
    }
  }

  function openInExplorer(target?: string): void {
    if (!target) return
    void window.api.app.openPath(target)
  }

  async function changeDefaultTab(tab: 'home' | 'search' | 'library'): Promise<void> {
    defaultTab = tab
    await window.api.settings.setDefaultTab(tab)
  }

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
  }

  async function clearCache(): Promise<void> {
    if (clearingCache) return
    const ok = await askConfirm(t('settings.cache.clearConfirm'), { danger: true })
    if (!ok) return
    clearingCache = true
    try {
      await window.api.downloads.clearAll()
      downloadedIds = new Set()
      cacheStats = await window.api.downloads.stats()
    } finally {
      clearingCache = false
    }
  }

  // ---- downloads (Phase 2: offline cache) ----------------------------------
  // We use SvelteSet via $state<Set<...>> so the UI reacts when items move
  // in and out of these sets.
  let downloadedIds = $state<Set<string>>(new Set())
  let downloadingIds = $state<Set<string>>(new Set())
  let bulkProgress = $state<{ done: number; total: number; currentTitle: string } | null>(null)
  // After a bulk download wraps up: how many succeeded, the list of tracks
  // that didn't, and an inline "Retry failed" affordance. Banner sits below
  // the bulk progress strip in the playlist header.
  let bulkResult = $state<{
    ok: number
    total: number
    failed: Array<{ videoId: string; title: string; reason: string }>
  } | null>(null)
  // Per-track error reasons captured during a bulk run so the playlist
  // rows can show a tooltip like "Sign in to confirm" next to the ✗ chip.
  let failedReasons = $state<Map<string, string>>(new Map())
  // Live download percentage (0–100) keyed by videoId. Populated from the
  // downloads:track-progress IPC stream; cleared once the track flips to
  // downloaded or fails. Drives the ring on each download chip.
  let downloadPercent = $state<Map<string, number>>(new Map())

  function handleTrackProgress(p: { videoId: string; percent: number }): void {
    const next = new Map(downloadPercent)
    next.set(p.videoId, p.percent)
    downloadPercent = next
  }

  function addDownloaded(id: string): void {
    const s = new Set(downloadedIds)
    s.add(id)
    downloadedIds = s
  }
  function removeDownloaded(id: string): void {
    const s = new Set(downloadedIds)
    s.delete(id)
    downloadedIds = s
  }
  function setDownloading(id: string, value: boolean): void {
    const s = new Set(downloadingIds)
    if (value) s.add(id)
    else s.delete(id)
    downloadingIds = s
  }

  async function refreshDownloadStatus(tracks: SearchResult[]): Promise<void> {
    if (tracks.length === 0) return
    const ids = tracks.map((t) => t.id)
    const got = await window.api.downloads.status(ids)
    const s = new Set(downloadedIds)
    for (const id of got) s.add(id)
    downloadedIds = s
  }

  // For a downloaded track we prefer the locally cached thumbnail so the UI
  // stops looking patchy when Google's CDN throttles us. For not-yet-
  // downloaded tracks we fall back to the original URL from InnerTube.
  function thumbnailFor(id: string, fallback: string): string {
    return downloadedIds.has(id) ? `media://thumb/${id}` : fallback
  }

  async function toggleTrackDownload(track: SearchResult): Promise<void> {
    // Clicking ↓ while it's already downloading = cancel. Clear the
    // busy + percent state IMMEDIATELY so the chip flips back to the
    // idle ↓ without waiting for yt-dlp's kill→close round-trip (which
    // takes 100-300ms and was making the cancel feel laggy). The IPC
    // call kills the process; the eventual reject lands in the catch
    // below and is harmless because finally is a no-op on already-clear
    // state.
    if (downloadingIds.has(track.id)) {
      setDownloading(track.id, false)
      if (downloadPercent.has(track.id)) {
        const next = new Map(downloadPercent)
        next.delete(track.id)
        downloadPercent = next
      }
      void window.api.downloads.cancel(track.id)
      return
    }
    if (downloadedIds.has(track.id)) {
      // already downloaded → delete
      const ok = await window.api.downloads.delete(track.id)
      if (ok) {
        removeDownloaded(track.id)
        // When the user is looking AT the Downloaded virtual playlist
        // and removes a track from it, refresh the list so the row
        // disappears (and the count + size in the subtitle update).
        if (isDownloadedId(openPlaylistId)) {
          void loadPlaylistData(DOWNLOADED_ID)
        }
      }
      return
    }
    setDownloading(track.id, true)
    try {
      await window.api.downloads.track({
        videoId: track.id,
        title: track.title,
        artist: track.artist,
        thumbnail: track.thumbnail
      })
      addDownloaded(track.id)
    } catch (err) {
      console.warn('download failed', err)
    } finally {
      setDownloading(track.id, false)
    }
  }

  // Cancel the in-flight bulk download (playlist Download N). Tells main
  // to kill the running yt-dlp + stop dispatching more tracks. Already-
  // downloaded ones stay; the progress chip's "cancel" tooltip explains.
  // Clears bulkProgress + the per-track percent stream IMMEDIATELY for
  // instant UI feedback — the bulk IPC promise still completes in the
  // background (after the kill takes effect) and writes bulkResult with
  // whatever partial count it got, but the user doesn't have to wait
  // 100-300ms staring at a spinner they're trying to dismiss.
  function cancelBulkDownload(): void {
    void window.api.downloads.cancelAll()
    bulkProgress = null
    downloadPercent = new Map()
  }

  async function downloadCurrentPlaylist(): Promise<void> {
    if (!playlistView || bulkProgress) return
    const pending = playlistView.tracks.filter((t) => !downloadedIds.has(t.id))
    if (pending.length === 0) return
    await runBulkDownload(pending)
  }

  async function runBulkDownload(tracks: SearchResult[]): Promise<void> {
    bulkProgress = { done: 0, total: tracks.length, currentTitle: '' }
    bulkResult = null
    // Reset per-track error map for fresh failures only — old ones from
    // other batches still appear on their original rows.
    for (const t of tracks) {
      const next = new Map(failedReasons)
      next.delete(t.id)
      failedReasons = next
    }
    try {
      const summary = await window.api.downloads.playlist(
        tracks.map((t) => ({
          videoId: t.id,
          title: t.title,
          artist: t.artist,
          thumbnail: t.thumbnail
        }))
      )
      bulkResult = { ok: summary.ok, total: tracks.length, failed: summary.failed }
    } catch (err) {
      console.warn('bulk download failed', err)
      bulkResult = {
        ok: 0,
        total: tracks.length,
        failed: tracks.map((t) => ({
          videoId: t.id,
          title: t.title,
          reason: err instanceof Error ? err.message : String(err)
        }))
      }
    } finally {
      bulkProgress = null
    }
  }

  async function retryFailedDownloads(): Promise<void> {
    if (!playlistView || !bulkResult || bulkProgress) return
    const failedIds = new Set(bulkResult.failed.map((f) => f.videoId))
    const tracks = playlistView.tracks.filter((t) => failedIds.has(t.id))
    if (tracks.length === 0) return
    await runBulkDownload(tracks)
  }

  function handleDownloadProgress(p: DownloadProgress): void {
    if (!p.errored) {
      addDownloaded(p.videoId)
      if (failedReasons.has(p.videoId)) {
        const next = new Map(failedReasons)
        next.delete(p.videoId)
        failedReasons = next
      }
    } else if (p.errorReason) {
      const next = new Map(failedReasons)
      next.set(p.videoId, p.errorReason)
      failedReasons = next
    }
    // Whichever way it ended, this track is no longer in flight — drop
    // its live-percent entry so the ring goes away.
    if (downloadPercent.has(p.videoId)) {
      const next = new Map(downloadPercent)
      next.delete(p.videoId)
      downloadPercent = next
    }
    if (bulkProgress) bulkProgress = { done: p.done, total: p.total, currentTitle: p.title }
  }

  // ---- library view (Phase B: native via page-proxy) -----------------------
  // Single section "Мои плейлисты" for now. Tracks/Albums/Artists tabs go
  // here later. The page-proxy under the hood signs every InnerTube call
  // with SAPISIDHASH so the response is authenticated.
  let libraryPlaylists = $state<HomeSection | null>(null)
  let libraryLoading = $state(false)
  let libraryError = $state('')

  // ---- player ---------------------------------------------------------------
  let playing = $state<{
    id: string
    title: string
    artist: string
    format: string
    streamUrl: string
    thumbnail: string
    sourceList: SearchResult[]
    // Optional context — playlist id + title the track was launched from,
    // so the resume banner on next launch can render "from My Playlist".
    sourceListId?: string
    sourceListTitle?: string
  } | null>(null)
  let playStatus = $state<PlayStatus>('idle')
  let playError = $state('')
  let audioEl = $state<HTMLAudioElement>()
  // Mirror these from the <audio> element so the custom UI can render
  // controls. Bound via on:play/pause/timeupdate/etc.
  let isPlaying = $state(false)
  let currentTime = $state(0)
  let duration = $state(0)
  let volume = $state(1)
  let muted = $state(false)
  // While the user is dragging the seek bar we don't want the audio's
  // timeupdate to fight the slider position — pause the binding.
  let seeking = $state(false)
  // When a saved session is restored on launch, the player bar shows up
  // immediately with the right track + paused at the saved position —
  // no banner, no extra click. `playing.streamUrl` stays empty until the
  // user actually hits Play (which kicks off resolve + seek + start). The
  // saved position lives in pendingResumeTime; canplay reads it and seeks.
  let pendingResumeTime = $state<number | null>(null)

  // ---- shuffle / repeat / queue ------------------------------------------
  // Persisted in config so the streamer use case ("set my modes once, leave
  // them") survives restarts. Loaded from window.api.settings on mount.
  let shuffleMode = $state(false)
  let repeatMode = $state<RepeatMode>('off')
  // Explicit "play next / add to queue" list, EPHEMERAL — lives only in the
  // current session. When the current track ends we shift the head off
  // this queue before falling through to playNext on the sourceList. Same
  // queue is used regardless of where tracks were queued from (playlist,
  // search, downloaded). Reset on auth disconnect along with other player
  // state.
  let userQueue = $state<SearchResult[]>([])
  // Recent-played stack for shuffle prev — without it, shuffle-prev would
  // pick another random track which feels arbitrary. Capped at 50 to
  // avoid unbounded growth on long listening sessions.
  let playHistory = $state<SearchResult[]>([])
  const PLAY_HISTORY_CAP = 50

  // Throttle for "save session on timeupdate" — every 5 seconds while
  // playing is enough to recover within striking distance of where the
  // user actually left off. We piggy-back on the timeupdate handler so
  // we don't need a separate setInterval.
  let lastSessionSaveAt = 0
  const SESSION_SAVE_INTERVAL_MS = 5000

  // Builds a snapshot of the current player state and persists it. Called
  // on track change / pause / throttled timeupdate. No-op when nothing is
  // playing (the resume banner is cleared via clear() in disconnect()).
  function persistSession(timeOverride?: number): void {
    if (!playing) return
    const time = typeof timeOverride === 'number' ? timeOverride : currentTime
    // The playing object and SearchResult share enough shape that we can
    // narrow both into a SessionTrack with one helper.
    const trackOf = (t: {
      id: string
      title: string
      artist: string
      thumbnail: string
      duration?: string
    }): SessionTrack => ({
      id: t.id,
      title: t.title,
      artist: t.artist ?? '',
      thumbnail: t.thumbnail ?? '',
      duration: t.duration
    })
    const payload: LastSession = {
      track: trackOf(playing),
      sourceList: (playing.sourceList ?? []).map(trackOf),
      sourceListId: playing.sourceListId,
      sourceListTitle: playing.sourceListTitle,
      currentTime: Number.isFinite(time) ? time : 0
    }
    lastSessionSaveAt = Date.now()
    void window.api.session.set(payload).catch((err) => console.warn('session save failed', err))
  }

  function maybePersistSessionOnTime(): void {
    if (!playing) return
    if (Date.now() - lastSessionSaveAt < SESSION_SAVE_INTERVAL_MS) return
    persistSession()
  }

  // Hydrates `playing` from a saved LastSession WITHOUT resolving the
  // stream. The player bar appears with the right cover, title, artist
  // and seek-position; clicking Play triggers playTrack via togglePlay,
  // which resolves, seeks to pendingResumeTime, and starts audio.
  function hydrateDeferredSession(saved: LastSession): void {
    const list: SearchResult[] = (saved.sourceList ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      duration: t.duration ?? '',
      thumbnail: t.thumbnail
    }))
    const trackAsResult: SearchResult = {
      id: saved.track.id,
      title: saved.track.title,
      artist: saved.track.artist,
      duration: saved.track.duration ?? '',
      thumbnail: saved.track.thumbnail
    }
    playing = {
      id: trackAsResult.id,
      title: trackAsResult.title,
      artist: trackAsResult.artist,
      format: '',
      // Empty streamUrl is the "deferred resume" marker — togglePlay sees
      // this and routes a Play click into playTrack rather than audioEl.
      streamUrl: '',
      thumbnail: trackAsResult.thumbnail,
      sourceList: list.length > 0 ? list : [trackAsResult],
      sourceListId: saved.sourceListId,
      sourceListTitle: saved.sourceListTitle
    }
    pendingResumeTime = saved.currentTime > 1 ? saved.currentTime : null
    // Seed the UI clock to the saved position so the seek bar already
    // shows the right spot before audio actually loads.
    currentTime = Number.isFinite(saved.currentTime) ? saved.currentTime : 0
    duration = 0
    isPlaying = false
    playStatus = 'idle'
  }

  function fmtTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  // "5:30" → 330; "1:23:45" → 5025; bogus input → 0.
  function parseDuration(s: string): number {
    if (!s) return 0
    const parts = s.split(':').map((p) => Number(p))
    if (parts.some((n) => Number.isNaN(n))) return 0
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    return 0
  }

  // Russian plural picker — chooses one of three word forms based on the
  // count's last digit / last two digits. Standard "1 час / 2 часа / 5
  // часов" rules.
  function pluralRu(n: number, forms: [string, string, string]): string {
    const mod10 = n % 10
    const mod100 = n % 100
    if (mod10 === 1 && mod100 !== 11) return forms[0]
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1]
    return forms[2]
  }

  // Renders a total duration as "4 часа 26 минут" / "4 hours 26 minutes".
  // Below an hour we drop the "hours" segment entirely. Returns '' for 0
  // so the caller can hide the chip when the playlist has no durations
  // (e.g. the Downloaded virtual playlist, where the manifest doesn't
  // carry track durations).
  function formatTotalDuration(seconds: number, lng: Lang): string {
    if (seconds <= 0) return ''
    const totalMinutes = Math.max(1, Math.round(seconds / 60))
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    if (lng === 'ru') {
      const hourWord = pluralRu(hours, ['час', 'часа', 'часов'])
      const minWord = pluralRu(minutes, ['минута', 'минуты', 'минут'])
      if (hours > 0 && minutes > 0) return `${hours} ${hourWord} ${minutes} ${minWord}`
      if (hours > 0) return `${hours} ${hourWord}`
      return `${minutes} ${minWord}`
    }
    const hourWord = hours === 1 ? 'hour' : 'hours'
    const minWord = minutes === 1 ? 'minute' : 'minutes'
    if (hours > 0 && minutes > 0) return `${hours} ${hourWord} ${minutes} ${minWord}`
    if (hours > 0) return `${hours} ${hourWord}`
    return `${minutes} ${minWord}`
  }

  function togglePlay(): void {
    // Deferred-resume state: playing is hydrated but streamUrl is empty
    // (session restored on launch). First Play click kicks off the actual
    // resolve + seek + start via playTrack; canplay reads pendingResumeTime
    // and lands on the saved position.
    if (playing && !playing.streamUrl) {
      const t: SearchResult = {
        id: playing.id,
        title: playing.title,
        artist: playing.artist,
        duration: '',
        thumbnail: playing.thumbnail
      }
      void playTrack(t, playing.sourceList, {
        id: playing.sourceListId,
        title: playing.sourceListTitle
      })
      return
    }
    if (!audioEl) return
    if (audioEl.paused) audioEl.play().catch(() => {})
    else audioEl.pause()
  }

  // Two-handler seek interaction: oninput updates state for visual
  // thumb tracking + flips `seeking` to mute timeupdate's fight-back;
  // onchange commits the final value from the DOM (authoritative) to
  // audio. Reading e.currentTarget.value rather than relying on the
  // bound `currentTime` sidesteps Svelte 5's undefined-ordering when
  // bind:value runs alongside our own handlers.
  function onSeekInput(e: Event): void {
    seeking = true
    currentTime = Number((e.currentTarget as HTMLInputElement).value)
  }
  function onSeekCommit(e: Event): void {
    const v = Number((e.currentTarget as HTMLInputElement).value)
    if (audioEl && Number.isFinite(v)) {
      audioEl.currentTime = v
      currentTime = v
    }
    seeking = false
  }
  function onVolumeInput(e: Event): void {
    const v = Number((e.target as HTMLInputElement).value)
    volume = v
    if (audioEl) {
      audioEl.volume = v
      if (v > 0 && muted) {
        audioEl.muted = false
        muted = false
      }
    }
  }
  function toggleMute(): void {
    if (!audioEl) return
    audioEl.muted = !audioEl.muted
    muted = audioEl.muted
  }

  async function toggleShuffle(): Promise<void> {
    shuffleMode = !shuffleMode
    await window.api.settings.setShuffleMode(shuffleMode)
  }

  async function cycleRepeat(): Promise<void> {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off'
    await window.api.settings.setRepeatMode(repeatMode)
  }

  // ---- queue actions ------------------------------------------------------
  // Tracks landed via these two go to the user's explicit queue, which
  // takes priority over sourceList traversal in playNext(). Both call
  // showToast so the user gets confirmation that the action landed.
  function queuePlayNext(track: SearchResult): void {
    if (track.unavailable) return
    userQueue = [track, ...userQueue]
    showToast(t('toast.playNextAdded', { title: track.title }))
  }

  function queueAppend(track: SearchResult): void {
    if (track.unavailable) return
    userQueue = [...userQueue, track]
    showToast(t('toast.queueAdded', { title: track.title }))
  }

  // ---- toast notifications -----------------------------------------------
  // Single live toast at a time; new toast replaces the old. Auto-dismisses
  // after 2.5s. Used for queue actions; later phases can re-use it for
  // like/dislike feedback etc.
  let toast = $state<{ msg: string; ts: number } | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  function showToast(msg: string): void {
    toast = { msg, ts: Date.now() }
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast = null
      toastTimer = null
    }, 2500)
  }

  // ---- confirm dialog ----------------------------------------------------
  // Promise-based replacement for the browser's native confirm(). Native
  // confirm draws a Windows-themed prompt that breaks the app's glass /
  // aurora aesthetic; this one matches Settings cards.
  //
  // Usage:
  //   const ok = await askConfirm(t('playlist.resetConfirm'))
  //   if (!ok) return
  let confirmDialog = $state<{
    message: string
    confirmLabel: string
    cancelLabel: string
    danger: boolean
    resolve: (value: boolean) => void
  } | null>(null)

  function askConfirm(
    message: string,
    opts: { confirmLabel?: string; cancelLabel?: string; danger?: boolean } = {}
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      confirmDialog = {
        message,
        confirmLabel: opts.confirmLabel ?? t('confirm.ok'),
        cancelLabel: opts.cancelLabel ?? t('confirm.cancel'),
        danger: opts.danger ?? false,
        resolve
      }
    })
  }

  function closeConfirm(answer: boolean): void {
    const d = confirmDialog
    confirmDialog = null
    if (d) d.resolve(answer)
  }

  // ---- context menu ------------------------------------------------------
  // Floating right-click menu on track rows. Single shared state — at
  // most one menu open at a time. Closes on outside-click / ESC / item
  // pick. The menu's items are computed per-track (per call site) and
  // passed in via openCtxMenu so the same component handles playlist /
  // search / Downloaded / future surfaces.
  interface CtxMenuItem {
    label: string
    // SVG path string (24×24 viewBox, `fill="currentColor"`). Rendered
    // as a 16×16 icon at the left of the item. We pass the raw path
    // instead of an icon-name lookup so each surface that builds a
    // menu can use whatever shape it wants without a central registry.
    iconPath?: string
    danger?: boolean
    disabled?: boolean
    onSelect: () => void
  }
  interface CtxMenuState {
    x: number
    y: number
    items: CtxMenuItem[]
  }
  let ctxMenu = $state<CtxMenuState | null>(null)

  // Reusable Material-style icon path strings for context-menu items.
  // 24×24 viewBox, single-path. Mirror YT Music's vocabulary so users
  // get instant visual recognition.
  const CTX_ICONS = {
    // playlist_play — list of lines + right-pointing play arrow
    playNext: 'M3 10h11v2H3v-2zm0-4h11v2H3V6zm0 8h7v2H3v-2zm14-4v8l6-4-6-4z',
    // playlist_add — list of lines + plus
    addToQueue: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 14h8v2H2v-2zm19-3h-2V8h-2v3h-2v2h2v3h2v-3h2v-2z',
    // push_pin — slanted thumbtack (pinned indicator)
    pin: 'M16 9V4l1-1V1H7v2l1 1v5l-2 2v2h5v7l1 1 1-1v-7h5v-2l-2-2z',
    // push_pin outline — same pin shape but outline-only
    unpin: 'M14 4v5l2 2v2h-5v7l-1 1-1-1v-7H4v-2l2-2V4H4V2h14v2h-2zm-2 0H8v5l-2 2h10l-2-2V4z'
  }

  // Builds the context menu items for a track. sourceList lets actions
  // like "play next" find their position; sourceContext carries the
  // playlist id / title for the player bar's source-list tracking.
  function buildTrackMenu(
    track: SearchResult,
    sourceList: SearchResult[],
    sourceContext: { id?: string; title?: string }
  ): CtxMenuItem[] {
    const items: CtxMenuItem[] = []
    items.push({
      label: t('ctx.playNext'),
      iconPath: CTX_ICONS.playNext,
      onSelect: () => queuePlayNext(track),
      disabled: track.unavailable
    })
    items.push({
      label: t('ctx.addToQueue'),
      iconPath: CTX_ICONS.addToQueue,
      onSelect: () => queueAppend(track),
      disabled: track.unavailable
    })
    // Pin / unpin only makes sense in a playlist view (search results
    // aren't a list with persistent order). Detect by: openPlaylistId
    // is set AND this menu was opened on a row from the playlist view.
    const isPlaylistRow =
      openPlaylistId != null &&
      playlistView != null &&
      sourceList === playlistView.tracks &&
      sourceContext.id === openPlaylistId
    if (isPlaylistRow) {
      const pinned = isTrackPinned(track)
      items.push({
        label: pinned ? t('ctx.unpinPosition') : t('ctx.pinPosition'),
        iconPath: pinned ? CTX_ICONS.unpin : CTX_ICONS.pin,
        onSelect: () => void togglePinTrack(track)
      })
    }
    return items
  }

  function openCtxMenu(
    event: MouseEvent,
    track: SearchResult,
    sourceList: SearchResult[],
    sourceContext: { id?: string; title?: string } = {}
  ): void {
    event.preventDefault()
    event.stopPropagation()
    ctxMenu = {
      x: event.clientX,
      y: event.clientY,
      items: buildTrackMenu(track, sourceList, sourceContext)
    }
  }

  function closeCtxMenu(): void {
    ctxMenu = null
  }

  // onMount stays synchronous so we can return a proper cleanup closure
  // (Svelte 5 typedef requires `() => () => void | Promise<never>` — an
  // async onMount that returns a teardown would violate the Promise<never>
  // branch). The asynchronous initial-load work runs in an IIFE; the IPC
  // subscribers and mouse listener are wired straight away so events that
  // arrive mid-init still land in the right handlers.
  onMount(() => {
    // Subscribe to per-track download progress; live updates for the bulk
    // progress UI + flipping each row's badge as it completes.
    const unsub = window.api.downloads.onProgress(handleDownloadProgress)
    // Live per-track percentage stream — drives the filling ring on each
    // download chip while bytes are being fetched.
    const unsubPct = window.api.downloads.onTrackProgress(handleTrackProgress)
    // Auto-updater event stream — drives the "Обновления" Settings card.
    const unsubUpd = window.api.updater.onEvent(handleUpdaterEvent)
    // Silent reconnect just refreshed cookies in main — drop the
    // logged-in-required caches and re-fetch whatever the user is
    // currently looking at. Stops the "empty Library on first launch
    // after upgrade until you Disconnect+Connect" bug.
    const unsubAuth = window.api.auth.onRefreshed(() => {
      console.log('[renderer] auth refreshed — re-fetching current view')
      homeSections = null
      libraryPlaylists = null
      pinnedPlaylists = []
      void loadPinned()
      if (view === 'home') void loadHome()
      else if (view === 'library') void loadLibraryData()
      else if (view === 'playlist' && openPlaylistId) {
        const id = openPlaylistId
        playlistView = null
        openPlaylistId = null
        void loadPlaylistData(id)
      }
    })
    // Mouse side-buttons: XButton1 (back) = event.button 3, XButton2
    // (forward) = event.button 4. Matches browsers and File Explorer on
    // Windows. preventDefault stops the default "navigate back" behaviour
    // that would otherwise leave dev-tools or Electron itself trying to
    // do something with the click.
    const onMouse = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault()
        goBack()
      } else if (e.button === 4) {
        e.preventDefault()
        goForward()
      }
    }
    window.addEventListener('mouseup', onMouse)

    // Context-menu dismissal: any click outside the menu OR an ESC press
    // closes it. The menu itself stops propagation on its own clicks so
    // picking an item doesn't immediately re-close before the action
    // fires (handler order: item onSelect → closeCtxMenu inside the
    // item-click handler in the menu DOM).
    const onWindowMouseDown = (e: MouseEvent): void => {
      if (!ctxMenu) return
      const el = e.target as HTMLElement | null
      if (el && el.closest('.ctx-menu')) return
      closeCtxMenu()
    }
    const onWindowKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Confirm dialog wins over context menu — both shouldn't be
        // open at the same time, but if they are, dismissing the
        // modal first matches user expectation.
        if (confirmDialog) {
          closeConfirm(false)
          return
        }
        if (ctxMenu) closeCtxMenu()
      } else if (e.key === 'Enter' && confirmDialog) {
        // Enter confirms — matches OS-level dialog convention.
        closeConfirm(true)
      }
    }
    window.addEventListener('mousedown', onWindowMouseDown)
    window.addEventListener('keydown', onWindowKeyDown)

    void (async () => {
      // Load + apply the saved theme as the very first thing so the user
      // doesn't see purple flash before their preferred palette kicks in.
      theme = await window.api.settings.getTheme()
      applyTheme(theme)
      // Load saved language so labels render in the right locale on first
      // paint. Fallback is 'ru' (handled by the IPC default).
      lang = await window.api.settings.getLang()
      // Restore the player's mode toggles so the user doesn't have to
      // flip shuffle / repeat every launch. Loaded before any track
      // could conceivably play so the first onAudioEnded uses the
      // correct mode.
      shuffleMode = await window.api.settings.getShuffleMode()
      repeatMode = await window.api.settings.getRepeatMode()
      browsers = await window.api.auth.browsers()
      connectedBrowser = await window.api.auth.status()
      if (connectedBrowser) {
        void loadPinned()
        // Honour the user's preferred startup tab.
        const initial = await window.api.settings.getDefaultTab()
        defaultTab = initial
        // Reset history to start from the chosen view so back-button
        // doesn't reveal a stale 'home' entry the user never visited.
        historyStack = [{ kind: initial }]
        historyIndex = 0
        view = initial
        applyEntry({ kind: initial })
        // Look for a saved playback session — if there is one we restore
        // the player bar straight away: same track, same queue, seeked
        // to where the user left off, PAUSED. Clicking Play resolves the
        // stream and continues. No banner, no auto-play (audio blasting
        // on Windows boot would be surprising).
        try {
          const saved = await window.api.session.get()
          if (saved && saved.track && saved.track.id) hydrateDeferredSession(saved)
        } catch (err) {
          console.warn('session restore failed', err)
        }
      }
    })()

    return () => {
      unsub()
      unsubPct()
      unsubUpd()
      unsubAuth()
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('mousedown', onWindowMouseDown)
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  })

  async function connect(browser: { id: string; name: string }): Promise<void> {
    connecting = browser.id
    connectError = ''
    try {
      const ok = await window.api.auth.connect(browser.id)
      if (ok) {
        connectedBrowser = browser.id
        void loadPinned()
        void loadHome()
      } else {
        connectError = t('connect.error', { browser: browser.name })
      }
    } finally {
      connecting = null
    }
  }

  async function disconnect(): Promise<void> {
    await window.api.auth.disconnect()
    connectedBrowser = null
    homeSections = null
    searchResults = []
    searched = false
    playlistView = null
    openPlaylistId = null
    playing = null
    playStatus = 'idle'
    libraryPlaylists = null
    libraryError = ''
    pinnedPlaylists = []
    // The deferred-resume track points at something the now-anonymous
    // user can no longer resolve. Drop the pending seek so the next
    // resolved track plays from 0:00.
    pendingResumeTime = null
    // Player ephemeral state — queue, history, transient UI bits.
    userQueue = []
    playHistory = []
    ctxMenu = null
    toast = null
    historyStack = [{ kind: 'home' }]
    historyIndex = 0
    view = 'home'
  }

  // Library: data load is separate from view switching so history nav can
  // call it without re-pushing the entry.
  async function loadLibraryData(): Promise<void> {
    if (libraryPlaylists || libraryLoading) return
    libraryError = ''
    libraryLoading = true
    try {
      libraryPlaylists = await window.api.metadata.libraryPlaylists()
      // Library landing returns Liked Music as a tile. If we found it,
      // refresh the pinned snapshot so the sidebar shortcut has a real
      // cover even before the user opens the playlist.
      const lm = libraryPlaylists.items.find(
        (it) => it.id === 'LM' || it.id === 'VLLM' || it.title === 'Liked Music'
      )
      if (lm && lm.thumbnail) {
        await window.api.settings.updatePinSnapshot({
          id: lm.id,
          title: lm.title,
          thumbnail: lm.thumbnail
        })
        await loadPinned()
      }
    } catch (e) {
      libraryError = e instanceof Error ? e.message : String(e)
    } finally {
      libraryLoading = false
    }
  }

  function openLibrary(): void {
    navigate({ kind: 'library' })
  }

  function browserName(id: string | null): string {
    return browsers.find((b) => b.id === id)?.name ?? id ?? ''
  }

  // ---- home -----------------------------------------------------------------

  async function loadHome(): Promise<void> {
    if (homeLoading) return
    homeLoading = true
    homeError = ''
    try {
      homeSections = await window.api.metadata.home()
    } catch (e) {
      homeError = e instanceof Error ? e.message : String(e)
      homeSections = null
    } finally {
      homeLoading = false
    }
  }

  async function openCard(item: HomeItem): Promise<void> {
    if (item.type === 'playlist' || item.type === 'album') {
      await openPlaylist(item.id, { fallbackTitle: item.title, fallbackThumbnail: item.thumbnail })
      return
    }
    if (item.type === 'song' || item.type === 'video') {
      // No queue context — make a single-item list so the player still works.
      const synthetic: SearchResult = {
        id: item.id,
        title: item.title,
        artist: item.subtitle,
        duration: '',
        thumbnail: item.thumbnail
      }
      await playTrack(synthetic, [synthetic])
      return
    }
    // artists not supported yet
  }

  // ---- search ---------------------------------------------------------------

  async function doSearch(): Promise<void> {
    const q = query.trim()
    if (!q || searching) return
    navigate({ kind: 'search' })
    searching = true
    searchError = ''
    try {
      searchResults = await window.api.metadata.search(q)
      searched = true
    } catch (e) {
      searchError = e instanceof Error ? e.message : String(e)
      searchResults = []
    } finally {
      searching = false
    }
  }

  // ---- playlist -------------------------------------------------------------

  // Playlist data load (separated from view switching for history nav).
  // The fallback is only used on the cold path — back/forward find the
  // already-loaded playlistView in state if id matches.
  let playlistFallback: { title?: string; thumbnail?: string } | null = null

  async function loadPlaylistData(id: string): Promise<void> {
    openPlaylistId = id
    playlistLoading = true
    playlistError = ''
    // Reset per-playlist override state — it's recomputed below from
    // whatever's persisted in config for this id.
    playlistPinned = new Set()
    // Synthetic "Downloaded" virtual playlist: data comes from the local
    // manifest, not InnerTube. Same UI as a normal playlist; the pin
    // button + bulk download are hidden because they don't apply.
    if (isDownloadedId(id)) {
      playlistFallback = null
      try {
        const data = await window.api.downloads.asPlaylist()
        let tracks: SearchResult[] = data.tracks.map((tr) => ({
          id: tr.id,
          title: tr.title,
          artist: tr.artist,
          duration: tr.duration,
          thumbnail: tr.thumbnail
        }))
        // Apply the user's saved override (reshuffle / drag / pin) on
        // top of the newest-first default. Downloaded uses videoId as
        // its row key since there's no setVideoId for cached files.
        const override = await window.api.settings.getPlaylistOverride(DOWNLOADED_ID)
        tracks = applyOverride(tracks, override, DOWNLOADED_ID)
        playlistPinned = new Set(override?.pinned ?? [])
        hasPlaylistOverride = override != null
        playlistView = {
          title: t('downloaded.title'),
          subtitle: t('downloaded.summary', {
            n: data.tracks.length,
            size: fmtBytes(data.totalBytes)
          }),
          thumbnail: data.thumbnail,
          tracks
        }
        // Everything in this list is by definition downloaded.
        const s = new Set(downloadedIds)
        for (const tr of data.tracks) s.add(tr.id)
        downloadedIds = s
      } catch (e) {
        playlistError = e instanceof Error ? e.message : String(e)
        playlistView = null
      } finally {
        playlistLoading = false
      }
      return
    }
    // Keep the fallback cover in a local so a successful load can still
    // see it even after we clear the field. Big private playlists tend to
    // come back without a header thumbnail in the InnerTube response, and
    // the card-tile cover from the Library grid is a perfectly good
    // substitute.
    const fallbackTitle = playlistFallback?.title ?? ''
    const fallbackThumb = playlistFallback?.thumbnail ?? ''
    playlistView = {
      title: fallbackTitle,
      subtitle: '',
      thumbnail: fallbackThumb,
      tracks: []
    }
    playlistFallback = null
    try {
      const data = await window.api.metadata.playlist(id)
      // Apply the user's saved override (reshuffle / drag / pin) on
      // top of YT's natural order. Liked Music is special-cased to
      // prepend new tracks; everything else appends.
      const override = await window.api.settings.getPlaylistOverride(id)
      const merged = applyOverride(data.tracks, override, id)
      playlistPinned = new Set(override?.pinned ?? [])
      hasPlaylistOverride = override != null
      playlistView = {
        ...data,
        title: data.title || fallbackTitle,
        thumbnail: data.thumbnail || fallbackThumb,
        tracks: merged
      }
      // Once we have the track list, check which of them are already on
      // disk so the download badges render in the correct state.
      void refreshDownloadStatus(playlistView.tracks)
      // If this playlist is pinned (or it's Liked Music auto-pin),
      // refresh the persisted snapshot — first open of LM finally gets
      // a real cover into the sidebar shortcut.
      if (isPinned(id) || isLikedMusicId(id)) {
        const finalTitle = playlistView.title || 'Liked Music'
        const finalThumb = playlistView.thumbnail || ''
        if (finalTitle || finalThumb) {
          await window.api.settings.updatePinSnapshot({
            id,
            title: finalTitle,
            thumbnail: finalThumb
          })
          await loadPinned()
        }
      }
    } catch (e) {
      playlistError = e instanceof Error ? e.message : String(e)
    } finally {
      playlistLoading = false
    }
  }

  async function openPlaylist(
    id: string,
    fallback?: { fallbackTitle?: string; fallbackThumbnail?: string }
  ): Promise<void> {
    playlistFallback = fallback
      ? { title: fallback.fallbackTitle, thumbnail: fallback.fallbackThumbnail }
      : null
    navigate({ kind: 'playlist', id })
  }

  // ---- player ---------------------------------------------------------------

  const PREFETCH_AHEAD = 2

  function nextIdsFrom(currentId: string, list: SearchResult[]): string[] {
    const idx = list.findIndex((r) => r.id === currentId)
    if (idx < 0) return []
    return list.slice(idx + 1, idx + 1 + PREFETCH_AHEAD).map((r) => r.id)
  }

  // Walk a playlist looking for a playable track in the requested
  // direction (1 = forward, -1 = backward). Returns the index of the
  // first non-unavailable track from `start` (inclusive), or -1 when
  // every remaining row is unplayable. Drives prev/next "skip the
  // deleted track" behaviour.
  function findPlayableIndex(list: SearchResult[], start: number, step: 1 | -1): number {
    for (let i = start; i >= 0 && i < list.length; i += step) {
      if (!list[i].unavailable) return i
    }
    return -1
  }

  async function playTrack(
    track: SearchResult,
    sourceList: SearchResult[],
    sourceContext?: { id?: string; title?: string }
  ): Promise<void> {
    if (playStatus === 'resolving') return
    // Refuse to start an unavailable row — the stream resolve would
    // fail with a hard 404 anyway and leave the player in an error
    // state. UI also disables the click handler on these rows, so this
    // is belt-and-suspenders.
    if (track.unavailable) return
    // Push whatever was just playing into the history stack BEFORE we
    // overwrite `playing`. Used by shuffle-prev to walk back through
    // actually-played tracks rather than picking another random one.
    // Skip the initial deferred-resume hydrate (empty streamUrl) so
    // we don't pollute history with a placeholder entry.
    if (playing && playing.streamUrl && playing.id !== track.id) {
      const snapshot: SearchResult = {
        id: playing.id,
        title: playing.title,
        artist: playing.artist,
        duration: '',
        thumbnail: playing.thumbnail
      }
      pushHistory(snapshot)
    }
    playStatus = 'resolving'
    playError = ''
    try {
      const r = await window.api.resolveAudio(track.id)
      playing = {
        id: track.id,
        // Prefer the title we already have from InnerTube (full UTF-8 via
        // page-proxy) over yt-dlp's stdout — Windows yt-dlp output can
        // mojibake even with PYTHONIOENCODING set, depending on bundling.
        title: track.title || r.title,
        artist: track.artist,
        format: r.format,
        streamUrl: r.streamUrl,
        thumbnail: track.thumbnail,
        sourceList,
        sourceListId: sourceContext?.id,
        sourceListTitle: sourceContext?.title
      }
      playStatus = 'playing'
      // Reset transport state so the UI doesn't briefly show old times.
      // For a deferred-resume start, seed currentTime to the saved
      // position so the seek bar doesn't jump back to 0:00 before canplay
      // fires the actual seek.
      currentTime = pendingResumeTime && pendingResumeTime > 1 ? pendingResumeTime : 0
      duration = 0
      await tick()
      const el = audioEl
      if (el) {
        el.volume = volume
        el.muted = muted
        const onCanPlay = (): void => {
          el.removeEventListener('canplay', onCanPlay)
          // Resume from the position saved before the previous app close.
          if (pendingResumeTime !== null && pendingResumeTime > 1 && Number.isFinite(el.duration)) {
            try {
              el.currentTime = Math.min(pendingResumeTime, el.duration - 1)
              currentTime = el.currentTime
            } catch {
              // ignore — some streams reject seek before fully ready
            }
            pendingResumeTime = null
          }
          const ids = nextIdsFrom(track.id, sourceList)
          if (ids.length > 0) void window.api.prefetchAudio(ids)
        }
        el.addEventListener('canplay', onCanPlay)
        el.play().catch(() => {})
      }
      // Save the freshly-set track into config so a restart can resume it.
      persistSession(0)
    } catch (e) {
      playStatus = 'error'
      playError = e instanceof Error ? e.message : String(e)
    }
  }

  // Picks a random playable track from `list` that's not `currentId`.
  // Returns the index, or -1 if the list has no playable alternative
  // (e.g. single-track list, or every other row is unavailable).
  function pickShuffleIndex(list: SearchResult[], currentId: string): number {
    const candidates: number[] = []
    for (let i = 0; i < list.length; i++) {
      if (list[i].id !== currentId && !list[i].unavailable) candidates.push(i)
    }
    if (candidates.length === 0) return -1
    return candidates[Math.floor(Math.random() * candidates.length)]
  }

  // Wraps adding to the history stack with the size cap. Older entries
  // fall off the bottom when the user has been listening for a while.
  function pushHistory(track: SearchResult): void {
    const next = playHistory.length >= PLAY_HISTORY_CAP
      ? playHistory.slice(playHistory.length - PLAY_HISTORY_CAP + 1)
      : playHistory.slice()
    next.push(track)
    playHistory = next
  }

  async function playNext(opts: { fromUserClick?: boolean } = {}): Promise<void> {
    if (!playing) return
    // The user explicitly hit Next → bypass repeat-one (that mode only
    // triggers on a track that naturally ended). Auto-end uses the
    // separate onAudioEnded path which honours repeat-one before this.
    void opts.fromUserClick

    // Queue takes priority over sourceList traversal — anything the user
    // explicitly queued plays before the natural next track.
    if (userQueue.length > 0) {
      const next = userQueue[0]
      userQueue = userQueue.slice(1)
      await playTrack(next, playing.sourceList, {
        id: playing.sourceListId,
        title: playing.sourceListTitle
      })
      return
    }

    const list = playing.sourceList
    if (shuffleMode) {
      const idx = pickShuffleIndex(list, playing.id)
      if (idx < 0) {
        // Single-track or all-unavailable list — only repeat-all could
        // reasonably wrap us back to the same track; otherwise nothing
        // to do.
        if (repeatMode === 'all') {
          const fallback = findPlayableIndex(list, 0, 1)
          if (fallback >= 0) {
            await playTrack(list[fallback], list, {
              id: playing.sourceListId,
              title: playing.sourceListTitle
            })
          }
        }
        return
      }
      await playTrack(list[idx], list, {
        id: playing.sourceListId,
        title: playing.sourceListTitle
      })
      return
    }

    const idx = list.findIndex((r) => r.id === playing!.id)
    if (idx < 0) return
    // Skip unavailable rows so the user doesn't hit a no-op when YT
    // left a deleted track in the middle of the playlist.
    let nextIdx = findPlayableIndex(list, idx + 1, 1)
    if (nextIdx < 0) {
      // End of list — repeat-all wraps to the first playable; otherwise
      // playback simply stops at the current track.
      if (repeatMode === 'all') nextIdx = findPlayableIndex(list, 0, 1)
      if (nextIdx < 0) return
    }
    await playTrack(list[nextIdx], list, {
      id: playing.sourceListId,
      title: playing.sourceListTitle
    })
  }

  async function playPrev(): Promise<void> {
    if (!playing) return
    // In shuffle mode, "prev" walks back through what we actually played,
    // not the original list order — otherwise it would feel arbitrary.
    if (shuffleMode && playHistory.length > 0) {
      const next = playHistory[playHistory.length - 1]
      // Drop the entry we're about to play AND the current one (which
      // sits at the top of history) so the next Prev keeps walking.
      const remaining = playHistory.slice(0, -1)
      playHistory = remaining
      await playTrack(next, playing.sourceList, {
        id: playing.sourceListId,
        title: playing.sourceListTitle
      })
      return
    }
    const list = playing.sourceList
    const idx = list.findIndex((r) => r.id === playing!.id)
    if (idx <= 0) return
    const prevIdx = findPlayableIndex(list, idx - 1, -1)
    if (prevIdx < 0) return
    await playTrack(list[prevIdx], list, {
      id: playing.sourceListId,
      title: playing.sourceListTitle
    })
  }

  // Fired when the <audio> element finishes a track naturally. Respects
  // repeat-one (replay the same track), then falls through to playNext
  // which handles queue + shuffle + repeat-all + sequential.
  function onAudioEnded(): void {
    if (repeatMode === 'one' && audioEl) {
      try {
        audioEl.currentTime = 0
        void audioEl.play().catch(() => {})
        return
      } catch {
        // fall through to playNext if seek failed
      }
    }
    void playNext()
  }

  // Is a track from the currently-open playlist what's playing? Drives
  // the play-button icon in the playlist header (play vs pause).
  const isPlayingFromOpenPlaylist = $derived(
    playing != null && openPlaylistId != null && playing.sourceListId === openPlaylistId
  )

  // Total duration of the currently-open playlist's tracks. Returned in
  // seconds; the renderer composes a localised string via
  // formatTotalDuration() before display. Zero when the playlist has no
  // duration info (e.g. the Downloaded virtual playlist whose manifest
  // doesn't store track durations).
  const playlistTotalSeconds = $derived(
    playlistView == null
      ? 0
      : playlistView.tracks.reduce((sum, t) => sum + parseDuration(t.duration), 0)
  )

  // Big Play button in the playlist header. If a track from THIS playlist
  // is currently playing → toggle pause/play (so the same button does
  // pause). Otherwise start from track 0 with the playlist as the source
  // list (sticky prev/next will follow it).
  function togglePlaylistPlay(): void {
    if (isPlayingFromOpenPlaylist && audioEl) {
      if (audioEl.paused) audioEl.play().catch(() => {})
      else audioEl.pause()
      return
    }
    void playPlaylistFromStart()
  }

  async function playPlaylistFromStart(): Promise<void> {
    if (!playlistView || playlistView.tracks.length === 0) return
    // Match YT Music: shuffle ON + Play All → start at a random playable
    // track rather than position 0. Off → first playable as before.
    let idx: number
    if (shuffleMode) {
      idx = pickShuffleIndex(playlistView.tracks, '')
      if (idx < 0) idx = findPlayableIndex(playlistView.tracks, 0, 1)
    } else {
      idx = findPlayableIndex(playlistView.tracks, 0, 1)
    }
    if (idx < 0) return
    await playTrack(playlistView.tracks[idx], playlistView.tracks, {
      id: openPlaylistId ?? undefined,
      title: playlistView.title
    })
  }

  // ---- streamer bundle (reshuffle / pin / drag) --------------------------

  // After any operation that swaps playlistView.tracks for a new array
  // (reshuffle / drag-reorder / reset-to-default), the player's
  // sourceList still references the OLD array — so prev/next walk the
  // pre-change order. Re-point sourceList at the live array so the
  // very next track click reflects the new arrangement.
  function syncPlayingSourceList(): void {
    if (!playing || !playlistView || !openPlaylistId) return
    if (playing.sourceListId !== openPlaylistId) return
    playing = { ...playing, sourceList: playlistView.tracks }
  }

  // One-shot reshuffle of the current playlist. Pinned rows stay where
  // they are; Fisher-Yates randomises the rest. Saves the new order so
  // the next open shows the same arrangement.
  async function reshuffleCurrentPlaylist(): Promise<void> {
    if (!playlistView || playlistView.tracks.length < 2) return
    const next = reshuffleTracks(playlistView.tracks, playlistPinned)
    playlistView = { ...playlistView, tracks: next }
    syncPlayingSourceList()
    await savePlaylistOverride()
  }

  // Toggle pinned status of a track. Pinned tracks keep their position
  // when the user reshuffles, and get a 📌 indicator on the row.
  async function togglePinTrack(track: SearchResult): Promise<void> {
    const k = rowKey(track)
    const next = new Set(playlistPinned)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    playlistPinned = next
    await savePlaylistOverride()
  }

  function isTrackPinned(track: SearchResult): boolean {
    return playlistPinned.has(rowKey(track))
  }

  // HTML5 drag-and-drop reorder. dataTransfer is required for Chrome
  // to actually fire dragover/drop on the targets; we don't use the
  // payload, the source index lives in dragIndex state.
  function onRowDragStart(e: DragEvent, idx: number): void {
    if (!playlistView) return
    dragIndex = idx
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(idx))
    }
  }
  function onRowDragOver(e: DragEvent, idx: number): void {
    if (dragIndex == null) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    if (dragOverIndex !== idx) dragOverIndex = idx
  }
  async function onRowDrop(e: DragEvent, idx: number): Promise<void> {
    e.preventDefault()
    const from = dragIndex
    dragIndex = null
    dragOverIndex = null
    if (from == null || !playlistView || from === idx) return
    const next = playlistView.tracks.slice()
    const [moved] = next.splice(from, 1)
    // When dragging downwards, the destination index shifts by -1 after
    // the splice — drop ABOVE the hovered row regardless of direction.
    const dest = from < idx ? idx - 1 : idx
    next.splice(dest, 0, moved)
    playlistView = { ...playlistView, tracks: next }
    syncPlayingSourceList()
    await savePlaylistOverride()
  }
  function onRowDragEnd(): void {
    dragIndex = null
    dragOverIndex = null
  }

  // Hover-play on a sidebar pinned playlist: same effect as clicking the
  // pin to navigate AND immediately hitting Play at the top of the
  // resulting view. We materialise the navigation inline (rather than
  // calling navigate() + waiting for applyEntry) so we can await the
  // data load and then chain the play in a single async flow.
  async function playPinnedPlaylist(p: PinnedPlaylist): Promise<void> {
    playlistFallback = { title: p.title, thumbnail: p.thumbnail }
    const current = historyStack[historyIndex]
    if (!current || current.kind !== 'playlist' || current.id !== p.id) {
      historyStack = [...historyStack.slice(0, historyIndex + 1), { kind: 'playlist', id: p.id }]
      historyIndex = historyStack.length - 1
    }
    view = 'playlist'
    await loadPlaylistData(p.id)
    if (playlistView && playlistView.tracks.length > 0) {
      const idx = findPlayableIndex(playlistView.tracks, 0, 1)
      if (idx >= 0) {
        await playTrack(playlistView.tracks[idx], playlistView.tracks, {
          id: p.id,
          title: p.title
        })
      }
    }
  }
</script>

<main>
  <header>
    <img class="wordmark" src={wordmark} alt="eCoda" />
    {#if connectedBrowser}
      <div class="history-nav">
        <button
          class="hist"
          onclick={goBack}
          disabled={!canBack}
          aria-label={t('nav.back')}
          title={t('nav.back')}
        >
          ‹
        </button>
        <button
          class="hist"
          onclick={goForward}
          disabled={!canForward}
          aria-label={t('nav.forward')}
          title={t('nav.forward')}
        >
          ›
        </button>
      </div>
    {/if}
  </header>

  {#if !connectedBrowser}
    <section class="card">
      <h2>{t('connect.title')}</h2>
      <p class="hint">{t('connect.hint')}</p>
      {#if browsers.length > 0}
        <div class="browsers">
          {#each browsers as b (b.id)}
            <button onclick={() => connect(b)} disabled={connecting !== null}>
              {connecting === b.id ? t('connect.checking', { browser: b.name }) : b.name}
            </button>
          {/each}
        </div>
      {:else}
        <p class="status">{t('connect.noBrowsers')}</p>
      {/if}
      {#if connectError}
        <p class="status error">{connectError}</p>
        <button class="ghost" onclick={() => window.api.auth.openYouTube()}>
          {t('connect.openYouTube')}
        </button>
      {/if}
    </section>
  {:else}
    <div class="layout">
      <aside class="sidebar">
        <button
          class="nav"
          class:active={view === 'home'}
          onclick={() => navigate({ kind: 'home' })}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
          </svg>
          {t('nav.home')}
        </button>
        <button
          class="nav"
          class:active={view === 'search'}
          onclick={() => navigate({ kind: 'search' })}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path
              d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"
            />
          </svg>
          {t('nav.search')}
        </button>
        <button
          class="nav"
          class:active={view === 'library'}
          onclick={openLibrary}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path
              d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z"
            />
          </svg>
          {t('nav.library')}
        </button>
        <button
          class="nav"
          class:active={view === 'playlist' && isDownloadedId(openPlaylistId)}
          onclick={() => navigate({ kind: 'playlist', id: DOWNLOADED_ID })}
        >
          <!-- material download icon: down-arrow into a tray -->
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
          </svg>
          {t('nav.downloaded')}
        </button>

        {#if pinnedPlaylists.length > 0}
          <div class="pin-list">
            {#each pinnedPlaylists as p (p.id)}
              <button
                class="pin-row"
                class:active={view === 'playlist' && openPlaylistId === p.id}
                title={p.title}
                onclick={() =>
                  openPlaylist(p.id, { fallbackTitle: p.title, fallbackThumbnail: p.thumbnail })}
              >
                <div
                  class="pin-thumb"
                  style:background-image={p.thumbnail ? `url("${p.thumbnail}")` : 'none'}
                >
                  {#if !p.thumbnail && isLikedMusicId(p.id)}
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                      <path d="M9 21h10a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-6.31l.95-4.57.03-.32a1.5 1.5 0 0 0-.44-1.06L12.17 1 5.59 7.59A2 2 0 0 0 5 9v10a2 2 0 0 0 2 2h2zM1 9h4v12H1z"/>
                    </svg>
                  {/if}
                </div>
                <span class="pin-title">
                  {isLikedMusicId(p.id) ? t('liked.music') : p.title}
                </span>
                <span
                  class="pin-play"
                  role="button"
                  tabindex="0"
                  aria-label={t('player.play')}
                  title={t('player.play')}
                  onclick={(e) => {
                    e.stopPropagation()
                    void playPinnedPlaylist(p)
                  }}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      e.stopPropagation()
                      void playPinnedPlaylist(p)
                    }
                  }}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </button>
            {/each}
          </div>
        {/if}

        <div class="nav-spacer"></div>
        <button
          class="nav"
          class:active={view === 'settings'}
          onclick={() => navigate({ kind: 'settings' })}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path
              d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.488.488 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 0 1 8.4 12 3.6 3.6 0 0 1 12 8.4a3.6 3.6 0 0 1 3.6 3.6 3.6 3.6 0 0 1-3.6 3.6z"
            />
          </svg>
          {t('nav.settings')}
        </button>
      </aside>

      <section class="view-wrap">
        {#if view === 'home'}
          {#if homeLoading}
            <div class="spinner"></div>
          {:else if homeError}
            <p class="status error">{t('home.error', { error: homeError })}</p>
            <button onclick={() => loadHome()}>{t('home.retry')}</button>
          {:else if homeSections && homeSections.length > 0}
            {#each homeSections as section (section.title)}
              <div class="section">
                <h3>{section.title}</h3>
                <div class="grid">
                  {#each section.items as item (item.id)}
                    <button class="card-tile" onclick={() => openCard(item)}>
                      <div
                        class="tile-thumb"
                        style:background-image={item.thumbnail
                          ? `url("${item.thumbnail}")`
                          : 'none'}
                      ></div>
                      <div class="tile-title">{item.title}</div>
                      <div class="tile-subtitle">{item.subtitle}</div>
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
          {:else}
            <p class="status">Главная пуста.</p>
          {/if}
        {:else if view === 'search'}
          <div class="search-bar">
            <input
              type="text"
              bind:value={query}
              placeholder={t('search.placeholder')}
              onkeydown={(e) => e.key === 'Enter' && doSearch()}
            />
            <button onclick={doSearch} disabled={searching}>
              {searching ? t('search.button.busy') : t('search.button.idle')}
            </button>
          </div>
          {#if searchError}
            <p class="status error">{t('search.error', { error: searchError })}</p>
          {/if}
          {#if searched && !searching && searchResults.length === 0 && !searchError}
            <p class="status">{t('search.empty')}</p>
          {/if}
          {#if searchResults.length > 0}
            <ul class="track-list">
              {#each searchResults as r (r.id)}
                <li>
                  <button
                    class="track-row"
                    class:current={playing?.id === r.id}
                    onclick={() => playTrack(r, searchResults)}
                    oncontextmenu={(e) => openCtxMenu(e, r, searchResults)}
                    disabled={playStatus === 'resolving'}
                  >
                    <div
                      class="thumb"
                      style:background-image={r.thumbnail ? `url("${r.thumbnail}")` : 'none'}
                    ></div>
                    <div class="meta">
                      <div class="title">{r.title}</div>
                      <div class="artist">{r.artist}</div>
                    </div>
                    <div class="duration">{r.duration}</div>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if view === 'playlist'}
          {#if playlistView}
            <div class="playlist-header">
              <div
                class="playlist-cover"
                style:background-image={playlistView.thumbnail
                  ? `url("${playlistView.thumbnail}")`
                  : 'none'}
              ></div>
              <div class="playlist-info">
                <div class="playlist-title">
                  {#if isDownloadedId(openPlaylistId)}
                    {t('downloaded.title')}
                  {:else if isLikedMusicId(openPlaylistId)}
                    {t('liked.music')}
                  {:else}
                    {playlistView.title || t('playlist.untitled')}
                  {/if}
                </div>
                <div class="playlist-subtitle">
                  {#if isDownloadedId(openPlaylistId)}
                    {t('downloaded.subtitle')}
                  {:else}
                    {playlistView.subtitle}
                  {/if}
                </div>
                {#if !playlistLoading}
                  <div class="playlist-count">
                    {t('playlist.count', { n: playlistView.tracks.length })}
                    {#if playlistTotalSeconds > 0}
                      · {formatTotalDuration(playlistTotalSeconds, lang)}
                    {/if}
                  </div>
                  {#if playlistView.tracks.length > 0}
                    <div class="playlist-actions">
                      <!-- Big Play button: plays the playlist from track 0
                           when nothing from it is currently active, or
                           toggles pause/play when we're listening to it. -->
                      <button
                        class="play-big"
                        onclick={togglePlaylistPlay}
                        aria-label={isPlayingFromOpenPlaylist && isPlaying
                          ? t('player.pause')
                          : t('player.play')}
                        title={isPlayingFromOpenPlaylist && isPlaying
                          ? t('player.pause')
                          : t('player.play')}
                      >
                        {#if isPlayingFromOpenPlaylist && isPlaying}
                          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                            <path d="M6 5h4v14H6z" />
                            <path d="M14 5h4v14h-4z" />
                          </svg>
                        {:else}
                          <!-- Play triangle nudged 2px right to centre it
                               optically in the circle (the geometric
                               centroid of a rightward triangle sits left
                               of the bounding box centre). -->
                          <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                            <path d="M9 5v14l11-7z" />
                          </svg>
                        {/if}
                      </button>

                      <!-- Reshuffle: one-shot Fisher-Yates of non-pinned
                           rows. Different from the player-bar's continuous
                           shuffle: this PERMANENTLY reorders the saved
                           order; each click is a new arrangement. Pinned
                           rows stay in their positions. -->
                      {#if playlistView.tracks.length > 1}
                        <button
                          class="dl-icon-btn"
                          onclick={reshuffleCurrentPlaylist}
                          aria-label={t('playlist.reshuffle')}
                          title={t('playlist.reshuffle')}
                        >
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                            <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
                          </svg>
                        </button>
                      {/if}

                      <!-- Reset to default order — only when there's a
                           saved override. Drops the override entirely
                           (pins + custom order both gone) and reloads
                           the playlist in YT's natural sequence. Guarded
                           by a confirm dialog so an accidental click
                           doesn't wipe a stream prep that took an hour. -->
                      {#if hasPlaylistOverride}
                        <button
                          class="dl-icon-btn"
                          onclick={resetPlaylistOrder}
                          aria-label={t('playlist.resetOrder')}
                          title={t('playlist.resetOrder')}
                        >
                          <!-- restart_alt: circular arrow with start mark -->
                          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                            <path d="M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6 0 2.97-2.17 5.43-5 5.91v2.02c3.95-.49 7-3.85 7-7.93 0-4.42-3.58-8-8-8zm-6 8c0-1.65.67-3.15 1.76-4.24L6.34 7.34A7.94 7.94 0 0 0 4 13c0 4.08 3.05 7.44 7 7.93v-2.02c-2.83-.48-5-2.94-5-5.91z"/>
                          </svg>
                        </button>
                      {/if}

                      <!-- Compact download chip: arrow + small N badge when
                           there are tracks left to fetch, ✓ when everything
                           is on disk. Hidden on Downloaded view because by
                           definition everything is already cached there. -->
                      {#if !isDownloadedId(openPlaylistId)}
                        {#if bulkProgress}
                          <!-- During a bulk download, the chip is clickable
                               and cancels the rest of the batch. Hover
                               swaps the spinner+count for a big ✕ so the
                               cancel affordance is visible. -->
                          <button
                            class="dl-icon-btn busy cancelable"
                            onclick={cancelBulkDownload}
                            aria-label={t('downloads.cancelBulk')}
                            title={t('downloads.cancelBulk')}
                          >
                            <span class="busy-content">
                              <span class="spinner spinner-inline"></span>
                              <span class="dl-count">{bulkProgress.done}/{bulkProgress.total}</span>
                            </span>
                            <span class="cancel-x" aria-hidden="true">✕</span>
                          </button>
                        {:else if playlistView.tracks.some((t) => !downloadedIds.has(t.id))}
                          {@const pending = playlistView.tracks.filter(
                            (t) => !downloadedIds.has(t.id)
                          ).length}
                          <button
                            class="dl-icon-btn"
                            onclick={downloadCurrentPlaylist}
                            aria-label={t('playlist.download.bulk', { n: pending })}
                            title={t('playlist.download.bulk', { n: pending })}
                          >
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                              <path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
                            </svg>
                            <span class="dl-count">{pending}</span>
                          </button>
                        {:else}
                          <button
                            class="dl-icon-btn done"
                            aria-label={t('playlist.download.allSaved')}
                            title={t('playlist.download.allSaved')}
                            disabled
                          >
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                              <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                            </svg>
                          </button>
                        {/if}
                      {/if}

                      {#if !isLikedMusicId(openPlaylistId) && !isDownloadedId(openPlaylistId)}
                        <button
                          class="pin-toggle"
                          class:pinned={isPinned(openPlaylistId)}
                          onclick={togglePinCurrent}
                          title={isPinned(openPlaylistId)
                            ? t('playlist.pinTitle.remove')
                            : t('playlist.pinTitle.add')}
                        >
                          {#if isPinned(openPlaylistId)}
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                              <path d="M16 9V4l1-1V1H7v2l1 1v5l-2 2v2h5v7l1 1 1-1v-7h5v-2l-2-2z" />
                            </svg>
                            {t('playlist.pinned')}
                          {:else}
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                              <path d="M14 4v5l2 2v2h-5v7l-1 1-1-1v-7H4v-2l2-2V4H4V2h14v2h-2zm-2 0H8v5l-2 2h10l-2-2V4z"/>
                            </svg>
                            {t('playlist.pin')}
                          {/if}
                        </button>
                      {/if}
                    </div>

                    {#if bulkResult}
                      <div class="bulk-result" class:has-fail={bulkResult.failed.length > 0}>
                        <div class="bulk-result-line">
                          {t('downloads.summary.ok', {
                            ok: bulkResult.ok,
                            total: bulkResult.total
                          })}
                          {#if bulkResult.failed.length > 0}
                            · {t('downloads.summary.failed', { n: bulkResult.failed.length })}
                          {/if}
                        </div>
                        <div class="bulk-result-actions">
                          {#if bulkResult.failed.length > 0}
                            <button class="dl-bulk retry" onclick={retryFailedDownloads}>
                              {t('downloads.summary.retry')}
                            </button>
                          {/if}
                          <button class="dl-bulk dismiss" onclick={() => (bulkResult = null)}>
                            {t('downloads.summary.dismiss')}
                          </button>
                        </div>
                      </div>
                    {/if}
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
          {#if playlistLoading}
            <div class="spinner"></div>
          {/if}
          {#if playlistError}
            <p class="status error">{t('home.error', { error: playlistError })}</p>
          {/if}
          {#if !playlistLoading && isDownloadedId(openPlaylistId) && playlistView && playlistView.tracks.length === 0}
            <p class="status empty">{t('downloaded.empty')}</p>
          {/if}
          {#if playlistView && playlistView.tracks.length > 0}
            <ul class="track-list">
              <!-- Key by index+id rather than r.id alone — a playlist
                   can legitimately contain the same videoId twice (user
                   added a track to the playlist twice), and Svelte 5
                   throws on duplicate keys. -->
              {#each playlistView.tracks as r, idx (`${idx}-${r.id}`)}
                <li
                  class="track-li"
                  class:unavailable={r.unavailable}
                  class:pinned={isTrackPinned(r)}
                  class:dragging={dragIndex === idx}
                  class:drag-over={dragOverIndex === idx && dragIndex !== idx}
                  draggable={true}
                  ondragstart={(e) => onRowDragStart(e, idx)}
                  ondragover={(e) => onRowDragOver(e, idx)}
                  ondragleave={() => {
                    if (dragOverIndex === idx) dragOverIndex = null
                  }}
                  ondrop={(e) => onRowDrop(e, idx)}
                  ondragend={onRowDragEnd}
                >
                  <button
                    class="track-row"
                    class:current={playing?.id === r.id}
                    onclick={() =>
                      playTrack(r, playlistView!.tracks, {
                        id: openPlaylistId ?? undefined,
                        title: playlistView!.title
                      })}
                    oncontextmenu={(e) =>
                      openCtxMenu(e, r, playlistView!.tracks, {
                        id: openPlaylistId ?? undefined,
                        title: playlistView!.title
                      })}
                    disabled={playStatus === 'resolving' || r.unavailable}
                    title={r.unavailable ? t('track.unavailable') : undefined}
                  >
                    <div
                      class="thumb"
                      style:background-image={`url("${thumbnailFor(r.id, r.thumbnail)}")`}
                    ></div>
                    <div class="meta">
                      <div class="title">{r.title}</div>
                      <div class="artist">
                        {#if r.unavailable}
                          {t('track.unavailable')}
                        {:else}
                          {r.artist}
                        {/if}
                      </div>
                    </div>
                    {#if isTrackPinned(r)}
                      <!-- 📌 stay-put indicator: this row's position is
                           preserved across reshuffles. Click-through
                           target is the surrounding row button. -->
                      <span class="pin-mark" title={t('ctx.pinnedHint')}>
                        <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                          <path d="M16 9V4l1-1V1H7v2l1 1v5l-2 2v2h5v7l1 1 1-1v-7h5v-2l-2-2z" />
                        </svg>
                      </span>
                    {/if}
                    <div class="duration">{r.duration}</div>
                  </button>
                  <button
                    class="dl-btn"
                    class:done={downloadedIds.has(r.id)}
                    class:busy={downloadingIds.has(r.id)}
                    title={r.unavailable
                      ? t('track.unavailable')
                      : downloadedIds.has(r.id)
                        ? t('track.dl.done')
                        : downloadingIds.has(r.id)
                          ? t('track.dl.cancel')
                          : t('track.dl.idle')}
                    onclick={() => toggleTrackDownload(r)}
                    disabled={r.unavailable}
                  >
                    {#if downloadedIds.has(r.id)}
                      ✓
                    {:else if downloadingIds.has(r.id)}
                      <!-- Filling progress ring driven by yt-dlp's live
                           percent. Background arc + foreground arc using
                           the stroke-dasharray-on-r≈15.9 trick (full
                           circumference ≈ 100, so the dasharray value
                           equals the percent). On hover the ring fades
                           and a ✕ takes over so the user knows the
                           click cancels the download. -->
                      <span class="busy-content">
                        <svg class="dl-ring" viewBox="0 0 36 36" width="18" height="18">
                          <circle
                            cx="18"
                            cy="18"
                            r="15.9"
                            fill="none"
                            stroke="rgba(255,255,255,0.18)"
                            stroke-width="3"
                          />
                          <circle
                            cx="18"
                            cy="18"
                            r="15.9"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="3"
                            stroke-dasharray="{downloadPercent.get(r.id) ?? 0}, 100"
                            transform="rotate(-90 18 18)"
                            stroke-linecap="round"
                          />
                        </svg>
                      </span>
                      <span class="cancel-x" aria-hidden="true">✕</span>
                    {:else}
                      ↓
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if view === 'settings'}
          <div class="settings-page">
            <h3>{t('settings.title')}</h3>

            <section class="settings-card">
              <h4>{t('settings.account.title')}</h4>
              <p class="settings-line">
                {t('settings.account.connected')} <strong>{browserName(connectedBrowser)}</strong>
              </p>
              <p class="settings-hint">{t('settings.account.hint')}</p>
              <button class="settings-btn" onclick={disconnect}>
                {t('settings.account.disconnect')}
              </button>
            </section>

            <section class="settings-card">
              <h4>{t('settings.lang.title')}</h4>
              <p class="settings-hint">{t('settings.lang.hint')}</p>
              <div class="seg">
                {#each Object.entries(LANG_LABELS) as [code, label] (code)}
                  <button
                    class="seg-btn"
                    class:active={lang === code}
                    onclick={() => changeLang(code as Lang)}
                  >
                    {label}
                  </button>
                {/each}
              </div>
            </section>

            <section class="settings-card">
              <h4>{t('settings.theme.title')}</h4>
              <p class="settings-hint">{t('settings.theme.hint')}</p>
              <div class="theme-grid">
                {#each Object.entries(THEMES) as [key, def] (key)}
                  <button
                    class="theme-swatch"
                    class:active={theme === key}
                    style:--swatch={def.swatch}
                    aria-label={t('theme.' + key)}
                    title={t('theme.' + key)}
                    onclick={() => changeTheme(key as Theme)}
                  >
                    <span class="theme-dot"></span>
                    <span class="theme-label">{t('theme.' + key)}</span>
                  </button>
                {/each}
              </div>
            </section>

            <section class="settings-card">
              <h4>{t('settings.behaviour.title')}</h4>
              <p class="settings-line">{t('settings.behaviour.defaultTab')}</p>
              <div class="seg">
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'home'}
                  onclick={() => changeDefaultTab('home')}
                >
                  🏠 {t('nav.home')}
                </button>
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'search'}
                  onclick={() => changeDefaultTab('search')}
                >
                  🔍 {t('nav.search')}
                </button>
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'library'}
                  onclick={() => changeDefaultTab('library')}
                >
                  📚 {t('nav.library')}
                </button>
              </div>
              <p class="settings-hint">{t('settings.behaviour.hint')}</p>
            </section>

            <section class="settings-card">
              <h4>{t('settings.quality.title')}</h4>
              <div class="quality-row">
                {#each ['best', 'medium', 'low'] as q (q)}
                  <button
                    class="quality-btn"
                    class:active={audioQuality === q}
                    onclick={() => changeAudioQuality(q as 'best' | 'medium' | 'low')}
                  >
                    <span class="quality-label">{t(`settings.quality.${q}`)}</span>
                    <span class="quality-sub">{t(`settings.quality.${q}Sub`)}</span>
                  </button>
                {/each}
              </div>
              <p class="settings-hint">{t('settings.quality.hint')}</p>
            </section>

            <section class="settings-card">
              <h4>{t('settings.cache.title')}</h4>
              {#if cacheStats}
                <p class="settings-line">
                  {t('settings.cache.stats', {
                    tracks: cacheStats.tracks,
                    size: fmtBytes(cacheStats.bytes)
                  })}
                </p>
              {:else}
                <p class="settings-line">{t('settings.cache.loading')}</p>
              {/if}
              <p class="settings-hint">{t('settings.cache.hint')}</p>
              <button
                class="settings-btn danger"
                onclick={clearCache}
                disabled={clearingCache || !cacheStats || cacheStats.tracks === 0}
              >
                {clearingCache ? t('settings.cache.clearing') : t('settings.cache.clear')}
              </button>
            </section>

            <section class="settings-card">
              <h4>{t('settings.updates.title')}</h4>
              <p class="settings-line">
                {t('settings.updates.current')} <strong>{appInfo?.version ?? '…'}</strong>
              </p>
              {#if updaterStatus.kind === 'checking'}
                <p class="settings-hint">{t('settings.updates.checking')}</p>
              {:else if updaterStatus.kind === 'available'}
                <p class="settings-hint">
                  {t('settings.updates.available', { version: updaterStatus.version })}
                </p>
              {:else if updaterStatus.kind === 'downloading'}
                <p class="settings-hint">
                  {t('settings.updates.downloading', { percent: updaterStatus.percent })}
                </p>
                <div class="upd-progress">
                  <div class="upd-progress-fill" style:width="{updaterStatus.percent}%"></div>
                </div>
              {:else if updaterStatus.kind === 'downloaded'}
                <p class="settings-hint">
                  {t('settings.updates.downloaded', { version: updaterStatus.version })}
                </p>
              {:else if updaterStatus.kind === 'not-available'}
                <p class="settings-hint">{t('settings.updates.upToDate')}</p>
              {:else if updaterStatus.kind === 'error'}
                <p class="settings-hint" style:color="#ff8db5">{updaterStatus.message}</p>
              {:else}
                <p class="settings-hint">{t('settings.updates.idleHint')}</p>
              {/if}
              <div class="upd-actions">
                {#if updaterStatus.kind === 'available'}
                  <button class="settings-btn donate" onclick={downloadUpdate}>
                    {t('settings.updates.downloadBtn')}
                  </button>
                {:else if updaterStatus.kind === 'downloaded'}
                  <button class="settings-btn donate" onclick={installUpdate}>
                    {t('settings.updates.installBtn')}
                  </button>
                {:else}
                  <button
                    class="settings-btn"
                    onclick={checkForUpdate}
                    disabled={updaterStatus.kind === 'checking' ||
                      updaterStatus.kind === 'downloading'}
                  >
                    {updaterStatus.kind === 'checking'
                      ? t('settings.updates.checkingBtn')
                      : t('settings.updates.checkBtn')}
                  </button>
                {/if}
              </div>
            </section>

            <section class="settings-card">
              <h4>{t('settings.about.title')}</h4>
              <p class="settings-line">{appInfo?.name ?? 'eCoda'}</p>
              <p class="settings-hint">{t('settings.about.hint')}</p>
              {#if appInfo?.repoUrl}
                <button
                  class="settings-btn"
                  onclick={() => window.open(appInfo!.repoUrl, '_blank')}
                >
                  {t('settings.about.openGitHub')}
                </button>
              {/if}
            </section>

            <section class="settings-card">
              <h4>{t('settings.donate.title')}</h4>
              <p class="settings-hint">{t('settings.donate.hint')}</p>
              <button
                class="settings-btn donate"
                onclick={() => window.open('https://dalink.to/toristarm', '_blank')}
              >
                {t('settings.donate.button')}
              </button>
            </section>

            <section class="settings-card">
              <h4>{t('settings.diag.title')}</h4>
              <p class="settings-hint">{t('settings.diag.hint')}</p>
              <ul class="diag-list">
                <li>
                  <span class="diag-label">{t('settings.diag.userData')}</span>
                  <code>{appInfo?.userData ?? '…'}</code>
                  <button
                    class="settings-btn small"
                    onclick={() => openInExplorer(appInfo?.userData)}
                  >
                    {t('settings.diag.open')}
                  </button>
                </li>
                <li>
                  <span class="diag-label">{t('settings.diag.cache')}</span>
                  <code>{appInfo?.userData ? `${appInfo.userData}\\offline` : '…'}</code>
                  <button
                    class="settings-btn small"
                    onclick={() =>
                      openInExplorer(appInfo?.userData ? `${appInfo.userData}\\offline` : undefined)}
                  >
                    {t('settings.diag.open')}
                  </button>
                </li>
                <li>
                  <span class="diag-label">{t('settings.diag.logFile')}</span>
                  <code>{appInfo?.logPath ?? '…'}</code>
                  <button
                    class="settings-btn small"
                    onclick={() => openInExplorer(appInfo?.logPath)}
                  >
                    {t('settings.diag.open')}
                  </button>
                </li>
              </ul>
              <button class="settings-btn" onclick={verifyCacheAction} disabled={verifying}>
                {verifying ? t('settings.diag.verifying') : t('settings.diag.verify')}
              </button>
              {#if verifyResult}
                <p class="settings-hint diag-result">
                  {t('settings.diag.verifyResult', {
                    entries: verifyResult.manifestEntries,
                    files: verifyResult.filesOnDisk,
                    dead: verifyResult.removedDeadEntries,
                    orphans: verifyResult.recoveredOrphans
                  })}
                </p>
              {/if}
            </section>

            <p class="settings-sig">
              © 2026 Erney White ·
              <a
                href="#"
                onclick={(e) => {
                  e.preventDefault()
                  window.open('https://github.com/erneywhite/eCoda', '_blank')
                }}
              >
                github.com/erneywhite/eCoda
              </a>
            </p>
          </div>
        {:else if view === 'library'}
          <!-- Phase B native: page-proxy signs InnerTube calls so we get
               the real authenticated library response, then we render the
               cards ourselves with the same grid as Home. -->
          {#if libraryLoading}
            <div class="spinner"></div>
          {:else if libraryError}
            <p class="status error">{t('home.error', { error: libraryError })}</p>
            <button onclick={openLibrary}>{t('home.retry')}</button>
          {:else if libraryPlaylists && libraryPlaylists.items.length > 0}
            <div class="section">
              <h3>{t('library.myPlaylists')}</h3>
              <div class="grid">
                {#each libraryPlaylists.items as item (item.id)}
                  <button class="card-tile" onclick={() => openCard(item)}>
                    <div
                      class="tile-thumb"
                      style:background-image={item.thumbnail
                        ? `url("${item.thumbnail}")`
                        : 'none'}
                    ></div>
                    {#if !isLikedMusicId(item.id)}
                      <span
                        class="card-pin"
                        class:pinned={isPinned(item.id)}
                        role="button"
                        tabindex="0"
                        aria-label={isPinned(item.id) ? t('playlist.pinned') : t('playlist.pin')}
                        title={isPinned(item.id)
                          ? t('playlist.pinTitle.remove')
                          : t('playlist.pinTitle.add')}
                        onclick={(e) => {
                          e.stopPropagation()
                          void togglePinFromItem(item)
                        }}
                        onkeydown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            void togglePinFromItem(item)
                          }
                        }}
                      >
                        {#if isPinned(item.id)}
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M16 9V4l1-1V1H7v2l1 1v5l-2 2v2h5v7l1 1 1-1v-7h5v-2l-2-2z" />
                          </svg>
                        {:else}
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                            <path d="M14 4v5l2 2v2h-5v7l-1 1-1-1v-7H4v-2l2-2V4H4V2h14v2h-2zm-2 0H8v5l-2 2h10l-2-2V4z"/>
                          </svg>
                        {/if}
                      </span>
                    {/if}
                    <div class="tile-title">
                      {isLikedMusicId(item.id) ? t('liked.music') : item.title}
                    </div>
                    <div class="tile-subtitle">
                      {isLikedMusicId(item.id) ? t('liked.music.subtitle') : item.subtitle}
                    </div>
                  </button>
                {/each}
              </div>
            </div>
          {:else if libraryPlaylists}
            <p class="status">В библиотеке пока пусто.</p>
          {/if}
        {/if}
      </section>
    </div>

    {#if playStatus === 'resolving'}
      <div class="resolving-bar">
        <span class="spinner spinner-inline"></span>
      </div>
    {/if}
    {#if playStatus === 'error'}
      <div class="resolving-bar error">{t('player.error', { error: playError })}</div>
    {/if}

    {#if playing}
      <div class="player-bar">
        <!-- Thin full-width progress strip flush to the top edge of the
             player bar (visually replaces the top border). Times live
             inline with the transport buttons below, the same way YT Music
             arranges them. -->
        <!-- The wrapper has a fixed visual height; the input is absolutely
             positioned and extends 10px above + below into the wrapper's
             padding so the clickable zone is ~25px without expanding the
             layout footprint. On hover the track grows a couple of px and
             the thumb fades in — all of that happens INSIDE the absolute
             input so nothing above or below shifts.

             No bind:value — onSeekInput / onSeekCommit read input.value
             from the DOM directly. Svelte 5's bind:value plus our own
             input/change handlers had undefined interleaving, which on
             a click (not drag) was committing the pre-click value to
             audioEl.currentTime and snapping playback to 0:00. -->
        <div class="seek-wrap">
          <input
            type="range"
            class="seek"
            min="0"
            max={duration || 0}
            step="0.5"
            value={currentTime}
            oninput={onSeekInput}
            onchange={onSeekCommit}
            disabled={!duration}
            style:--p="{duration ? (currentTime / duration) * 100 : 0}%"
            aria-label="Прогресс трека"
          />
        </div>

        <div class="bottom-row">
          <div class="now-playing">
            <div
              class="np-cover"
              style:background-image={`url("${thumbnailFor(playing.id, playing.thumbnail)}")`}
            ></div>
            <div class="np-meta">
              <div class="np-title" title={playing.title}>{playing.title}</div>
              <div class="np-artist" title={playing.artist || playing.format}>
                {playing.artist || playing.format}
              </div>
            </div>
          </div>

          <div class="transport-buttons">
            <!-- Shuffle toggle: leftmost, like YT Music. Active = accent
                 tint + filled dot under the icon. Persists across launches. -->
            <button
              class="ctrl small mode"
              class:active={shuffleMode}
              onclick={toggleShuffle}
              aria-label={t('player.shuffle')}
              title={t('player.shuffle')}
            >
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path
                  d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"
                />
              </svg>
              {#if shuffleMode}
                <span class="mode-dot"></span>
              {/if}
            </button>
            <button class="ctrl" onclick={playPrev} aria-label={t('player.prev')} title={t('player.prev')}>
              <!-- skip_previous (material): vertical bar + leftward triangle -->
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6 6h2v12H6z" />
                <path d="M9.5 12 18 6v12z" />
              </svg>
            </button>
            <button
              class="ctrl play"
              onclick={togglePlay}
              aria-label={isPlaying ? t('player.pause') : t('player.play')}
              title={isPlaying ? t('player.pause') : t('player.play')}
            >
              {#if isPlaying}
                <!-- pause: two bars -->
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M6 5h4v14H6z" />
                  <path d="M14 5h4v14h-4z" />
                </svg>
              {:else}
                <!-- play: rightward triangle -->
                <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
              {/if}
            </button>
            <button
              class="ctrl"
              onclick={() => playNext({ fromUserClick: true })}
              aria-label={t('player.next')}
              title={t('player.next')}
            >
              <!-- skip_next (material): rightward triangle + vertical bar -->
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6 6v12l8.5-6z" />
                <path d="M16 6h2v12h-2z" />
              </svg>
            </button>
            <!-- Repeat cycle: off → all → one → off. Icon changes per
                 state; the small dot underneath shows non-off active. -->
            <button
              class="ctrl small mode"
              class:active={repeatMode !== 'off'}
              onclick={cycleRepeat}
              aria-label={t('player.repeat.' + repeatMode)}
              title={t('player.repeat.' + repeatMode)}
            >
              {#if repeatMode === 'one'}
                <!-- repeat_one: loop arrows + "1" inside -->
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
                  <path d="M13 15V9h-1l-2 1v1h1.5v4H13z"/>
                </svg>
              {:else}
                <!-- repeat: loop arrows -->
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
                </svg>
              {/if}
              {#if repeatMode !== 'off'}
                <span class="mode-dot"></span>
              {/if}
            </button>
            <span class="time-inline">
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>
            <!-- Download chip for the currently-playing track. Same UX as
                 the per-row chip in the playlist view: idle → downloads,
                 done → deletes (no confirm). A spinner replaces the icon
                 while the download is in flight. Hidden when nothing is
                 actively playing (no track to act on). -->
            {#if playing && playing.streamUrl}
              <button
                class="ctrl small dl"
                class:done={downloadedIds.has(playing.id)}
                class:busy={downloadingIds.has(playing.id)}
                onclick={() =>
                  toggleTrackDownload({
                    id: playing!.id,
                    title: playing!.title,
                    artist: playing!.artist,
                    duration: '',
                    thumbnail: playing!.thumbnail
                  })}
                aria-label={downloadedIds.has(playing.id)
                  ? t('track.dl.done')
                  : downloadingIds.has(playing.id)
                    ? t('track.dl.cancel')
                    : t('track.dl.idle')}
                title={downloadedIds.has(playing.id)
                  ? t('track.dl.done')
                  : downloadingIds.has(playing.id)
                    ? t('track.dl.cancel')
                    : t('track.dl.idle')}
              >
                {#if downloadingIds.has(playing.id)}
                  <!-- Same filling ring as the playlist row chip uses,
                       driven by the live percent from downloads:track-progress.
                       Hover fades the ring + shows a ✕ to make the cancel
                       affordance discoverable. -->
                  <span class="busy-content">
                    <svg class="dl-ring" viewBox="0 0 36 36" width="18" height="18">
                      <circle
                        cx="18"
                        cy="18"
                        r="15.9"
                        fill="none"
                        stroke="rgba(255,255,255,0.18)"
                        stroke-width="3"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r="15.9"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-dasharray="{downloadPercent.get(playing.id) ?? 0}, 100"
                        transform="rotate(-90 18 18)"
                        stroke-linecap="round"
                      />
                    </svg>
                  </span>
                  <span class="cancel-x" aria-hidden="true">✕</span>
                {:else if downloadedIds.has(playing.id)}
                  <!-- ✓ filled checkmark -->
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                  </svg>
                {:else}
                  <!-- ↓ download arrow -->
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                    <path d="M5 20h14v-2H5v2zM19 9h-4V3H9v6H5l7 7 7-7z" />
                  </svg>
                {/if}
              </button>
            {/if}
          </div>

          <div class="volume">
            <button class="ctrl small" onclick={toggleMute} aria-label={muted ? 'Включить звук' : 'Выключить звук'}>
              {#if muted || volume === 0}
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"
                  ><path
                    d="M3 9v6h4l5 5V4L7 9H3zm13.59 3L20 8.41 18.59 7 15 10.59 11.41 7 10 8.41 13.59 12 10 15.59 11.41 17 15 13.41 18.59 17 20 15.59z"
                  /></svg
                >
              {:else if volume > 0.5}
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"
                  ><path
                    d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06A7 7 0 0 1 14 18.71v2.06A9 9 0 0 0 14 3.23z"
                  /></svg
                >
              {:else}
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"
                  ><path d="M7 9v6h4l5 5V4l-5 5H7zm9.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12z" /></svg
                >
              {/if}
            </button>
            <input
              type="range"
              class="vol"
              min="0"
              max="1"
              step="0.01"
              value={muted ? 0 : volume}
              oninput={onVolumeInput}
              style:--p="{(muted ? 0 : volume) * 100}%"
            />
          </div>
        </div>

        <!-- Audio element only mounts once we have a real stream URL.
             A deferred-resume entry sets playing.streamUrl='' so the
             player bar appears without trying to load anything; togglePlay
             then triggers a real playTrack which fills in streamUrl. -->
        {#if playing.streamUrl}
        <audio
          bind:this={audioEl}
          src={playing.streamUrl}
          onended={onAudioEnded}
          onplay={() => (isPlaying = true)}
          onpause={() => {
            isPlaying = false
            // Catch the exact position the user paused at — the throttled
            // timeupdate save might be up to 5s behind it.
            persistSession()
          }}
          onseeked={() => persistSession()}
          onloadedmetadata={() => (duration = audioEl?.duration ?? 0)}
          ontimeupdate={() => {
            if (!seeking && audioEl) currentTime = audioEl.currentTime
            // Throttled save so a long song still rescues "where I left
            // off" if the OS kills us without a clean shutdown.
            maybePersistSessionOnTime()
          }}
          onvolumechange={() => {
            if (audioEl) {
              volume = audioEl.volume
              muted = audioEl.muted
            }
          }}
        ></audio>
        {/if}
      </div>
    {/if}
  {/if}

  <!-- Floating context menu: rendered at the document root so its
       fixed-position offset (set from MouseEvent client coords)
       isn't clipped by a parent's overflow:hidden. Outside-click
       and ESC dismissal live in onMount. -->
  {#if ctxMenu}
    <div
      class="ctx-menu"
      role="menu"
      style:left="{ctxMenu.x}px"
      style:top="{ctxMenu.y}px"
    >
      {#each ctxMenu.items as item}
        <button
          class="ctx-item"
          class:danger={item.danger}
          disabled={item.disabled}
          onclick={() => {
            item.onSelect()
            closeCtxMenu()
          }}
        >
          {#if item.iconPath}
            <span class="ctx-icon">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                <path d={item.iconPath} />
              </svg>
            </span>
          {/if}
          <span class="ctx-label">{item.label}</span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- Toast: bottom-centre, above the player bar. Single live message,
       auto-dismisses after 2.5s. Used for "Added to queue" etc. -->
  {#if toast}
    <div class="toast" role="status">{toast.msg}</div>
  {/if}

  <!-- Confirm dialog — Promise-based replacement for native confirm().
       Backdrop dims everything; centred glass card matches Settings
       look. ESC = cancel (wired in onMount alongside the ctx-menu
       handler), click on backdrop also cancels. -->
  {#if confirmDialog}
    <!-- Backdrop click cancels; ESC handled globally in onMount's
         onWindowKeyDown so the dialog itself only needs the visual
         shell, the buttons handle their own keyboard. -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="confirm-backdrop"
      onclick={(e) => {
        if (e.target === e.currentTarget) closeConfirm(false)
      }}
    >
      <div class="confirm-card" role="dialog" aria-modal="true" tabindex="-1">
        <div class="confirm-message">{confirmDialog.message}</div>
        <div class="confirm-actions">
          <button class="confirm-btn cancel" onclick={() => closeConfirm(false)}>
            {confirmDialog.cancelLabel}
          </button>
          <button
            class="confirm-btn ok"
            class:danger={confirmDialog.danger}
            onclick={() => closeConfirm(true)}
          >
            {confirmDialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  {/if}
</main>

<style>
  /* Theme palette — applyTheme() in script rewrites these at runtime.
     The values here are the "purple" defaults so first paint before the
     persisted theme loads still looks correct. */
  :global(:root) {
    --accent: #c97df6;
    --accent-2: #ff6dc8;
    --accent-rgb: 201, 125, 246;
    --aurora-1: rgba(201, 125, 246, 0.32);
    --aurora-2: rgba(255, 109, 200, 0.18);
    --aurora-3: rgba(80, 110, 255, 0.14);
  }

  /* Custom scrollbars everywhere — the default Windows ones are grey
     chunks that don't match the glass aesthetic. Thin, mostly transparent,
     lights up on hover. Firefox gets equivalent values via scrollbar-*. */
  :global(*) {
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
  }
  :global(::-webkit-scrollbar) {
    width: 10px;
    height: 10px;
  }
  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }
  :global(::-webkit-scrollbar-thumb) {
    background: rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    border: 2px solid transparent;
    background-clip: padding-box;
  }
  :global(::-webkit-scrollbar-thumb:hover) {
    background: rgba(var(--accent-rgb), 0.45);
    background-clip: padding-box;
  }
  :global(::-webkit-scrollbar-corner) {
    background: transparent;
  }

  /* Mockup B: aurora gradient mesh behind everything. Three coloured
     radial blurs scattered, with the deep purple base showing through
     the gaps. Pinned to viewport so it doesn't scroll with content. */
  :global(body) {
    position: relative;
  }
  :global(body)::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(900px 600px at 8% 12%, var(--aurora-1), transparent 60%),
      radial-gradient(700px 500px at 92% 18%, var(--aurora-2), transparent 60%),
      radial-gradient(900px 700px at 50% 95%, var(--aurora-3), transparent 60%),
      #0c0816;
    z-index: -1;
    pointer-events: none;
  }

  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    /* Asymmetric padding: match .layout — header should sit above the
       sidebar with the same 1rem left gutter, while the right side keeps
       the original 2rem so the back/forward chips don't hug the window. */
    padding: 1.2rem 2rem 1.2rem 1rem;
    flex-shrink: 0;
  }

  /* Wordmark image is the eCoda lettering — no need for a separate text
     "eCoda" alongside it. drop-shadow gives the same neon halo we used
     to draw on the old raccoon avatar. */
  .wordmark {
    height: 64px;
    width: auto;
    display: block;
    filter: drop-shadow(0 0 18px rgba(180, 60, 240, 0.35));
  }

  .ghost {
    padding: 0.5rem 1rem;
    border: 1px solid #34284e;
    border-radius: 9px;
    background: transparent;
    color: #b9acd6;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
  }

  /* History (back / forward) controls — sit next to the disconnect button
     in the right side of the header. Disabled state reads dimmer. */
  .history-nav {
    margin-left: auto;
    display: flex;
    gap: 0.3rem;
  }

  .hist {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid #34284e;
    border-radius: 50%;
    background: transparent;
    color: #b9acd6;
    font-size: 1.2rem;
    line-height: 1;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .hist:hover:not(:disabled) {
    background: rgba(var(--accent-rgb), 0.18);
    border-color: rgba(var(--accent-rgb), 0.5);
    color: #ffffff;
  }

  .hist:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .ghost:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 820px;
    margin: 0 2rem;
    padding: 1.5rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
  }

  h2 {
    margin: 0;
    font-size: 1.15rem;
    color: #ffffff;
  }

  h3 {
    margin: 0 0 0.7rem 0;
    font-size: 1.1rem;
    color: #ffffff;
    font-weight: 700;
  }

  .hint {
    margin: 0;
    color: #b9acd6;
    font-size: 0.92rem;
    line-height: 1.5;
  }

  .browsers {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  /* ---- layout ------------------------------------------------------------- */

  .layout {
    display: grid;
    /* 200px wide enough to show "Понравившаяся музыка" without an
       ellipsis and to keep pinned playlist names mostly readable.
       Left page padding is reduced from 2rem → 1rem to give the
       sidebar that extra space rather than leaving an empty gutter
       between window edge and the card. */
    grid-template-columns: 200px 1fr;
    flex: 1;
    min-height: 0;
    gap: 1rem;
    padding: 0 2rem 0 1rem;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.8rem 0.5rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 16px;
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    /* Stretch the full layout height so .nav-spacer can push Settings
       to the bottom of the card. */
    margin: 0.5rem 0;
    min-height: 0;
  }

  .nav {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    text-align: left;
    padding: 0.6rem 0.85rem;
    border: none;
    border-radius: 9px;
    background: transparent;
    color: #b9acd6;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .nav svg {
    flex: 0 0 auto;
    opacity: 0.85;
  }

  .nav.active svg {
    opacity: 1;
  }

  .nav:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.05);
    color: #ffffff;
  }

  .nav.active {
    background: linear-gradient(
      90deg,
      rgba(var(--accent-rgb), 0.28),
      rgba(var(--accent-rgb), 0.10)
    );
    color: #ffffff;
    box-shadow: 0 4px 18px rgba(var(--accent-rgb), 0.18);
  }

  .nav:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Pushes whatever follows it to the bottom of the sidebar (Settings). */
  .nav-spacer {
    flex: 1;
    min-height: 0;
  }

  /* ---- Sidebar pinned playlists ----
     Sit under "Библиотека" with a small indent so the visual hierarchy
     reads as "sub-items of Library". Each row is a tiny cover (or a
     heart for Liked Music) + truncated title. */
  .pin-list {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin: 0.4rem 0 0.4rem 0.4rem;
    padding-top: 0.4rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    overflow-y: auto;
    min-height: 0;
    flex-shrink: 1;
  }

  .pin-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: #a99bc9;
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .pin-row:hover {
    background: rgba(255, 255, 255, 0.04);
    color: #ffffff;
  }

  .pin-row.active {
    background: rgba(var(--accent-rgb), 0.18);
    color: #ffffff;
  }

  .pin-thumb {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    border-radius: 5px;
    background-color: rgba(255, 255, 255, 0.06);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.7);
  }

  .pin-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Hover-Play chip at the right edge of a pinned playlist row. Stays
     hidden until the user hovers the row, then fades in. Clicking it
     navigates to the playlist AND starts playing it from track 0
     without an extra step (matches YT Music's sidebar UX).
     The hidden state collapses to width: 0 (not opacity: 0) so the
     title can use the full row width — otherwise the truncation
     happens even when the chip isn't visible, which looks wrong. */
  .pin-play {
    flex: 0 0 auto;
    width: 0;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: #ffffff;
    cursor: pointer;
    opacity: 0;
    overflow: hidden;
    padding: 0;
    margin-left: 0;
    border: none;
    box-shadow: 0 4px 12px rgba(var(--accent-rgb), 0.4);
    transition:
      width 0.12s ease,
      opacity 0.12s ease,
      margin-left 0.12s ease,
      transform 0.12s ease,
      filter 0.12s ease;
  }
  .pin-row:hover .pin-play,
  .pin-play:focus-visible {
    width: 22px;
    margin-left: 0.3rem;
    opacity: 1;
  }
  .pin-play:hover {
    filter: brightness(1.1);
    transform: scale(1.08);
  }

  /* Playlist header action row — big Play, compact download chip,
     pin/unpin. Sits below the count + duration line, left-aligned,
     wraps on narrow viewports. */
  .playlist-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.6rem;
    flex-wrap: wrap;
  }

  /* Big circular Play CTA — same gradient as the player bar's play
     button so the visual language is consistent. padding:0 overrides the
     global `button { padding: ... }` that would otherwise inflate the
     real box past the 52px we ask for and leave the SVG floating in a
     huge transparent margin. */
  .play-big {
    width: 56px;
    height: 56px;
    padding: 0;
    border-radius: 50%;
    border: none;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: #ffffff;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    box-shadow: 0 8px 22px rgba(var(--accent-rgb), 0.35);
    transition: transform 0.12s ease, filter 0.12s ease, box-shadow 0.12s ease;
  }
  .play-big:hover {
    filter: brightness(1.08);
    transform: scale(1.04);
    box-shadow: 0 10px 26px rgba(var(--accent-rgb), 0.45);
  }
  .play-big:active {
    transform: scale(0.97);
  }

  /* Compact icon button: download arrow + small count badge, OR a check
     mark when all tracks are saved (disabled). */
  .dl-icon-btn {
    position: relative;
    height: 40px;
    min-width: 40px;
    padding: 0 0.55rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.04);
    color: #d4c9e8;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .dl-icon-btn:hover:not(:disabled):not(.busy) {
    background: rgba(var(--accent-rgb), 0.18);
    border-color: rgba(var(--accent-rgb), 0.55);
    color: #ffffff;
  }
  .dl-icon-btn.done {
    color: #9eef9e;
    border-color: rgba(158, 239, 158, 0.35);
  }
  .dl-icon-btn:disabled {
    cursor: default;
    opacity: 0.85;
  }
  .dl-icon-btn.busy {
    cursor: default;
    color: #c9b8e6;
  }
  .dl-count {
    font-size: 0.78rem;
    font-weight: 600;
    min-width: 1.2em;
    text-align: center;
  }

  /* Pin/unpin toggle button in the playlist header — sits alongside the
     other action buttons. Reads softer than the gradient play button. */
  .pin-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    height: 40px;
    padding: 0 0.85rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    background: transparent;
    color: #d4c9e8;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .pin-toggle:hover {
    background: rgba(var(--accent-rgb), 0.14);
    border-color: rgba(var(--accent-rgb), 0.45);
    color: #ffffff;
  }

  .pin-toggle.pinned {
    background: rgba(var(--accent-rgb), 0.18);
    border-color: rgba(var(--accent-rgb), 0.5);
    color: #ffffff;
  }

  /* ---- settings ---------------------------------------------------------- */

  .settings-page {
    display: flex;
    flex-direction: column;
    gap: 1.2rem;
    max-width: 720px;
  }

  .settings-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 1.1rem 1.3rem;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 16px;
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
  }

  .settings-card h4 {
    margin: 0 0 0.3rem 0;
    color: #ffffff;
    font-size: 0.95rem;
    font-weight: 700;
  }

  .settings-line {
    margin: 0;
    color: #d4c9e8;
    font-size: 0.9rem;
  }

  .settings-line strong {
    color: #ffffff;
    font-weight: 600;
  }

  .settings-hint {
    margin: 0;
    color: #8c7da8;
    font-size: 0.8rem;
    line-height: 1.45;
  }

  .settings-btn {
    align-self: flex-start;
    margin-top: 0.3rem;
    padding: 0.55rem 1.1rem;
    border: 1px solid #34284e;
    border-radius: 9px;
    background: transparent;
    color: #d4c9e8;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .settings-btn:hover:not(:disabled) {
    background: rgba(var(--accent-rgb), 0.18);
    border-color: rgba(var(--accent-rgb), 0.5);
    color: #ffffff;
  }

  .settings-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .settings-btn.danger {
    border-color: rgba(255, 107, 157, 0.4);
    color: #ff8db5;
  }

  .settings-btn.danger:hover:not(:disabled) {
    background: rgba(255, 60, 120, 0.12);
    border-color: rgba(255, 107, 157, 0.8);
    color: #ffffff;
  }

  .settings-btn.small {
    padding: 0.3rem 0.65rem;
    font-size: 0.75rem;
    margin-top: 0;
    align-self: center;
  }

  /* Diagnostics list — labelled rows with the path as a monospace block
     and an "Open" chip on the right. Lets the user copy/paste the path
     OR jump straight to it in Explorer. */
  .diag-list {
    margin: 0.5rem 0 0.8rem;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .diag-list li {
    display: grid;
    grid-template-columns: 140px 1fr auto;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.6rem;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
    border: 1px solid rgba(255, 255, 255, 0.06);
  }
  .diag-label {
    color: #a4a0b8;
    font-size: 0.78rem;
  }
  .diag-list code {
    font-family: 'Cascadia Mono', 'Consolas', monospace;
    font-size: 0.72rem;
    color: #d4c9e8;
    overflow-wrap: anywhere;
    word-break: break-all;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 5px;
    padding: 0.25rem 0.4rem;
  }
  .diag-result {
    margin-top: 0.6rem;
    color: #b8aedb;
  }

  /* Settings page footer signature — copyright + repo link, centered,
     low-contrast so it doesn't compete with the cards above. */
  .settings-sig {
    margin: 1.5rem 0 0.5rem;
    text-align: center;
    color: #6c5d8a;
    font-size: 0.78rem;
  }

  .settings-sig a {
    color: #a99bc9;
    text-decoration: none;
    border-bottom: 1px dotted rgba(255, 255, 255, 0.18);
    transition: color 0.15s ease, border-color 0.15s ease;
  }

  .settings-sig a:hover {
    color: #ffffff;
    border-bottom-color: rgba(255, 255, 255, 0.45);
  }

  /* "Buy me a coffee" — warm-yellow gradient so it stands out as a
     thank-you button rather than a normal action. */
  /* Updater progress bar — sits inside the "Обновления" settings card
     while electron-updater is pulling the new release. */
  .upd-progress {
    height: 6px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 0.3rem;
  }
  .upd-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width 0.2s ease;
  }
  .upd-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  /* Theme picker — one row per palette: a coloured dot + the label,
     active palette gets a tinted background + bold ring. Each swatch's
     --swatch CSS var carries its own gradient so the dot picks the
     correct palette regardless of the active theme. */
  .theme-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 0.45rem;
    margin-top: 0.3rem;
  }

  .theme-swatch {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.5rem 0.7rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
    color: #d4c9e8;
    font-size: 0.83rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }

  .theme-swatch:hover {
    background: rgba(255, 255, 255, 0.06);
    color: #ffffff;
  }

  .theme-swatch.active {
    border-color: rgba(var(--accent-rgb), 0.6);
    background: rgba(var(--accent-rgb), 0.12);
    color: #ffffff;
  }

  .theme-dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--swatch);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    flex-shrink: 0;
  }

  .theme-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Segmented control for "default tab" pref — three pill buttons that
     read as one connected group. Active state borrows the same purple
     glow we use for the active sidebar item. */
  .seg {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .seg-btn {
    padding: 0.45rem 0.9rem;
    border: 1px solid #34284e;
    border-radius: 999px;
    background: transparent;
    color: #b9acd6;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }

  .seg-btn:hover:not(.active) {
    background: rgba(var(--accent-rgb), 0.1);
    color: #ffffff;
  }

  .seg-btn.active {
    background: rgba(var(--accent-rgb), 0.22);
    border-color: rgba(var(--accent-rgb), 0.55);
    color: #ffffff;
  }

  /* Quality picker — three tiles with a bold label + a faint
     "kbps · MB/track" subline so the user sees both the name and the
     real impact before clicking. Layout collapses to a single column on
     narrow Settings panes. */
  .quality-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin: 0.3rem 0 0.5rem;
  }
  .quality-btn {
    flex: 1 1 130px;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid #34284e;
    border-radius: 10px;
    background: transparent;
    color: #b9acd6;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    text-align: left;
  }
  .quality-btn:hover:not(.active) {
    background: rgba(var(--accent-rgb), 0.08);
    color: #ffffff;
  }
  .quality-btn.active {
    background: rgba(var(--accent-rgb), 0.18);
    border-color: rgba(var(--accent-rgb), 0.55);
    color: #ffffff;
  }
  .quality-label {
    font-size: 0.92rem;
    font-weight: 700;
  }
  .quality-sub {
    font-size: 0.74rem;
    color: #8c7da8;
  }
  .quality-btn.active .quality-sub {
    color: #b9acd6;
  }

  .settings-btn.donate {
    border: none;
    background: linear-gradient(135deg, #ffb347, #ffd33d);
    color: #1a1208;
    font-weight: 700;
  }

  .settings-btn.donate:hover:not(:disabled) {
    background: linear-gradient(135deg, #ffc366, #ffdc55);
    color: #1a1208;
  }

  .view-wrap {
    overflow-y: auto;
    padding: 0.5rem 0 1.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 1.6rem;
  }

  /* ---- search ------------------------------------------------------------- */

  .search-bar {
    display: flex;
    gap: 0.6rem;
    margin-bottom: 0.4rem;
  }

  /* Scoped to the search bar — was a global `input` rule, which also
     bled onto .seek and .vol (range inputs) and put a 1px purple line
     around them on focus, reading as a halo around the player card. */
  .search-bar input {
    flex: 1;
    padding: 0.65rem 0.85rem;
    border: 1px solid #34284e;
    border-radius: 9px;
    background: #0e0a16;
    color: #ffffff;
    font-size: 0.9rem;
    outline: none;
  }

  .search-bar input:focus {
    border-color: #a22ff0;
  }

  button {
    padding: 0.65rem 1.4rem;
    border: none;
    border-radius: 9px;
    background: linear-gradient(135deg, #a22ff0, #e24dff);
    color: #ffffff;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .status {
    margin: 0;
    color: #b9acd6;
    font-size: 0.88rem;
  }

  /* Generic spinner — replaces "Загружаю..." text. Spins one accent-coloured
     arc over a faint white track. Big block for inside-view loaders,
     inline mini-variant for the player resolving bar. */
  .spinner {
    width: 36px;
    height: 36px;
    border: 3px solid rgba(255, 255, 255, 0.08);
    border-top-color: var(--accent);
    border-radius: 50%;
    margin: 1.5rem 0 0 0;
    animation: spin 0.8s linear infinite;
  }
  .spinner-inline {
    width: 16px;
    height: 16px;
    border-width: 2px;
    margin: 0;
    display: inline-block;
    vertical-align: middle;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .status.error {
    color: #ff6b9d;
  }

  /* ---- home grid ---------------------------------------------------------- */

  .section {
    display: flex;
    flex-direction: column;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 1rem;
  }

  .card-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.6rem;
    /* min-width:0 is required for the grid item to actually shrink to the
       column width — without it, any long subtitle would push the tile
       wider than its column and overlap the next tile. */
    min-width: 0;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    color: #ffffff;
    text-align: left;
    cursor: pointer;
    transition: background 0.18s ease, border-color 0.18s ease,
      transform 0.18s ease, box-shadow 0.18s ease;
  }

  /* Pin/unpin overlay shown in the top-right of a Library card. Hidden
     until hover (or while pinned so the user can tell at a glance which
     tiles are in their sidebar already). stopPropagation on the click
     keeps the outer card-tile from also opening the playlist. */
  .card-pin {
    position: absolute;
    top: 0.9rem;
    right: 0.9rem;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: rgba(14, 10, 22, 0.75);
    color: #ffffff;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease,
      color 0.15s ease;
    cursor: pointer;
    z-index: 2;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  .card-tile:hover .card-pin,
  .card-pin.pinned {
    opacity: 1;
    transform: translateY(0);
  }

  .card-pin:hover {
    background: rgba(var(--accent-rgb), 0.55);
  }

  .card-pin.pinned {
    background: rgba(var(--accent-rgb), 0.45);
    color: #ffffff;
  }

  .card-tile:hover {
    background: rgba(255, 255, 255, 0.07);
    border-color: rgba(var(--accent-rgb), 0.45);
    transform: translateY(-3px);
    box-shadow: 0 14px 36px rgba(var(--accent-rgb), 0.18);
  }

  .tile-thumb {
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 8px;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
  }

  .tile-title {
    font-size: 0.88rem;
    font-weight: 600;
    line-height: 1.25;
    color: #ffffff;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .tile-subtitle {
    font-size: 0.78rem;
    color: #8c7da8;
    line-height: 1.3;
    /* Clamp to 2 lines — long artist lists ("Ed Sheeran, Meghan Trainor,
       Bruno Mars, Dua Lipa") render fully on a single line by default and
       blow out the grid; clamping keeps the tile a stable height. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ---- playlist header ---------------------------------------------------- */

  .playlist-header {
    display: flex;
    gap: 1.3rem;
    align-items: flex-end;
  }

  .playlist-cover {
    flex: 0 0 auto;
    width: 200px;
    height: 200px;
    border-radius: 14px;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
  }

  .playlist-info {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding-bottom: 0.6rem;
  }

  .playlist-title {
    color: #ffffff;
    font-size: 1.8rem;
    font-weight: 800;
    line-height: 1.1;
  }

  .playlist-subtitle {
    color: #b9acd6;
    font-size: 0.92rem;
  }

  .playlist-count {
    color: #8c7da8;
    font-size: 0.82rem;
  }

  /* (.library-frame removed — Phase B replaced the embedded webview with
     a native page-proxied playlist grid. The class wasn't referenced by
     any HTML for a few releases.) */

  /* ---- offline download buttons (playlist view only) --------------------- */

  .track-li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    position: relative;
    transition: opacity 0.12s ease, box-shadow 0.12s ease;
  }
  .track-li .track-row {
    flex: 1;
  }
  /* Drag-and-drop reorder visuals:
     .dragging  — the row currently being dragged (faded so the user
                  sees it's been picked up).
     .drag-over — the row currently under the cursor; a 2px accent line
                  on top serves as the drop indicator. Drop lands the
                  row ABOVE the indicator, matching the visual cue. */
  .track-li.dragging {
    opacity: 0.45;
  }
  .track-li.drag-over::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: -1px;
    height: 2px;
    background: var(--accent);
    border-radius: 2px;
    box-shadow: 0 0 8px rgba(var(--accent-rgb), 0.6);
    pointer-events: none;
  }
  /* Pinned-row indicator: a small accent-tinted pin between the artist
     meta and the duration column. The whole row stays clickable; only
     the pin glyph turns accent so it doesn't bleed into the row hover
     colour. */
  .pin-mark {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: 0.5rem;
    color: var(--accent);
    opacity: 0.85;
  }
  .track-li.pinned .pin-mark {
    opacity: 1;
  }

  .dl-btn {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid #2a2040;
    border-radius: 50%;
    background: transparent;
    color: #b9acd6;
    font-size: 1rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .dl-btn:hover:not(:disabled) {
    background: rgba(var(--accent-rgb), 0.18);
    border-color: rgba(var(--accent-rgb), 0.5);
    color: #ffffff;
  }

  .dl-btn.done {
    border-color: rgba(120, 200, 120, 0.55);
    background: rgba(120, 200, 120, 0.15);
    color: #9eef9e;
  }

  .dl-btn.busy {
    position: relative;
    cursor: pointer;
    color: var(--accent);
    opacity: 1;
  }

  /* Filling progress ring shown inside the download chip while bytes are
     in flight. `stroke-dasharray="N, 100"` with circumference ≈ 100 maps
     the percentage directly into the dash length; the transition softens
     the jumps yt-dlp emits (it prints whole percent ticks). */
  .dl-ring {
    display: block;
  }
  .dl-ring circle:nth-child(2) {
    transition: stroke-dasharray 0.2s ease-out;
  }

  /* Cancel affordance: the ring (or whatever .busy-content holds) fades
     out on parent :hover and a centred ✕ fades in. Reuses the .busy
     state on .dl-btn (track row), .ctrl.small.dl (player bar) and the
     wider .dl-icon-btn.busy (playlist bulk chip). */
  .busy-content {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    transition: opacity 0.12s ease;
  }
  .cancel-x {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #ff8db5;
    font-size: 0.95rem;
    font-weight: 700;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease;
  }
  .dl-btn.busy:hover .busy-content,
  .ctrl.small.dl.busy:hover .busy-content,
  .dl-icon-btn.busy.cancelable:hover .busy-content {
    opacity: 0;
  }
  .dl-btn.busy:hover .cancel-x,
  .ctrl.small.dl.busy:hover .cancel-x,
  .dl-icon-btn.busy.cancelable:hover .cancel-x {
    opacity: 1;
  }
  .dl-icon-btn.busy.cancelable {
    cursor: pointer;
    position: relative;
  }
  .dl-icon-btn.busy.cancelable:hover {
    background: rgba(255, 60, 120, 0.18);
    border-color: rgba(255, 107, 157, 0.5);
    color: #ff8db5;
  }
  /* Bigger ✕ for the wider playlist-header bulk chip */
  .dl-icon-btn.busy .cancel-x {
    font-size: 1.1rem;
  }

  .dl-bulk {
    align-self: flex-start;
    margin-top: 0.4rem;
    padding: 0.55rem 1.1rem;
    border: none;
    border-radius: 9px;
    background: linear-gradient(135deg, #a22ff0, #e24dff);
    color: #ffffff;
    font-size: 0.85rem;
    font-weight: 700;
    cursor: pointer;
  }

  /* Post-bulk summary panel: "Downloaded X of Y · N failed" + Retry/OK. */
  .bulk-result {
    margin-top: 0.5rem;
    padding: 0.5rem 0.7rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 9px;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .bulk-result.has-fail {
    border-color: rgba(255, 107, 157, 0.45);
    background: rgba(255, 60, 120, 0.07);
  }
  .bulk-result-line {
    color: #d4c9e8;
    font-size: 0.85rem;
  }
  .bulk-result-actions {
    display: flex;
    gap: 0.4rem;
  }
  .dl-bulk.retry {
    background: rgba(255, 60, 120, 0.18);
    border: 1px solid rgba(255, 107, 157, 0.5);
    color: #ffb5cb;
  }
  .dl-bulk.retry:hover {
    background: rgba(255, 60, 120, 0.3);
    color: #ffffff;
  }
  .dl-bulk.dismiss {
    background: transparent;
    color: #a4a0b8;
  }

  /* ---- track list (shared between search + playlist) ---------------------- */

  .track-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .track-row {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    width: 100%;
    padding: 0.5rem;
    border: none;
    border-radius: 9px;
    background: transparent;
    color: #ffffff;
    font-size: 0.9rem;
    font-weight: normal;
    cursor: pointer;
    text-align: left;
  }

  .track-row:hover:not(:disabled) {
    background: rgba(var(--accent-rgb), 0.09);
  }

  .track-row.current {
    background: rgba(var(--accent-rgb), 0.18);
  }

  .track-row:disabled {
    opacity: 0.55;
    cursor: default;
  }

  /* Playlist row that YT returned without a playable videoId — track is
     deleted / region-blocked / Premium-only after the user added it.
     We keep the row visible so the count matches the library card AND
     the user can see what's "missing" and clean it up in YT proper, but
     we dim it and italicise the metadata so it's obviously inert. */
  .track-li.unavailable .track-row,
  .track-li.unavailable .dl-btn {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .track-li.unavailable .title,
  .track-li.unavailable .artist {
    font-style: italic;
  }
  .track-li.unavailable .thumb {
    filter: grayscale(1);
  }

  .thumb {
    flex: 0 0 auto;
    width: 48px;
    height: 48px;
    border-radius: 6px;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
  }

  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .title {
    color: #ffffff;
    font-size: 0.92rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artist {
    color: #a99bc9;
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .duration {
    flex: 0 0 auto;
    color: #8c7da8;
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }

  /* ---- player bar (YT Music style) -------------------------------------- */

  .player-bar {
    display: flex;
    flex-direction: column;
    background: rgba(20, 12, 36, 0.55);
    backdrop-filter: blur(28px);
    -webkit-backdrop-filter: blur(28px);
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 18px;
    margin: 0 1.5rem 1.2rem;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.4);
    flex-shrink: 0;
    overflow: hidden;
  }

  /* The seek bar sits at the top of the floating player card. Player has
     border-radius + overflow:hidden, so a fully-flush input would have
     its left/right ends clipped by the rounded corners — the wrapper
     gives it a horizontal inset so the visible track lives inside the
     curve.

     The wrapper has a stable layout height (5px); the input is absolutely
     positioned and extends 10px above + below for a 25px hit area. Hover
     effects (track thickening, thumb fade-in) happen entirely inside the
     absolute input, so they never push anything in the .player-bar
     column up or down. */
  .seek-wrap {
    position: relative;
    /* Total reserved layout space ≈ original (6px margin + 12px input
       = 18px). Wrapper sits 10px below the player-bar top edge and is
       8px tall; the absolute input extends from y=0 (10-10) down to
       y=25, so its content-box centre lines up with where the 3px
       track used to render (~y=12 from the player-bar top). */
    height: 8px;
    margin: 10px 12px 0;
  }
  .seek {
    -webkit-appearance: none;
    appearance: none;
    display: block;
    position: absolute;
    left: 0;
    right: 0;
    top: -10px;
    height: 25px;
    padding: 0;
    margin: 0;
    background: transparent;
    cursor: pointer;
    /* No focus halo around the slider — the only visual the user
       should see is the track + thumb. The 25px hit-area input would
       otherwise pick up Chrome's default purple focus ring on click. */
    outline: none;
  }
  .seek:focus,
  .seek:focus-visible {
    outline: none;
  }
  .seek-wrap,
  .seek-wrap:focus-within {
    outline: none;
  }

  .bottom-row {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) auto minmax(140px, 1fr);
    gap: 1.5rem;
    align-items: center;
    padding: 0.55rem 1.3rem 0.85rem;
  }

  .now-playing {
    display: flex;
    gap: 0.85rem;
    align-items: center;
    min-width: 0;
  }

  .np-cover {
    flex: 0 0 auto;
    width: 56px;
    height: 56px;
    border-radius: 10px;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.45);
  }

  .np-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.18rem;
  }

  .np-title {
    color: #ffffff;
    font-size: 0.92rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .np-artist {
    color: #8c7da8;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- transport (center column) ---- */

  .transport-buttons {
    display: flex;
    gap: 0.7rem;
    align-items: center;
    justify-content: center;
  }

  /* Override the global purple-gradient button rule for control buttons —
     they're icon buttons, not full-width CTAs. */
  .ctrl {
    width: 40px;
    height: 40px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: #d4c9e8;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
  }

  .ctrl:hover {
    background: rgba(var(--accent-rgb), 0.18);
    color: #ffffff;
  }

  .ctrl.small {
    width: 30px;
    height: 30px;
  }

  /* Shuffle / repeat mode buttons in the player bar. Plain icon when
     off; accent-tinted with a small dot underneath when active. The dot
     is the only thing that visually differentiates "on" from "hovered"
     so the user can see state at a glance even without colour-vision
     contrast. */
  .ctrl.mode {
    position: relative;
  }
  .ctrl.mode.active {
    color: var(--accent);
  }
  .ctrl.mode .mode-dot {
    position: absolute;
    bottom: 3px;
    left: 50%;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--accent);
    transform: translateX(-50%);
    box-shadow: 0 0 6px rgba(var(--accent-rgb), 0.6);
  }

  /* Download chip in the player bar — uses .ctrl.small as the base
     (compact round icon button) and only overrides what's distinctive:
     a softer hover and the green "✓ already downloaded" state so the
     user can tell at a glance whether the current track is on disk.
     position:relative so the .cancel-x overlay can inset against it
     when downloading. */
  .ctrl.small.dl {
    position: relative;
    margin-left: 0.25rem;
    color: #b9acd6;
  }
  .ctrl.small.dl.busy:hover {
    color: #ff8db5;
    background: rgba(255, 60, 120, 0.18);
  }
  .ctrl.small.dl.done {
    color: #9eef9e;
  }
  .ctrl.small.dl.done:hover {
    background: rgba(255, 60, 120, 0.18);
    color: #ff8db5;
  }
  .ctrl.small.dl:disabled {
    cursor: default;
    opacity: 0.6;
  }

  .ctrl.play {
    width: 48px;
    height: 48px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: #0a0612;
    box-shadow: 0 8px 22px rgba(var(--accent-rgb), 0.5);
  }

  .ctrl.play:hover {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    filter: brightness(1.1);
    color: #0a0612;
    transform: scale(1.06);
    box-shadow: 0 10px 28px rgba(var(--accent-rgb), 0.65);
  }

  /* Inline time readout next to the transport buttons, YT-Music style:
     "0:50 / 2:44". One element, no fixed width, just sits right of next. */
  .time-inline {
    color: #8c7da8;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
    margin-left: 0.6rem;
    white-space: nowrap;
  }

  /* ---- floating context menu (right-click on tracks) ----
     Fixed-positioned at the user's cursor; dismissed on outside-click
     or ESC (wired in onMount). Renders at the document root so it can
     punch out of any overflow:hidden ancestor. */
  .ctx-menu {
    position: fixed;
    z-index: 1000;
    min-width: 200px;
    padding: 0.3rem;
    background: rgba(26, 18, 44, 0.96);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .ctx-item {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    width: 100%;
    padding: 0.5rem 0.7rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: #d4c9e8;
    font-size: 0.85rem;
    font-weight: 500;
    text-align: left;
    cursor: pointer;
  }
  .ctx-item:hover:not(:disabled) {
    background: rgba(var(--accent-rgb), 0.18);
    color: #ffffff;
  }
  .ctx-item:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .ctx-item.danger {
    color: #ff8db5;
  }
  .ctx-item.danger:hover:not(:disabled) {
    background: rgba(255, 60, 120, 0.18);
    color: #ffffff;
  }
  .ctx-icon {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #a99bc9;
  }
  .ctx-item:hover:not(:disabled) .ctx-icon {
    color: #ffffff;
  }
  .ctx-label {
    flex: 1;
  }

  /* ---- toast (transient notification) ----
     Single live message floats above the player bar. Faded purple
     background; auto-dismiss timer lives in the script. Non-clickable
     and pointer-events:none so it never blocks underlying controls. */

  /* ---- in-app confirm dialog ----
     Backdrop dims the underlying app; card matches Settings cards in
     style (glass + accent button), with a danger variant for the
     destructive actions (reset playlist order, clear cache). */
  .confirm-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: confirm-bg-in 0.12s ease-out;
  }
  .confirm-card {
    min-width: 340px;
    max-width: 460px;
    padding: 1.4rem 1.5rem 1.2rem;
    background: rgba(26, 18, 44, 0.97);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
    color: #ffffff;
    animation: confirm-card-in 0.16s ease-out;
  }
  .confirm-message {
    font-size: 0.95rem;
    line-height: 1.5;
    color: #e6dcfa;
    margin-bottom: 1.2rem;
  }
  .confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .confirm-btn {
    padding: 0.55rem 1.2rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 9px;
    background: transparent;
    color: #d4c9e8;
    font-size: 0.88rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
  }
  .confirm-btn:hover {
    background: rgba(255, 255, 255, 0.07);
    color: #ffffff;
  }
  .confirm-btn.ok {
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    border-color: transparent;
    color: #ffffff;
    box-shadow: 0 4px 14px rgba(var(--accent-rgb), 0.4);
  }
  .confirm-btn.ok:hover {
    filter: brightness(1.08);
  }
  .confirm-btn.ok.danger {
    background: linear-gradient(135deg, #ff5c8a, #d92e6f);
    box-shadow: 0 4px 14px rgba(255, 60, 120, 0.45);
  }
  @keyframes confirm-bg-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes confirm-card-in {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 110px;
    transform: translateX(-50%);
    z-index: 999;
    padding: 0.6rem 1.1rem;
    background: rgba(40, 26, 70, 0.92);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(var(--accent-rgb), 0.35);
    border-radius: 999px;
    color: #ffffff;
    font-size: 0.85rem;
    font-weight: 500;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    pointer-events: none;
    animation: toast-in 0.18s ease-out;
  }
  @keyframes toast-in {
    from { opacity: 0; transform: translateX(-50%) translateY(8px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }

  /* ---- range sliders (seek + volume) ----
     YT-Music-style: very thin grey track that grows a filled purple bar
     under the played portion. Fill width is driven by an inline `--p` CSS
     var so the rule stays declarative.

     For the SEEK bar we anchor the track to the TOP of the input (not the
     centre) — that's what makes the strip read as a top border instead of
     a floating control. We do this by using a transparent top border on
     the runnable-track plus a normal background for the visible track
     below it. Hover thickens the visible track. */
  .seek:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .seek::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 999px;
    background: linear-gradient(
      to right,
      var(--accent) 0%,
      var(--accent-2) var(--p, 0%),
      rgba(255, 255, 255, 0.1) var(--p, 0%),
      rgba(255, 255, 255, 0.1) 100%
    );
    transition: height 0.12s ease;
  }

  .seek:hover::-webkit-slider-runnable-track {
    height: 5px;
  }

  .seek::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    margin-top: -4px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .seek:hover::-webkit-slider-thumb {
    opacity: 1;
    margin-top: -3px;
  }

  /* Volume — same look but anchored centred (it lives inline with controls,
     not as a top edge). No focus halo either; just the track + thumb. */
  .vol {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    max-width: 110px;
    height: 14px;
    margin: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
    outline: none;
  }
  .vol:focus,
  .vol:focus-visible {
    outline: none;
  }

  .vol::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 999px;
    background: linear-gradient(
      to right,
      var(--accent) 0%,
      var(--accent-2) var(--p, 0%),
      rgba(255, 255, 255, 0.1) var(--p, 0%),
      rgba(255, 255, 255, 0.1) 100%
    );
  }

  .vol:hover::-webkit-slider-runnable-track {
    height: 4px;
  }

  .vol::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    margin-top: -5px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: #ffffff;
    border: none;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .vol:hover::-webkit-slider-thumb {
    opacity: 1;
  }

  /* ---- volume column ---- */

  .volume {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    justify-content: flex-end;
  }

  .vol {
    max-width: 110px;
  }

  audio {
    display: none;
  }

  .resolving-bar {
    padding: 0.4rem 2rem;
    color: #b9acd6;
    font-size: 0.84rem;
    background: rgba(var(--accent-rgb), 0.08);
    border-top: 1px solid #241a38;
    flex-shrink: 0;
  }

  .resolving-bar.error {
    color: #ff6b9d;
    background: rgba(255, 60, 120, 0.1);
  }
</style>
