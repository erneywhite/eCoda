<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  // Animation primitives. `flip` smooths track-list reorders (drag +
  // reshuffle + reset all trigger a SubArray swap that flip animates
  // from old → new positions). `fade` + `scale` polish view changes
  // and the context-menu pop. quintOut is the easing used by YT and
  // most modern UIs — fast tail, settles softly without overshoot.
  import { flip } from 'svelte/animate'
  import { fade, scale } from 'svelte/transition'
  import { prefersReducedMotion } from 'svelte/motion'
  import { BRAND_PALETTE, analyzeCover, type CoverPalette } from './cover-palette'
  import { quintOut } from 'svelte/easing'
  import wordmark from './assets/wordmark.png'
  import { translate, LANG_LABELS, type Lang } from './i18n'
  import type {
    ArtistView,
    CacheVerifyResult,
    DownloadProgress,
    HomeItem,
    HomeSection,
    LastSession,
    PinnedPlaylist,
    PlaylistOverride,
    PlaylistView,
    RecentPlaylist,
    RepeatMode,
    SearchResult,
    SessionTrack,
    UpdaterEvent,
    YtdlpCheckResult,
    YtdlpVersionInfo
  } from '../../preload/index.d'

  type View = 'home' | 'search' | 'playlist' | 'library' | 'settings' | 'artist'
  type PlayStatus = 'idle' | 'resolving' | 'playing' | 'error'

  // ---- auth state -----------------------------------------------------------
  let connectedBrowser = $state<string | null>(null)
  // True on macOS — the renderer hides its right-side custom window
  // controls there (the OS traffic lights cover min/max/close) and
  // pads the header left so the wordmark doesn't sit under them.
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform)
  // True when the OS-level window is maximized — drives the custom
  // titlebar's restore/maximize icon swap. Seeded on mount + kept in
  // sync via window:maximize-changed pushes from main.
  let windowMaximized = $state(false)
  // Mini-player mode. When active, the main layout (header + sidebar
  // + content + full player bar) is replaced by a compact draggable
  // always-on-top widget. Two layouts: 'compact' (horizontal pill) +
  // 'square' (cover-focused vertical card). Toggle button swaps
  // between them; restore button exits back to full mode. State is
  // mirrored from main via window:mini-changed pushes so the OS-side
  // resize and the renderer-side layout swap stay in sync.
  let miniMode = $state(false)
  let miniLayout = $state<'compact' | 'square'>('compact')
  let browsers = $state<{ id: string; name: string }[]>([])
  let connecting = $state<string | null>(null)
  // macOS Full Disk Access prompt — set when the browser's data dir can't be
  // read (connect returned 'needs-access', or the startup reconnect flagged
  // it). Holds the browser's display name for the message.
  let accessDialog = $state<{ browser: string } | null>(null)

  async function openAccessSettings(): Promise<void> {
    await window.api.auth.openAccessSettings()
  }

  async function relaunchApp(): Promise<void> {
    await window.api.auth.relaunch()
  }
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
    | { kind: 'artist'; id: string }
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
    // No-op when re-clicking the active tab/playlist/artist — re-pushing
    // the same id would pile up dupes in the back-stack. The id check
    // covers both playlist and artist (both carry one).
    if (current && current.kind === entry.kind) {
      const sameTarget =
        (entry.kind !== 'playlist' && entry.kind !== 'artist') ||
        ((current.kind === 'playlist' || current.kind === 'artist') &&
          current.id === (entry as { id: string }).id)
      if (sameTarget) {
        applyEntry(entry)
        return
      }
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
      // Radio is a per-click ephemeral list — only refresh when the seed
      // (or the id) changed.
      if (entry.id === DOWNLOADED_ID || openPlaylistId !== entry.id) {
        void loadPlaylistData(entry.id)
      }
    } else if (entry.kind === 'artist') {
      // Refresh only when the channelId actually changed — the artist
      // view's state (header + sections) is heavy enough that we don't
      // want to rebuild it just to return after a back/forward hop.
      if (openArtistId !== entry.id) {
        void loadArtistData(entry.id)
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
  // The query the current results belong to (the field may have been
  // edited since) — shown in the results heading.
  let searchedQuery = $state('')
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

  // ---- artist view ----------------------------------------------------------
  // Lives alongside playlist state so the renderer can show either
  // independently. Cleared on auth disconnect alongside the other
  // view caches.
  let openArtistId = $state<string | null>(null)
  let artistView = $state<ArtistView | null>(null)
  let artistLoading = $state(false)
  let artistError = $state('')

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
    // Radio is ephemeral — no point persisting an override against a
    // RADIO_<id> key the next session won't re-derive the same way.
    if (isRadioId(openPlaylistId)) return
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
    // Snapshot the currently-visible cover + title into playlistFallback
    // before the re-fetch. Otherwise Liked Music — whose /browse header
    // sometimes doesn't carry a thumbnail — would render with a blank
    // cover for the second between reset and the next user navigation.
    if (playlistView) {
      playlistFallback = {
        title: playlistView.title,
        thumbnail: playlistView.thumbnail
      }
    }
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

  // ---- cover colour (1.6.0) -------------------------------------------------
  // The accent follows the playing track's cover (cover-palette.ts) and the
  // window background is that cover, heavily blurred (.cover-backdrop in the
  // markup). Brand violet whenever nothing is loaded or the cover is
  // greyscale / unreachable. Replaces the old 8-palette theme picker.
  function applyPalette(p: CoverPalette): void {
    const r = document.documentElement.style
    r.setProperty('--accent', p.accent)
    r.setProperty('--accent-2', p.accent2)
    r.setProperty('--accent-rgb', p.accentRgb)
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

  // yt-dlp keeps itself fresh in the background (main/ytdlp-updater.ts);
  // the Updates card shows the running version and offers a manual check.
  let ytdlpInfo = $state<YtdlpVersionInfo | null>(null)
  let ytdlpChecking = $state(false)
  let ytdlpResult = $state<YtdlpCheckResult | null>(null)

  async function checkYtdlpNow(): Promise<void> {
    ytdlpChecking = true
    ytdlpResult = null
    try {
      const { result, info } = await window.api.ytdlp.check()
      ytdlpResult = result
      ytdlpInfo = info
    } catch (err) {
      ytdlpResult = { kind: 'error', message: (err as Error).message }
    } finally {
      ytdlpChecking = false
    }
  }

  function formatCheckedAt(ts: number): string {
    return new Date(ts).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
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
  // What the window's X button does — 'tray' hides to the system tray
  // (default; keeps playback running), 'quit' actually exits the app.
  let closeAction = $state<'tray' | 'quit'>('tray')
  // Diagnostics card state — Verify cache button + last result.
  let verifying = $state(false)
  let verifyResult = $state<CacheVerifyResult | null>(null)
  // Audio quality preset for new downloads. Defaults to 'best' on a
  // fresh install (handled by the IPC default).
  let audioQuality = $state<'best' | 'medium' | 'low'>('best')

  // How hardware media keys reach the app — 'system' (Chromium → SMTC/Now
  // Playing, OS arbitration) or 'global' (eCoda registers the keys OS-wide;
  // deterministic but exclusive). Boot-time flag in main → needs a restart.
  let mediaKeyMode = $state<'system' | 'global'>('system')

  async function loadSettings(): Promise<void> {
    appInfo = await window.api.app.info()
    ytdlpInfo = await window.api.ytdlp.info()
    cacheStats = await window.api.downloads.stats()
    defaultTab = await window.api.settings.getDefaultTab()
    audioQuality = await window.api.settings.getAudioQuality()
    closeAction = await window.api.settings.getCloseAction()
    mediaKeyMode = await window.api.settings.getMediaKeyMode()
    crossfadeDuration = await window.api.settings.getCrossfadeDuration()
    // Output-device picker: refresh the live device list and point the
    // select at the saved choice ('' = system default).
    savedOutputDevice = await window.api.settings.getAudioOutputDevice()
    selectedOutputId = savedOutputDevice?.id ?? ''
    await refreshOutputDevices()
  }

  async function changeCloseAction(action: 'tray' | 'quit'): Promise<void> {
    closeAction = action
    await window.api.settings.setCloseAction(action)
  }

  async function changeMediaKeyMode(mode: 'system' | 'global'): Promise<void> {
    if (mediaKeyMode === mode) return
    mediaKeyMode = mode
    await window.api.settings.setMediaKeyMode(mode)
    // The Chromium feature flag is applied at boot — remind that a restart
    // is needed before the new mode actually takes effect.
    showToast(t('settings.mediaKeys.restartHint'))
  }

  async function changeCrossfadeDuration(seconds: number): Promise<void> {
    const clamped = Math.max(0, Math.min(12, Math.round(seconds)))
    crossfadeDuration = clamped
    await window.api.settings.setCrossfadeDuration(clamped)
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

  // ---- shell: "Now playing" column ----------------------------------------
  // Right-hand column with the loaded track (cover, title, artist, like,
  // radio). Only while something is loaded and the window is wide enough
  // for three columns; below that the bottom player alone carries it.
  const NP_COLUMN_MIN_WIDTH = 1180
  let winWidth = $state(typeof window === 'undefined' ? 1200 : window.innerWidth)
  const npVisible = $derived(!!playing && winWidth >= NP_COLUMN_MIN_WIDTH)
  // The playing row as it appears in its source list — carries artistId
  // (for the artist link) and is the seed for "track radio".
  const playingRow = $derived(
    playing ? (playing.sourceList?.find((r) => r.id === playing!.id) ?? null) : null
  )
  function startRadioFromPlaying(): void {
    if (!playing) return
    void startRadioFromTrack(
      playingRow ?? {
        id: playing.id,
        title: playing.title,
        artist: playing.artist,
        duration: '',
        thumbnail: playing.thumbnail
      }
    )
  }

  // Thumbnails YT hands us for song rows are usually 120px; the Now-playing
  // column shows ~300px. googleusercontent / ggpht URLs carry the size in a
  // `=w120-h120…` suffix that can simply be asked for bigger. Anything else
  // (i.ytimg.com, media://) is used as is; a failed hi-res load falls back
  // to the normal cover.
  function hiResThumb(url: string): string {
    if (!/^https:\/\/[^/]*(googleusercontent\.com|ggpht\.com)\//.test(url)) return ''
    return url.replace(/=w\d+-h\d+/, '=w544-h544')
  }
  let npCoverHiFailedUrl = $state('')
  const npCoverSrc = $derived.by(() => {
    if (!playing) return ''
    const hi = hiResThumb(playing.thumbnail)
    return hi && hi !== npCoverHiFailedUrl ? hi : coverUrl
  })

  // ---- home shelves --------------------------------------------------------
  // A shelf is one horizontally scrolling row; the column count follows the
  // shelf width (container queries in CSS). This action marks the section
  // when its row overflows, which is what shows the ‹ › buttons. One
  // ResizeObserver per shelf node — the node lives as long as its section.
  function shelfOverflow(row: HTMLElement): { destroy: () => void } {
    const section = row.closest('.shelf') as HTMLElement | null
    const update = (): void => {
      if (!section) return
      const over = row.scrollWidth > row.clientWidth + 2
      section.dataset.overflow = over ? '1' : ''
      section.dataset.atStart = row.scrollLeft <= 2 ? '1' : ''
      section.dataset.atEnd = row.scrollLeft + row.clientWidth >= row.scrollWidth - 2 ? '1' : ''
    }
    const ro = new ResizeObserver(update)
    ro.observe(row)
    row.addEventListener('scroll', update, { passive: true })
    update()
    return {
      destroy: () => {
        ro.disconnect()
        row.removeEventListener('scroll', update)
      }
    }
  }
  function scrollShelf(e: MouseEvent, dir: 1 | -1): void {
    const row = (e.currentTarget as HTMLElement)
      .closest('.shelf')
      ?.querySelector('.shelf-row') as HTMLElement | null
    if (!row) return
    row.scrollBy({
      left: dir * row.clientWidth,
      behavior: prefersReducedMotion.current ? 'auto' : 'smooth'
    })
  }

  // Svelte transitions run through the Web Animations API, which the CSS
  // prefers-reduced-motion rule in app.css can't reach — route their
  // durations through this instead.
  function motion(ms: number): number {
    return prefersReducedMotion.current ? 0 : ms
  }

  // Top-bar search field (the Search view no longer has its own input).
  let topSearchEl = $state<HTMLInputElement | null>(null)

  // ---- up next (Now-playing column + queue popover) ------------------------
  // What plays after the current track, by the same rules playNext uses:
  // the user's queue first, then the source list. Shuffle picks at random
  // at the moment of the switch, so its "next" can't be listed honestly —
  // the UI says so instead of inventing an order.
  const UP_NEXT_LIMIT = 20
  const upNext = $derived.by(() => {
    const p = playing
    if (!p) return { queued: [] as SearchResult[], next: [] as SearchResult[], mode: 'list' as const }
    const queued = userQueue
    if (repeatMode === 'one') return { queued, next: [] as SearchResult[], mode: 'repeatOne' as const }
    if (shuffleMode) return { queued, next: [] as SearchResult[], mode: 'shuffle' as const }
    const list = p.sourceList
    const idx = list.findIndex((r) => r.id === p.id)
    const next: SearchResult[] = []
    if (idx >= 0) {
      for (let k = 1; k < list.length && next.length < UP_NEXT_LIMIT; k++) {
        const j = idx + k
        if (j >= list.length && repeatMode !== 'all') break
        const r = list[j % list.length]
        if (!r.unavailable && r.id !== p.id) next.push(r)
      }
    }
    return { queued, next, mode: 'list' as const }
  })
  function playQueuedAt(i: number): void {
    if (!playing) return
    const track = userQueue[i]
    if (!track) return
    userQueue = userQueue.filter((_, k) => k !== i)
    void playTrack(track, playing.sourceList, {
      id: playing.sourceListId,
      title: playing.sourceListTitle
    })
  }
  function playFromUpNext(track: SearchResult): void {
    if (!playing) return
    void playTrack(track, playing.sourceList, {
      id: playing.sourceListId,
      title: playing.sourceListTitle
    })
  }
  // Queue popover over the player — for when the window is too narrow for
  // the Now-playing column (which shows the same list).
  let queueOpen = $state(false)
  // Hidden (column open / mini mode / nothing loaded) = closed: otherwise it
  // would pop back by itself after a resize, and Escape would be swallowed
  // by an invisible popover.
  $effect(() => {
    if (npVisible || miniMode || !playing) queueOpen = false
  })

  // Cover of whatever is loaded (playing or paused) — drives the accent and
  // the blurred window background. Resolved ONCE per track: downloadedIds is
  // read untracked, so a track finishing its download mid-song doesn't swap
  // https:// → media:// and restart the crossfade / re-derive the colour.
  const coverUrl = $derived.by(() => {
    const p = playing
    if (!p) return ''
    const id = p.id
    const thumb = p.thumbnail
    return untrack(() => thumbnailFor(id, thumb))
  })
  // downloadedIds is filled from whatever lists were opened this session, so
  // a track started from the restored session (or the queue) could show the
  // player's download chip as "not downloaded". Ask about the loaded track
  // itself whenever it changes.
  $effect(() => {
    const id = playing?.id
    if (!id) return
    untrack(() => {
      if (!downloadedIds.has(id)) void refreshDownloadStatus([{ id } as SearchResult])
    })
  })
  // Backdrop brightness: 0.5 for ordinary covers, lower for bright ones so
  // text keeps its contrast over a near-white cover.
  let coverDim = $state(0.5)
  $effect(() => {
    const url = coverUrl
    let stale = false
    if (!url) {
      applyPalette(BRAND_PALETTE)
    } else {
      void analyzeCover(url).then((a) => {
        if (stale) return
        applyPalette(a?.palette ?? BRAND_PALETTE)
        const lum = a?.luminance ?? 0
        coverDim = lum <= 0.2 ? 0.5 : Math.max(0.24, 0.5 - (lum - 0.2) * 0.5)
      })
    }
    return () => {
      stale = true
    }
  })
  let playError = $state('')
  // The videoId we're currently resolving (during the ~500ms-4s gap
  // between click and the audio element getting a streamUrl). The list
  // shows a small ring overlaid on that row's thumbnail. NULL when not
  // actively resolving — distinct from `playing.id` which still points
  // at the previously-playing track during a resolve.
  let resolvingId = $state<string | null>(null)
  // Two audio elements so we can crossfade between tracks. Their
  // "role" (active vs inactive) flips on each crossfade; `audioEl`
  // below is a derived alias for the currently-active one so the
  // rest of the playback machinery (togglePlay / seek / volume /
  // onCanPlay listener) doesn't need to know which one is which.
  let audioElA = $state<HTMLAudioElement>()
  let audioElB = $state<HTMLAudioElement>()
  let audioASrc = $state('')
  let audioBSrc = $state('')
  let activeAudioKey = $state<'a' | 'b'>('a')
  // Per-audio gain multiplier (0..1). The $effect at the bottom of
  // this block applies `volume * gain*` to the audio element so the
  // user-controlled master volume + the per-audio fade level
  // combine into the actual element.volume.
  let gainA = $state(1)
  let gainB = $state(0)
  const audioEl = $derived(activeAudioKey === 'a' ? audioElA : audioElB)
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
  // The track id the pending resume position belongs to. The resume seek is
  // applied ONLY when the next resolved track matches this id — otherwise a
  // fresh play of a DIFFERENT track as the first action after launch would
  // inherit the saved position and start mid-track (the "plays from the
  // middle" bug). One-shot: cleared the moment any track is played.
  let pendingResumeId = $state<string | null>(null)

  // ---- crossfade ---------------------------------------------------------
  // User-configurable in Settings → "Crossfade duration". 0 = disabled
  // (next track starts the instant the previous ends). When > 0, the
  // last `crossfadeDuration` seconds of one track overlap with the
  // start of the next via gain ramps on both audio elements.
  let crossfadeDuration = $state(0)
  // True while a fade is actively ramping gains. Set on fade start,
  // cleared on fade end OR if the fade is cancelled (manual prev/next).
  let crossfadeActive = $state(false)
  // Latches at fade-start to prevent timeupdate from re-triggering the
  // same fade on every tick. Resets on natural-end-of-fade + on every
  // manual track switch (so the NEXT track's end can fade as well).
  let crossfadeTriggered = $state(false)
  let crossfadeRaf: number | null = null

  // Sync element volume with master + per-audio gain. Runs whenever
  // volume, muted, or either gain changes — the simplest way to keep
  // crossfade ramps audible without manually poking each audio.
  $effect(() => {
    if (audioElA) {
      audioElA.volume = Math.max(0, Math.min(1, volume * gainA))
      audioElA.muted = muted
    }
    if (audioElB) {
      audioElB.volume = Math.max(0, Math.min(1, volume * gainB))
      audioElB.muted = muted
    }
  })

  // ---- equalizer (Web Audio) ---------------------------------------------
  // 10-band graphic EQ. The band centre frequencies are the ISO octave
  // set every player uses (foobar/AIMP/etc), so presets feel familiar.
  const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
  const EQ_BAND_LABELS = ['32', '64', '125', '250', '500', '1K', '2K', '4K', '8K', '16K']
  // Preset → per-band dB gains. 'custom' isn't here — it's the implicit
  // label after a manual slider tweak. Values hand-tuned to taste.
  const EQ_PRESETS: Record<string, number[]> = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    treble: [0, 0, 0, 0, 0, 0, 2, 4, 5, 6],
    vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    rock: [4, 3, 1, -1, -1, 1, 2, 3, 4, 4],
    pop: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2],
    electronic: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5],
    jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
    classical: [4, 3, 2, 0, -1, -1, 0, 2, 3, 4],
    hiphop: [6, 5, 3, 1, -1, 0, 1, 2, 3, 3]
  }
  // Preset label list for the UI, in display order.
  const EQ_PRESET_ORDER = [
    'flat',
    'bass',
    'treble',
    'vocal',
    'rock',
    'pop',
    'electronic',
    'jazz',
    'classical',
    'hiphop'
  ]

  let eqEnabled = $state(false)
  let eqPreset = $state('flat')
  let eqGains = $state<number[]>(EQ_PRESETS.flat.slice())

  // Web Audio graph — built lazily the first time the EQ is switched on
  // (or on launch if it was left on). We deliberately DON'T build it for
  // users who never touch the EQ: createMediaElementSource is a one-way
  // door (the element's audio routes through Web Audio forever after),
  // so a user who never wants the EQ keeps the plain element→speakers
  // path and zero risk of a Web Audio quirk silencing playback.
  let audioCtx: AudioContext | null = null
  let eqFilters: BiquadFilterNode[] = []
  let audioGraphReady = false

  function ensureAudioGraph(): void {
    if (audioGraphReady) return
    if (!audioElA || !audioElB) return
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctx()
      const srcA = audioCtx.createMediaElementSource(audioElA)
      const srcB = audioCtx.createMediaElementSource(audioElB)
      eqFilters = EQ_FREQS.map((freq, i) => {
        const f = audioCtx!.createBiquadFilter()
        f.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking'
        f.frequency.value = freq
        if (f.type === 'peaking') f.Q.value = 1.41
        f.gain.value = 0
        return f
      })
      // Chain the filters in series, both sources feed the head, the
      // tail goes to the speakers.
      for (let i = 0; i < eqFilters.length - 1; i++) eqFilters[i].connect(eqFilters[i + 1])
      srcA.connect(eqFilters[0])
      srcB.connect(eqFilters[0])
      eqFilters[eqFilters.length - 1].connect(audioCtx.destination)
      audioGraphReady = true
      applyEqGains()
      // Route the brand-new context to the user-picked output device. Once
      // audio flows through this graph the elements' sinkIds are bypassed —
      // without this the output-device setting would silently die the moment
      // the EQ comes on.
      if (savedOutputDevice) void applyAudioSink(savedOutputDevice.id)
    } catch (err) {
      console.warn('[eq] audio graph setup failed:', err)
      audioGraphReady = false
    }
  }

  // Push the current gains (or flat-0 when disabled) onto the filters.
  // setTargetAtTime ramps smoothly so slider drags don't click.
  function applyEqGains(): void {
    if (!audioGraphReady || !audioCtx) return
    const now = audioCtx.currentTime
    for (let i = 0; i < eqFilters.length; i++) {
      const target = eqEnabled ? eqGains[i] ?? 0 : 0
      eqFilters[i].gain.setTargetAtTime(target, now, 0.02)
    }
  }

  // Resume the context if the autoplay policy parked it suspended —
  // called from playTrack (a user gesture).
  function resumeAudioCtxIfNeeded(): void {
    if (audioCtx && audioCtx.state === 'suspended') void audioCtx.resume()
  }

  // ---- audio output device --------------------------------------------------
  // Routes playback to a user-picked output device (Settings → "Устройство
  // вывода"). The streamer use case: send music to a separate virtual device
  // (VB-Cable / voicemeeter bus) so it stays out of the Twitch VOD while the
  // rest of the desktop audio is captured normally.
  //
  // Persisted as {id, label} in config (label = human-readable snapshot for
  // the "device missing" warning). Empty id / null = system default.
  let savedOutputDevice = $state<{ id: string; label: string } | null>(null)
  let outputDevices = $state<Array<{ id: string; label: string }>>([])
  // Bound to the Settings <select>; '' = system default.
  let selectedOutputId = $state('')

  async function refreshOutputDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      outputDevices = all
        // Drop the 'default'/'communications' pseudo-devices — our own
        // "Системное по умолчанию" option (id '') covers the default, and
        // duplicating the same physical device under three ids only
        // confuses the picker.
        .filter(
          (d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
        )
        .map((d) => ({ id: d.deviceId, label: d.label || d.deviceId }))
    } catch (err) {
      console.warn('[audio-out] enumerateDevices failed:', err)
      outputDevices = []
    }
  }

  // Applies a sink to EVERYTHING that produces sound: both crossfade audio
  // elements AND the EQ AudioContext. The ctx part is load-bearing: once the
  // EQ graph exists, audio flows element → MediaElementSource → filters →
  // ctx.destination, and the ELEMENT's sinkId is bypassed — without
  // AudioContext.setSinkId the picker would silently stop working the moment
  // the user enables the equalizer. '' = system default for both APIs.
  //
  // Returns 'applied' (≥1 sink actually set), 'failed' (some sink rejected —
  // device gone mid-flight etc.), or 'noop' — there was NOTHING to apply to.
  // 'noop' is a real state, not an error: the audio elements live inside
  // {#if playing} and don't exist until something plays (and audioCtx only
  // exists with EQ on). Callers must NOT treat 'noop' as proof the id works.
  async function applyAudioSink(id: string): Promise<'applied' | 'noop' | 'failed'> {
    let touched = 0
    let failed = 0
    for (const el of [audioElA, audioElB]) {
      if (!el) continue
      try {
        await el.setSinkId(id)
        touched++
      } catch (err) {
        console.warn('[audio-out] element setSinkId failed:', err)
        failed++
      }
    }
    if (audioCtx) {
      // AudioContext.setSinkId is Chromium 110+; not yet in the TS dom lib.
      const ctx = audioCtx as unknown as { setSinkId?: (id: string) => Promise<void> }
      if (typeof ctx.setSinkId === 'function') {
        try {
          await ctx.setSinkId(id)
          touched++
        } catch (err) {
          console.warn('[audio-out] AudioContext setSinkId failed:', err)
          failed++
        }
      }
    }
    if (failed > 0) return 'failed'
    return touched > 0 ? 'applied' : 'noop'
  }

  // Re-apply the saved sink whenever an audio element (RE)MOUNTS. This is
  // the load-bearing piece (review finding): the elements live inside
  // {#if playing} — they don't exist at startup, and disconnect() unmounts +
  // later recreates them — so any one-shot apply routes nothing and fresh
  // elements come up on the system default sink, silently leaking audio to
  // the wrong device (the exact thing the streamer use case must prevent).
  // Same project lesson as the ctx-menu clamp: "do X every time this
  // state-driven element appears" belongs in a $effect keyed on the state.
  $effect(() => {
    const a = audioElA
    const b = audioElB
    const dev = savedOutputDevice
    if (!dev || (!a && !b)) return
    void applyAudioSink(dev.id)
  })

  // Settings "Сохранить": validate + apply first, persist only when the id
  // is at least known-good — a broken device id must not get stranded in
  // the config with a success toast.
  async function saveOutputDevice(): Promise<void> {
    const id = selectedOutputId
    const label = id === '' ? '' : (outputDevices.find((d) => d.id === id)?.label ?? savedOutputDevice?.label ?? '')
    // With nothing playing there are no sinks to try (applyAudioSink would
    // return a vacuous 'noop'), so the enumeration check is the only
    // validation available — it rejects picking the "⚠ (не найдено)" option
    // of an absent device while idle.
    if (id !== '' && !outputDevices.some((d) => d.id === id)) {
      showToast(t('settings.output.applyFailed'))
      return
    }
    const res = await applyAudioSink(id)
    if (res === 'failed') {
      showToast(t('settings.output.applyFailed'))
      return
    }
    // 'applied' — routed live; 'noop' — nothing playing yet, the mount
    // $effect above routes the elements the moment they appear.
    if (id === '') {
      await window.api.settings.setAudioOutputDevice(null)
      savedOutputDevice = null
    } else {
      await window.api.settings.setAudioOutputDevice({ id, label })
      savedOutputDevice = { id, label }
    }
    showToast(t('settings.output.saved'))
  }

  async function persistEqualizer(): Promise<void> {
    try {
      await window.api.settings.setEqualizer({
        enabled: eqEnabled,
        preset: eqPreset,
        // eqGains is a Svelte $state array — a reactive Proxy. Electron
        // IPC serialises arguments with the structured-clone algorithm,
        // which throws on the proxy ("object could not be cloned"); the
        // rejection was swallowed by the catch below, so the EQ never
        // actually persisted. $state.snapshot yields a plain, clone-safe
        // copy. (This is why the EQ alone failed to save while every
        // other setting — all primitives — round-tripped fine.)
        gains: $state.snapshot(eqGains)
      })
    } catch (err) {
      console.warn('[eq] persist failed', err)
    }
  }

  function toggleEqualizer(on: boolean): void {
    eqEnabled = on
    void persistEqualizer()
    if (!on) {
      // Flatten the bands to 0 dB — transparent. We leave the graph
      // built (createMediaElementSource is one-way) but it passes audio
      // through unchanged.
      applyEqGains()
      return
    }
    // Turning ON. The crossorigin attribute just flipped to 'anonymous'
    // (reactive). If a track is already loaded it was fetched WITHOUT
    // the CORS request, so its MediaElementSource would be tainted →
    // silent. Wait a tick for the attribute to hit the DOM, reload the
    // active element so it re-fetches with CORS, then build the graph.
    void (async () => {
      await tick()
      ensureAudioGraph()
      resumeAudioCtxIfNeeded()
      reloadActiveForEq()
      applyEqGains()
    })()
  }

  // Re-fetch the active audio element's current src (now that
  // crossorigin is set) without losing the play position. Only used
  // when the EQ is switched on mid-playback — a fresh track started
  // after EQ-on already loads with crossorigin and needs no reload.
  function reloadActiveForEq(): void {
    const el = audioEl
    if (!el || !el.src) return
    const pos = el.currentTime
    const wasPlaying = !el.paused
    const onReady = (): void => {
      el.removeEventListener('canplay', onReady)
      try {
        el.currentTime = pos
      } catch {
        // some streams reject seek before fully buffered — ignore
      }
      if (wasPlaying) void el.play().catch(() => {})
    }
    el.addEventListener('canplay', onReady)
    el.load()
  }

  function applyEqPreset(name: string): void {
    const preset = EQ_PRESETS[name]
    if (!preset) return
    eqPreset = name
    eqGains = preset.slice()
    applyEqGains()
    void persistEqualizer()
  }

  function setEqBand(index: number, db: number): void {
    const next = eqGains.slice()
    next[index] = Math.max(-12, Math.min(12, db))
    eqGains = next
    // Any manual tweak drops the preset to "custom" unless the result
    // happens to still match the active preset exactly.
    eqPreset = EQ_PRESET_ORDER.find((p) => arraysEqual(EQ_PRESETS[p], next)) ?? 'custom'
    applyEqGains()
    void persistEqualizer()
  }

  function arraysEqual(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i])
  }

  // Cheap buffering breadcrumb. The "lag" report wasn't reproducible,
  // so rather than chase a ghost we just leave a timestamped trace in
  // main.log (via the console mirror) if the audio element stalls or
  // has to wait for data — next time it happens there's evidence.
  function onAudioStall(key: 'a' | 'b', kind: 'stalled' | 'waiting'): void {
    if (key !== activeAudioKey) return
    console.warn(
      `[audio] ${kind} on ${key} at t=${currentTime.toFixed(1)}s` +
        ` (track=${playing?.id ?? '—'}, downloading=${downloadingIds.size})`
    )
  }

  // Keep navigator.mediaSession in sync with the current track + play
  // state. Chromium forwards this to OS-level media controls (Windows
  // SMTC / macOS Now Playing / Linux MPRIS), so the lockscreen widget
  // and dedicated keyboard media keys both "just work" without any
  // native modules. The action handlers themselves are wired once in
  // onMount; only the metadata + playbackState change per track.
  $effect(() => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    if (!playing) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = 'none'
      return
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: playing.title,
      artist: playing.artist,
      album: playing.sourceListTitle ?? '',
      // Pass the raw YT thumbnail URL — Chromium fetches it and hands
      // the bitmap to the OS. We don't use the media:// cached path
      // here because SMTC / Now Playing don't speak our protocol.
      artwork: playing.thumbnail
        ? [
            { src: playing.thumbnail, sizes: '256x256', type: 'image/jpeg' },
            { src: playing.thumbnail, sizes: '512x512', type: 'image/jpeg' }
          ]
        : []
    })
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  })

  // Push the current position/duration into the OS media session. A session
  // that reports a valid position state reads as "full-featured" to Windows
  // SMTC, which makes it more likely to stay the active session that hardware
  // media keys route to (the keys are flaky mainly when another running media
  // app — e.g. Spotify — grabbed the session, or Chromium let it go stale).
  // Called from the active audio element's timeupdate / loadedmetadata /
  // seeked. setPositionState throws on inconsistent values, hence the guard.
  function syncMediaPositionState(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    if (typeof navigator.mediaSession.setPositionState !== 'function') return
    try {
      if (playing && Number.isFinite(duration) && duration > 0) {
        navigator.mediaSession.setPositionState({
          duration,
          position: Math.max(0, Math.min(currentTime, duration)),
          playbackRate: 1
        })
      } else {
        navigator.mediaSession.setPositionState()
      }
    } catch {
      // inconsistent position/duration (e.g. mid-load) — ignore
    }
  }

  // ---- follow-scroll: keep the playing track visible -----------------------
  // When the open playlist IS the one playing, track changes scroll the
  // highlighted row into view. block:'nearest' = zero movement when the row
  // is already visible, minimal movement otherwise — so shuffle jumps don't
  // centre-snap the list around. Two guards keep it polite:
  //  - lastManualScrollAt: skip while the user drove the list in the last 5s
  //    (wheel listener in onMount) so we never fight their scrolling;
  //  - lastAutoScrollKey: `playing` is re-created by unrelated updates (like
  //    toggles, sourceList syncs), so we only act when the actual
  //    (track, playlist, view) combination changes — not on object churn.
  let lastManualScrollAt = 0
  let lastAutoScrollKey = ''
  $effect(() => {
    const id = playing?.id
    const srcId = playing?.sourceListId
    // Tracking playlistView/playlistLoading is load-bearing: on navigation
    // back into the playing playlist the rows render ASYNCHRONOUSLY — on the
    // first flush the list is empty (or, for Downloaded, still shows the
    // previous playlist). Without these deps the effect would fire once
    // against the stale/empty DOM and never retry.
    const rowCount = playlistView?.tracks.length ?? 0
    const key = `${id}|${openPlaylistId}|${view}`
    if (!id || miniMode || view !== 'playlist' || playlistLoading) return
    if (!openPlaylistId || openPlaylistId !== srcId) return
    if (rowCount === 0) return
    if (key === lastAutoScrollKey) return
    if (Date.now() - lastManualScrollAt < 5000) {
      // Consume the key WITHOUT scrolling — once the user stops scrolling we
      // shouldn't later yank the list for a track change they already saw.
      lastAutoScrollKey = key
      return
    }
    // NB: with a duplicate videoId in the playlist this picks the FIRST
    // matching row — consistent with the player itself (playNext's findIndex
    // also collapses to the first instance), so the scroll follows the
    // player's own notion of "current".
    const row = document.querySelector('.track-list .track-row.current')
    // Row not rendered yet → do NOT consume the key; the playlistView /
    // playlistLoading deps re-fire this effect when the rows land.
    if (!row) return
    lastAutoScrollKey = key
    row.closest('.track-li')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

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
    pendingResumeId = pendingResumeTime !== null ? saved.track.id : null
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

  // Artist subscriber line normaliser. YT returns one of two shapes:
  //   "1.2K subscribers" / "1.2 тыс. подписчиков"  — already complete
  //   "1.2K" / "138"                              — bare count, no unit
  // We tack on a localised "subscribers" suffix only when the second
  // case is detected (no letter past the count in our locale's set).
  function formatSubscriberLine(raw: string, lng: Lang): string {
    if (!raw) return ''
    const trimmed = raw.trim()
    // Already carries word characters past the count → assume complete.
    // Cyrillic "тыс." / "млн" + Latin "K"/"M" thousand-suffixes don't
    // count as the word — actual subscriber word is e.g. "subscribers"
    // / "подписчиков", which is always >3 letters. Detect that.
    const wordMatch = /[A-Za-zА-Яа-яЁё]{4,}/.exec(trimmed)
    if (wordMatch) return trimmed
    return `${trimmed} ${t('artist.subscribers')}`
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
    // Dragging the slider up while muted unmutes — matches how every
    // other music player behaves. The $effect higher up applies the
    // new volume + mute state to both audio elements.
    if (v > 0 && muted) muted = false
  }
  function toggleMute(): void {
    muted = !muted
  }

  // Mini-player volume popup visibility. Driven by EXPLICIT mouse/focus events
  // rather than CSS :hover — paid for in blood: the mini-shell is a
  // `-webkit-app-region: drag` surface, and Chromium suppresses CSS :hover
  // over a drag region, so the hover-reveal never fired in the real Electron
  // window (it "worked" only in a plain-browser test harness, which has no
  // drag region). no-drag elements still receive JS pointer events (that's why
  // the click-to-mute worked), so we wire onpointerenter/leave/focus directly.
  // A short close delay bridges the gap between the button and the popup so
  // moving the cursor across it doesn't snap the slider shut.
  let miniVolOpen = $state(false)
  let miniVolCloseTimer: ReturnType<typeof setTimeout> | null = null
  function openMiniVol(): void {
    if (miniVolCloseTimer) {
      clearTimeout(miniVolCloseTimer)
      miniVolCloseTimer = null
    }
    miniVolOpen = true
  }
  function closeMiniVolSoon(): void {
    if (miniVolCloseTimer) clearTimeout(miniVolCloseTimer)
    miniVolCloseTimer = setTimeout(() => {
      miniVolOpen = false
      miniVolCloseTimer = null
    }, 220)
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
  // Bound to the rendered menu node so the clamp effect can measure + position
  // it. Goes null when the menu closes (the {#if} removes the node).
  let ctxMenuEl = $state<HTMLElement | null>(null)

  // Keeps the context menu inside the window on EVERY open. The menu opens at
  // the raw click coords (ctxMenu.x/y via the style: directives), so a click
  // near the right/bottom edge would spill it — and clip its lower items —
  // off-screen. This effect re-runs whenever `ctxMenu` changes (each open is a
  // fresh object) or the node mounts: it measures the real rendered size
  // (offsetWidth/Height — layout dims, unaffected by the scale transition,
  // which is a CSS transform) and writes clamped left/top straight onto the
  // node, with an 8px margin.
  //
  // Why an $effect and NOT a `use:` action (paid for in blood): an action's
  // body only runs on element CREATION. On a second right-click WITHOUT closing
  // the menu, Svelte REUSES the same .ctx-menu node (only the style: coords
  // update), so the action never re-ran and the second menu spilled off-screen
  // even though the first was clamped. The effect tracks ctxMenu, so it fires
  // on every open including node reuse. The rAF retry covers a layout that
  // isn't final on the first tick.
  $effect(() => {
    const menu = ctxMenu
    const node = ctxMenuEl
    if (!menu || !node) return
    const place = (): void => {
      const margin = 8
      const x = Math.max(
        margin,
        Math.min(menu.x, window.innerWidth - node.offsetWidth - margin)
      )
      const y = Math.max(
        margin,
        Math.min(menu.y, window.innerHeight - node.offsetHeight - margin)
      )
      node.style.left = `${x}px`
      node.style.top = `${y}px`
    }
    place()
    const raf = requestAnimationFrame(place)
    return () => cancelAnimationFrame(raf)
  })

  // ---- add-to-playlist modal --------------------------------------------
  // Opened from the track context menu. Holds the track being added, the
  // user's editable playlists (lazy-loaded once, then cached), a "Recent"
  // subset shown first, a live search filter, and a show-all toggle so the
  // tile grid stays compact in a small window. `busyId` marks the tile
  // whose add is in flight (spinner + disabled); the modal closes on a
  // successful add, so there's no persistent "added" state to track.
  interface AddToPlaylistState {
    track: SearchResult
    playlists: HomeItem[]
    recent: RecentPlaylist[]
    loading: boolean
    query: string
    showAll: boolean
    busyId: string | null
  }
  let addModal = $state<AddToPlaylistState | null>(null)
  // Editable-playlist cache so re-opening the modal is instant. Dropped on
  // auth refresh / disconnect alongside the other library caches.
  let addablePlaylistsCache: HomeItem[] | null = null
  // How many tiles to show before the "Show all" toggle reveals the rest.
  const ADD_MODAL_COLLAPSED_COUNT = 6

  // Reusable Material-style icon path strings for context-menu items.
  // 24×24 viewBox, single-path. Mirror YT Music's vocabulary so users
  // get instant visual recognition.
  const CTX_ICONS = {
    // playlist_play — list of lines + right-pointing play arrow
    playNext: 'M3 10h11v2H3v-2zm0-4h11v2H3V6zm0 8h7v2H3v-2zm14-4v8l6-4-6-4z',
    // playlist_add — list of lines + plus
    addToQueue: 'M14 10H2v2h12v-2zm0-4H2v2h12V6zM2 14h8v2H2v-2zm19-3h-2V8h-2v3h-2v2h2v3h2v-3h2v-2z',
    // library_add / playlist-with-plus — list of lines + a boxed plus,
    // distinct from addToQueue so "add to queue" and "add to playlist"
    // don't read as the same action in the menu.
    addToPlaylist: 'M2 6v2h12V6H2zm0 4v2h9v-2H2zm0 4v2h9v-2H2zm14-2v3h-3v2h3v3h2v-3h3v-2h-3v-3h-2z',
    // push_pin — slanted thumbtack (pinned indicator)
    pin: 'M16 9V4l1-1V1H7v2l1 1v5l-2 2v2h5v7l1 1 1-1v-7h5v-2l-2-2z',
    // push_pin outline — same pin shape but outline-only
    unpin: 'M14 4v5l2 2v2h-5v7l-1 1-1-1v-7H4v-2l2-2V4H4V2h14v2h-2zm-2 0H8v5l-2 2h10l-2-2V4z',
    // favorite (filled heart) — like
    like: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
    // favorite_border (outline heart) — unlike
    unlike: 'M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55l-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z',
    // radio — broadcast tower with dot
    radio: 'M3.24 6.15C2.51 6.43 2 7.17 2 8v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8c0-1.1-.9-2-2-2H8.3l8.26-3.34L15.88 1 3.24 6.15zM7 20c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-8h-2v-2h-2v2H4V8h16v4z',
    // delete (trash can) — remove from playlist
    removeFromPlaylist: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    // link (chain) — copy YouTube link to the track
    copyLink: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z'
  }

  // Copies a shareable YouTube link for the track to the clipboard. Uses the
  // music.youtube.com/watch?v=<id> form — same as YT Music's own Share — so
  // the link opens as a music track, not a plain video. Clipboard write goes
  // through main (Electron's clipboard module) so it's reliable regardless of
  // the renderer's secure-context status.
  async function copyTrackLink(track: SearchResult): Promise<void> {
    const url = `https://music.youtube.com/watch?v=${track.id}`
    const ok = await window.api.app.copyText(url)
    showToast(ok ? t('ctx.linkCopied') : t('ctx.linkCopyFailed'))
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
    items.push({
      label: t('ctx.startRadio'),
      iconPath: CTX_ICONS.radio,
      onSelect: () => void startRadioFromTrack(track),
      disabled: track.unavailable
    })
    items.push({
      label: t('ctx.addToPlaylist'),
      iconPath: CTX_ICONS.addToPlaylist,
      onSelect: () => void openAddToPlaylist(track),
      disabled: track.unavailable
    })
    // Copy a shareable YouTube link. Gated to rows with a real videoId —
    // unavailable rows carry a synthetic "__unavail__…" id (no real video),
    // so there's nothing to link to.
    if (!track.unavailable && !track.id.startsWith('__')) {
      items.push({
        label: t('ctx.copyLink'),
        iconPath: CTX_ICONS.copyLink,
        onSelect: () => void copyTrackLink(track)
      })
    }
    // Pin / unpin only makes sense in a playlist view (search results
    // aren't a list with persistent order). Detect by: openPlaylistId
    // is set AND this menu was opened on a row from the playlist view.
    // Pin is also meaningless on the radio view — radio is ephemeral.
    const isPlaylistRow =
      openPlaylistId != null &&
      !isRadioId(openPlaylistId) &&
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
    // Remove from playlist — only on rows from a real, user-editable playlist:
    // NOT Liked Music (that's the heart's job), NOT the Downloaded virtual
    // list (local files, no server playlist), NOT radio. Needs the row's
    // setVideoId — edit_playlist identifies the row to drop by it.
    const isRemovableRow =
      isPlaylistRow &&
      !isLikedMusicId(openPlaylistId) &&
      openPlaylistId !== DOWNLOADED_ID &&
      !!track.setVideoId
    if (isRemovableRow) {
      items.push({
        label: t('ctx.removeFromPlaylist'),
        iconPath: CTX_ICONS.removeFromPlaylist,
        danger: true,
        onSelect: () => void removeTrackFromOpenPlaylist(track)
      })
    }
    return items
  }

  // ---- Like + Radio actions ---------------------------------------------

  // Liked state shared by every view. A row only carries `liked` when YT
  // sent it (playlists, Liked Music); Downloaded rows are built from local
  // files and never have it, so their heart showed empty for liked tracks
  // and a click tried to like them again. We keep the Liked Music ids
  // (fetched in the background after connect, refreshed whenever that
  // playlist is opened) plus this session's own toggles, and every heart
  // reads through isLiked().
  let likedMusicIds = $state.raw<Set<string>>(new Set())
  let likeOverrides = $state.raw<Map<string, boolean>>(new Map())

  function isLiked(track: { id: string; liked?: boolean }): boolean {
    const override = likeOverrides.get(track.id)
    if (override !== undefined) return override
    return !!track.liked || likedMusicIds.has(track.id)
  }

  function setLikeOverride(videoId: string, liked: boolean): void {
    const next = new Map(likeOverrides)
    next.set(videoId, liked)
    likeOverrides = next
  }

  function rememberLikedMusic(tracks: SearchResult[]): void {
    likedMusicIds = new Set(tracks.filter((t) => !t.unavailable).map((t) => t.id))
  }

  async function loadLikedMusicIds(): Promise<void> {
    try {
      const data = await window.api.metadata.playlist('VLLM')
      rememberLikedMusic(data.tracks)
    } catch (err) {
      console.warn('[likes] Liked Music prefetch failed:', err)
    }
  }

  // Mirror the new liked state across every place a copy of this track
  // lives — playlistView, searchResults, player's sourceList — so the
  // inline heart and any future row re-renders all agree without waiting
  // for a re-fetch. Called both optimistically (before the IPC returns)
  // and on revert if the API said no.
  function setTrackLikedEverywhere(videoId: string, liked: boolean): void {
    if (playlistView) {
      let changed = false
      const next = playlistView.tracks.map((t) => {
        if (t.id === videoId && t.liked !== liked) {
          changed = true
          return { ...t, liked }
        }
        return t
      })
      if (changed) playlistView = { ...playlistView, tracks: next }
    }
    if (searchResults.length > 0) {
      let changed = false
      const next = searchResults.map((t) => {
        if (t.id === videoId && t.liked !== liked) {
          changed = true
          return { ...t, liked }
        }
        return t
      })
      if (changed) searchResults = next
    }
    if (playing && playing.sourceList) {
      let changed = false
      const next = playing.sourceList.map((t) => {
        if (t.id === videoId && t.liked !== liked) {
          changed = true
          return { ...t, liked }
        }
        return t
      })
      if (changed) playing = { ...playing, sourceList: next }
    }
  }

  async function toggleTrackLike(track: SearchResult): Promise<void> {
    if (!track.id || track.unavailable) return
    const newLiked = !isLiked(track)
    // Optimistic: heart fills/empties before the network round-trip lands.
    setLikeOverride(track.id, newLiked)
    setTrackLikedEverywhere(track.id, newLiked)
    const ok = await window.api.metadata.like(track.id, newLiked)
    if (!ok) {
      // Revert and tell the user; the heart visibly snaps back so they
      // know the action didn't take.
      setLikeOverride(track.id, !newLiked)
      setTrackLikedEverywhere(track.id, !newLiked)
      showToast(t('toast.likeFailed'))
      return
    }
    // Inside the Liked Music view, an unlike removes the row from the
    // visible list immediately — otherwise the user sees an empty heart
    // sitting in their Liked playlist, which is confusing.
    if (!newLiked && isLikedMusicId(openPlaylistId) && playlistView) {
      const next = playlistView.tracks.filter((t) => t.id !== track.id)
      playlistView = { ...playlistView, tracks: next }
      syncPlayingSourceList()
    }
  }

  // ---- add-to-playlist actions ------------------------------------------

  // Opens the add-to-playlist modal for a track. Renders immediately with
  // whatever's cached (or a loading state), then fills in the playlist list
  // + recents. Lazy: the editable-playlist list is only fetched the first
  // time the modal is opened in a session.
  async function openAddToPlaylist(track: SearchResult): Promise<void> {
    if (!track.id || track.unavailable) return
    addModal = {
      track,
      playlists: addablePlaylistsCache ?? [],
      recent: [],
      loading: addablePlaylistsCache == null,
      query: '',
      showAll: false,
      busyId: null
    }
    // Recents are cheap (a config read) — always refresh them.
    void window.api.playlist.recent().then((recent) => {
      if (addModal && addModal.track.id === track.id) addModal = { ...addModal, recent }
    })
    if (addablePlaylistsCache == null) {
      try {
        const playlists = await window.api.playlist.addable()
        addablePlaylistsCache = playlists
        // Guard against the user having closed/reopened the modal meanwhile.
        if (addModal && addModal.track.id === track.id) {
          addModal = { ...addModal, playlists, loading: false }
        }
      } catch (err) {
        console.warn('[add-to-playlist] failed to load playlists:', err)
        if (addModal && addModal.track.id === track.id) {
          addModal = { ...addModal, loading: false }
        }
        showToast(t('toast.addToPlaylistLoadFailed'))
      }
    }
  }

  function closeAddToPlaylist(): void {
    addModal = null
  }

  // Performs the add. Marks the tile busy during the IPC, then CLOSES the
  // modal on success (with a confirming toast) — the user picks one playlist
  // per open, matching what feels natural here. On failure the modal stays
  // open with a toast so the user can retry or pick another.
  async function addTrackToPlaylist(playlist: HomeItem | RecentPlaylist): Promise<void> {
    if (!addModal || addModal.busyId) return
    const track = addModal.track
    addModal = { ...addModal, busyId: playlist.id }
    const snapshot: RecentPlaylist = {
      id: playlist.id,
      title: playlist.title,
      thumbnail: playlist.thumbnail
    }
    let ok = false
    try {
      ok = await window.api.playlist.addTrack(snapshot, track.id)
    } catch (err) {
      console.warn('[add-to-playlist] add failed:', err)
    }
    // Bail if the user closed/reopened the modal for another track meanwhile.
    if (!addModal || addModal.track.id !== track.id) return
    if (ok) {
      showToast(t('toast.addedToPlaylist', { title: playlist.title }))
      closeAddToPlaylist()
    } else {
      addModal = { ...addModal, busyId: null }
      showToast(t('toast.addToPlaylistFailed'))
    }
  }

  // Playlists matching the current search box, with recents hoisted to the
  // front when no query is active. Drives the modal's tile grid.
  function filteredAddPlaylists(state: AddToPlaylistState): HomeItem[] {
    const q = state.query.trim().toLowerCase()
    if (q) {
      return state.playlists.filter((p) => p.title.toLowerCase().includes(q))
    }
    // No query: show recents first (in recent order), then the rest, deduped.
    const recentIds = new Set(state.recent.map((r) => r.id))
    const recentAsItems: HomeItem[] = state.recent
      .map((r) => state.playlists.find((p) => p.id === r.id))
      .filter((p): p is HomeItem => p != null)
    const rest = state.playlists.filter((p) => !recentIds.has(p.id))
    return [...recentAsItems, ...rest]
  }

  // Removes a track from the currently-open playlist (right-click → "Remove
  // from playlist"). Confirms first (destructive, mutates the real YT
  // playlist), then optimistically drops the row from the view and keeps the
  // player's sourceList in step so prev/next don't walk a stale list. Reverts
  // + toasts on failure. Guarded to the open editable playlist; setVideoId is
  // the row id edit_playlist needs.
  async function removeTrackFromOpenPlaylist(track: SearchResult): Promise<void> {
    if (!playlistView || !openPlaylistId || !track.setVideoId) return
    const ok = await askConfirm(t('confirm.removeFromPlaylist', { title: track.title }), {
      danger: true,
      confirmLabel: t('ctx.removeFromPlaylist')
    })
    if (!ok) return
    // Snapshot for revert, then drop the row optimistically.
    const prevTracks = playlistView.tracks
    const next = prevTracks.filter((tk) => tk.setVideoId !== track.setVideoId)
    playlistView = { ...playlistView, tracks: next }
    syncPlayingSourceList()
    const done = await window.api.playlist.removeTrack(
      openPlaylistId,
      track.id,
      track.setVideoId
    )
    if (!done) {
      // Restore the row in its original place and tell the user.
      if (playlistView) {
        playlistView = { ...playlistView, tracks: prevTracks }
        syncPlayingSourceList()
      }
      showToast(t('toast.removeFromPlaylistFailed'))
      return
    }
    showToast(t('toast.removedFromPlaylist', { title: track.title }))
  }

  // Radio as a fully-fledged playlist view. We synthesize a PlaylistView
  // with title "Радиостанция · {seed}" so the user can SEE what's queued
  // (matches YT Music's "Up next" panel) instead of the queue going dark
  // and prev/next pulling tracks out of nowhere.
  const RADIO_PREFIX = 'RADIO_'
  function isRadioId(id: string | null): boolean {
    return id != null && id.startsWith(RADIO_PREFIX)
  }
  // Cache the seed metadata so back/forward navigation to a RADIO_<id>
  // entry can rebuild the view without having to crawl the source list
  // again. Cleared on auth disconnect alongside the other view caches.
  let radioSeedCache = $state<Map<string, SearchResult>>(new Map())

  async function startRadioFromTrack(track: SearchResult): Promise<void> {
    if (!track.id || track.unavailable) return
    // Cache the seed BEFORE we navigate — loadPlaylistData(RADIO_…) will
    // look it up on history forward/back.
    radioSeedCache.set(track.id, track)
    radioSeedCache = new Map(radioSeedCache)
    navigate({ kind: 'playlist', id: RADIO_PREFIX + track.id })
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
    // Window maximize/restore state — seed for the initial paint, then
    // mirror OS-driven changes (Aero snap, double-click drag region,
    // system menu) so the custom titlebar's icon stays accurate.
    void window.api.window.isMaximized().then((m) => (windowMaximized = m))
    const unsubWin = window.api.window.onMaximizeChanged((m) => (windowMaximized = m))
    const unsubMini = window.api.window.onMiniChanged((state) => {
      miniMode = state.active
      miniLayout = state.layout
    })
    // Tray menu commands — main forwards "play-pause" / "next" / "prev"
    // from the right-click tray menu items here.
    const unsubTray = window.api.tray.onCommand((cmd) => {
      if (cmd === 'play-pause') togglePlay()
      else if (cmd === 'next') void playNext({ fromUserClick: true })
      else if (cmd === 'prev') void playPrev()
    })

    // MediaSession action handlers. Cross-platform path for OS-level
    // media-key support: Windows SMTC, macOS Now Playing, Linux MPRIS —
    // Chromium forwards them all from navigator.mediaSession. Set once
    // on mount; the metadata + playbackState are kept in sync by the
    // $effect block below.
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => togglePlay())
      navigator.mediaSession.setActionHandler('pause', () => togglePlay())
      navigator.mediaSession.setActionHandler('nexttrack', () =>
        void playNext({ fromUserClick: true })
      )
      navigator.mediaSession.setActionHandler('previoustrack', () => void playPrev())
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (audioEl && typeof details.seekTime === 'number') {
          audioEl.currentTime = details.seekTime
          currentTime = details.seekTime
          syncMediaPositionState()
        }
      })
      // A more complete handler set reads as a "full" session to Windows SMTC,
      // which helps it stay the session media keys route to. Each is wrapped
      // because some platforms reject unknown actions.
      const safe = (action: MediaSessionAction, handler: MediaSessionActionHandler): void => {
        try {
          navigator.mediaSession.setActionHandler(action, handler)
        } catch {
          // action not supported on this platform — ignore
        }
      }
      safe('stop', () => {
        if (audioEl && !audioEl.paused) audioEl.pause()
      })
      safe('seekbackward', (details) => {
        if (!audioEl) return
        const step = details.seekOffset ?? 10
        audioEl.currentTime = Math.max(0, audioEl.currentTime - step)
        currentTime = audioEl.currentTime
        syncMediaPositionState()
      })
      safe('seekforward', (details) => {
        if (!audioEl) return
        const step = details.seekOffset ?? 10
        audioEl.currentTime = Math.min(audioEl.duration || audioEl.currentTime, audioEl.currentTime + step)
        currentTime = audioEl.currentTime
        syncMediaPositionState()
      })
    }
    // Silent reconnect just refreshed cookies in main — drop the
    // logged-in-required caches and re-fetch whatever the user is
    // currently looking at. Stops the "empty Library on first launch
    // after upgrade until you Disconnect+Connect" bug.
    const unsubAccess = window.api.auth.onNeedsAccess((id) => {
      accessDialog = { browser: browserName(id) }
    })
    const unsubAuth = window.api.auth.onRefreshed(() => {
      console.log('[renderer] auth refreshed — re-fetching current view')
      homeSections = null
      libraryPlaylists = null
      pinnedPlaylists = []
      // Drop the editable-playlist cache so the add-to-playlist modal re-
      // fetches against the refreshed session next time it's opened.
      addablePlaylistsCache = null
      void loadPinned()
      void loadLikedMusicIds()
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

    // Follow-scroll guard: a wheel anywhere means the user is driving the
    // list — pause the playing-track auto-scroll for a few seconds so it
    // never yanks the list out from under them. (scroll events are NOT used
    // here: our own smooth scrollIntoView fires those too.)
    const onWheelManual = (): void => {
      lastManualScrollAt = Date.now()
    }
    window.addEventListener('wheel', onWheelManual, { passive: true })

    // Context-menu dismissal: any click outside the menu OR an ESC press
    // closes it. The menu itself stops propagation on its own clicks so
    // picking an item doesn't immediately re-close before the action
    // fires (handler order: item onSelect → closeCtxMenu inside the
    // item-click handler in the menu DOM).
    const onWindowMouseDown = (e: MouseEvent): void => {
      const el = e.target as HTMLElement | null
      if (queueOpen && !(el && el.closest('.queue-pop, .queue-btn'))) queueOpen = false
      if (!ctxMenu) return
      if (el && el.closest('.ctx-menu')) return
      closeCtxMenu()
    }
    const onWindowKeyDown = (e: KeyboardEvent): void => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.code === 'KeyF' &&
        topSearchEl &&
        !confirmDialog &&
        !addModal &&
        !accessDialog
      ) {
        e.preventDefault()
        topSearchEl.focus()
        topSearchEl.select()
        return
      }
      // Playback hotkeys. Not while typing, not while a dialog is open, and
      // Space is left alone on buttons/links (there it already "clicks").
      const tgt = e.target as HTMLElement | null
      const typing = !!tgt?.closest('input, textarea, select, [contenteditable="true"]')
      if (!typing && !confirmDialog && !addModal && !accessDialog && playing && !e.altKey && !miniMode) {
        const mod = e.ctrlKey || e.metaKey
        if (e.code === 'Space' && !mod && !tgt?.closest('button, a, [role="button"], [role="link"]')) {
          e.preventDefault()
          togglePlay()
          return
        }
        if (mod && e.code === 'ArrowRight') {
          e.preventDefault()
          void playNext({ fromUserClick: true })
          return
        }
        if (mod && e.code === 'ArrowLeft') {
          e.preventDefault()
          void playPrev()
          return
        }
        if (!mod && (e.code === 'ArrowRight' || e.code === 'ArrowLeft') && audioEl && duration) {
          e.preventDefault()
          const next = Math.min(duration, Math.max(0, audioEl.currentTime + (e.code === 'ArrowRight' ? 5 : -5)))
          audioEl.currentTime = next
          currentTime = next
          return
        }
        if (mod && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
          e.preventDefault()
          volume = Math.min(1, Math.max(0, Math.round((volume + (e.code === 'ArrowUp' ? 0.05 : -0.05)) * 100) / 100))
          if (volume > 0 && muted) muted = false
          return
        }
      }
      if (e.key === 'Escape') {
        // Confirm dialog wins over context menu — both shouldn't be
        // open at the same time, but if they are, dismissing the
        // modal first matches user expectation.
        if (confirmDialog) {
          closeConfirm(false)
          return
        }
        if (accessDialog) {
          accessDialog = null
          return
        }
        if (addModal) {
          closeAddToPlaylist()
          return
        }
        if (queueOpen) {
          queueOpen = false
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
      // Load saved language so labels render in the right locale on first
      // paint. Fallback is 'ru' (handled by the IPC default).
      lang = await window.api.settings.getLang()
      // Restore the player's mode toggles so the user doesn't have to
      // flip shuffle / repeat every launch. Loaded before any track
      // could conceivably play so the first onAudioEnded uses the
      // correct mode.
      shuffleMode = await window.api.settings.getShuffleMode()
      repeatMode = await window.api.settings.getRepeatMode()
      crossfadeDuration = await window.api.settings.getCrossfadeDuration()
      // Media-key health check: warn if 'global' mode is configured but
      // didn't take effect this launch (macOS Accessibility fallback, or the
      // shortcuts were grabbed by another app) — otherwise the user's keys
      // would just be silently dead with no clue why.
      void (async () => {
        const mode = await window.api.settings.getMediaKeyMode()
        if (mode !== 'global') return
        const st = await window.api.settings.getMediaKeyStatus()
        if (st.fellBack || (st.bootMode === 'global' && !st.active)) {
          showToast(t('settings.mediaKeys.globalFailed'))
        }
      })()
      // Audio output device: apply the saved sink, or — the streamer's
      // "emergency case" — warn when the saved device is gone (virtual mixer
      // not running, USB DAC unplugged). The saved value is deliberately NOT
      // cleared: if the mixer comes back, the next launch picks it up again.
      // Until then playback falls back to the system default automatically.
      void (async () => {
        const dev = await window.api.settings.getAudioOutputDevice()
        if (!dev) return
        savedOutputDevice = dev
        await refreshOutputDevices()
        const present = outputDevices.some((d) => d.id === dev.id)
        // 'noop' is fine here: with nothing playing there are no sinks yet —
        // the mount $effect routes the elements when they appear. Only an
        // actual rejection (or the device being absent) warrants the warning.
        if (present && (await applyAudioSink(dev.id)) !== 'failed') return
        const go = await askConfirm(t('audio.deviceMissing', { label: dev.label || dev.id }), {
          confirmLabel: t('audio.goToSettings'),
          cancelLabel: t('audio.later')
        })
        if (go) navigate({ kind: 'settings' })
      })()
      // Equalizer — load saved state. If it was left on, the graph
      // builds lazily on the first playTrack (audio elements only
      // exist once something is playing).
      const eq = await window.api.settings.getEqualizer()
      eqEnabled = eq.enabled
      eqPreset = eq.preset
      eqGains = eq.gains
      browsers = await window.api.auth.browsers()
      connectedBrowser = await window.api.auth.status()
      if (connectedBrowser) {
        // The startup reconnect may already have found the browser's data
        // unreadable (macOS, no Full Disk Access) before we subscribed.
        void window.api.auth.needsAccessStatus().then((id) => {
          if (id) accessDialog = { browser: browserName(id) }
        })
        void loadPinned()
        void loadLikedMusicIds()
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
      unsubAccess()
      unsubWin()
      unsubMini()
      unsubTray()
      window.removeEventListener('mouseup', onMouse)
      window.removeEventListener('wheel', onWheelManual)
      window.removeEventListener('mousedown', onWindowMouseDown)
      window.removeEventListener('keydown', onWindowKeyDown)
    }
  })

  async function connect(browser: { id: string; name: string }): Promise<void> {
    connecting = browser.id
    connectError = ''
    try {
      const ok = await window.api.auth.connect(browser.id)
      if (ok === 'needs-access') {
        accessDialog = { browser: browser.name }
      } else if (ok) {
        connectedBrowser = browser.id
        void loadPinned()
        void loadLikedMusicIds()
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
    artistView = null
    openArtistId = null
    artistError = ''
    playing = null
    playStatus = 'idle'
    libraryPlaylists = null
    libraryError = ''
    pinnedPlaylists = []
    // The deferred-resume track points at something the now-anonymous
    // user can no longer resolve. Drop the pending seek so the next
    // resolved track plays from 0:00.
    pendingResumeTime = null
    pendingResumeId = null
    // Player ephemeral state — queue, history, transient UI bits.
    userQueue = []
    playHistory = []
    ctxMenu = null
    toast = null
    radioSeedCache = new Map()
    // Tear down any in-flight crossfade + clear both audio srcs so the
    // disconnected user doesn't hear leftover playback on next login.
    cancelCrossfade()
    audioASrc = ''
    audioBSrc = ''
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
    if (item.type === 'artist') {
      openArtist(item.id)
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
  }

  // ---- artist view ----------------------------------------------------------

  // Push a 'artist' history entry. Reused from card clicks AND from
  // clicks on artist names in track rows (when the row carries an
  // artistId from the page-proxy response).
  function openArtist(channelId: string): void {
    if (!channelId) return
    navigate({ kind: 'artist', id: channelId })
  }

  async function loadArtistData(id: string): Promise<void> {
    openArtistId = id
    artistLoading = true
    artistError = ''
    artistView = null
    try {
      artistView = await window.api.metadata.artist(id)
      // Once songs land, refresh download status so the per-row chips
      // render correctly on the artist's top-songs list.
      void refreshDownloadStatus(artistView.songs)
    } catch (e) {
      artistError = e instanceof Error ? e.message : String(e)
    } finally {
      artistLoading = false
    }
  }

  // Big Play + Shuffle on the artist header — both target the top-songs
  // shelf since that's what's actually visible on the page. Play =
  // start at song 0; Shuffle = enable shuffleMode (if off) + start at
  // a random song. Matches Spotify's artist-page convention.
  async function playArtistFromStart(): Promise<void> {
    if (!artistView || artistView.songs.length === 0) return
    const idx = findPlayableIndex(artistView.songs, 0, 1)
    if (idx < 0) return
    await playTrack(artistView.songs[idx], artistView.songs, {
      id: undefined,
      title: artistView.title
    })
  }
  async function shufflePlayArtist(): Promise<void> {
    if (!artistView || artistView.songs.length === 0) return
    if (!shuffleMode) {
      shuffleMode = true
      await window.api.settings.setShuffleMode(true)
    }
    let idx = pickShuffleIndex(artistView.songs, '')
    if (idx < 0) idx = findPlayableIndex(artistView.songs, 0, 1)
    if (idx < 0) return
    await playTrack(artistView.songs[idx], artistView.songs, {
      id: undefined,
      title: artistView.title
    })
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
      searchedQuery = q
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
    hasPlaylistOverride = false
    // Radio "playlist": synthesise a view from the cached seed track +
    // a fresh getUpNext call. No override / pin / drag affordances apply
    // (the view is ephemeral). Auto-plays the seed after the related
    // tracks land so prev/next walks the radio list.
    if (isRadioId(id)) {
      playlistFallback = null
      const seedId = id.slice(RADIO_PREFIX.length)
      const seed = radioSeedCache.get(seedId) ?? {
        id: seedId,
        title: '',
        artist: '',
        duration: '',
        thumbnail: ''
      }
      // Render the seed alone immediately so the cover / title appear
      // while related tracks are fetched.
      playlistView = {
        title: t('radio.title', { title: seed.title || seedId }),
        subtitle: seed.artist,
        thumbnail: seed.thumbnail,
        tracks: [seed]
      }
      try {
        const related = await window.api.metadata.radio(seedId)
        const tracks = [seed, ...related]
        playlistView = {
          title: t('radio.title', { title: seed.title || seedId }),
          subtitle: seed.artist,
          thumbnail: seed.thumbnail,
          tracks
        }
        void refreshDownloadStatus(playlistView.tracks)
        // Auto-play the seed after the list materialises. Skip if the
        // user is already listening within THIS exact radio (e.g. they
        // hit browser-back and we re-entered loadPlaylistData) — yanking
        // playback back to the seed would be jarring.
        const playingThisRadio = playing?.sourceListId === id
        if (!playingThisRadio && seed.id) {
          if (playing && playing.id === seed.id) {
            // Radio started from the track that's already playing (the
            // Now-playing column, or the context menu on the current row):
            // keep it playing and just switch its source to the radio, so
            // next/prev walk the radio list — re-resolving would cut the
            // sound and restart from 0:00.
            playing.sourceList = tracks
            playing.sourceListId = id
            playing.sourceListTitle = playlistView.title
            // playTrack would have done these two: warm the next radio
            // tracks and save the new source (a paused track wouldn't
            // otherwise persist it before quit).
            const ids = nextIdsFrom(seed.id, tracks)
            if (ids.length > 0) void window.api.prefetchAudio(ids)
            persistSession()
          } else {
            await playTrack(seed, tracks, { id, title: playlistView.title })
          }
        }
      } catch (e) {
        playlistError = e instanceof Error ? e.message : String(e)
      } finally {
        playlistLoading = false
      }
      return
    }
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
      if (isLikedMusicId(id)) rememberLikedMusic(data.tracks)
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
    // Refuse to start an unavailable row — the stream resolve would
    // fail with a hard 404 anyway and leave the player in an error
    // state. UI also disables the click handler on these rows, so this
    // is belt-and-suspenders.
    if (track.unavailable) return
    // No-op if the user re-clicks the same row that's already mid-resolve
    // — pointless duplicate request.
    if (resolvingId === track.id) return
    // Push whatever was just playing into the history stack BEFORE we
    // overwrite `playing`. Used by shuffle-prev to walk back through
    // actually-played tracks rather than picking another random one.
    // Skip the initial deferred-resume hydrate (empty streamUrl) so we
    // don't pollute history with a placeholder entry, and dedupe — if
    // the user switches tracks mid-resolve, `playing` still points at
    // the same previously-actually-played track on each playTrack call,
    // which would otherwise stack the same snapshot.
    if (playing && playing.streamUrl && playing.id !== track.id) {
      const last = playHistory[playHistory.length - 1]
      if (!last || last.id !== playing.id) {
        const snapshot: SearchResult = {
          id: playing.id,
          title: playing.title,
          artist: playing.artist,
          duration: '',
          thumbnail: playing.thumbnail
        }
        pushHistory(snapshot)
      }
    }
    // Manual playTrack cancels any in-flight crossfade so the new
    // selection takes over immediately instead of getting overlapped
    // by a track the user already moved past.
    cancelCrossfade()
    playStatus = 'resolving'
    playError = ''
    // The track we're about to resolve isn't `playing` yet — `playing`
    // still points at whatever was previously playing. Surface the
    // resolving state on the NEW row by stashing its id; the list
    // overlays a tiny spinner on that row's thumbnail. Also doubles as
    // the cancel signal — if the user clicks another row mid-resolve,
    // `resolvingId` flips to the new track and the in-flight resolve's
    // result is discarded when it eventually returns.
    resolvingId = track.id
    try {
      const r = await window.api.resolveAudio(track.id)
      // User switched targets while we were waiting — this result is
      // stale; the newer call owns the player now.
      if (resolvingId !== track.id) return
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
      // Resolve the resume position for THIS track, then clear the pending
      // state immediately (one-shot). The seek only applies when the track
      // matches the id captured at session-restore time — a fresh play of any
      // other track starts at 0:00 and never inherits the saved position.
      const resumeTime =
        pendingResumeId === track.id && pendingResumeTime && pendingResumeTime > 1
          ? pendingResumeTime
          : 0
      pendingResumeTime = null
      pendingResumeId = null
      // Reset transport state so the UI doesn't briefly show old times.
      // For a deferred-resume start, seed currentTime to the saved position
      // so the seek bar doesn't jump back to 0:00 before canplay seeks.
      currentTime = resumeTime
      duration = 0
      // Load the new track onto the active audio element, full gain,
      // and silence the inactive one. The $effect above re-applies
      // volume/mute based on gain.
      loadOnActive(r.streamUrl)
      // Build / resume the EQ graph if the user has it enabled. Done
      // here (a user-gesture-rooted call) so the AudioContext isn't
      // blocked by the autoplay policy. No-op when EQ is off.
      if (eqEnabled) {
        ensureAudioGraph()
        resumeAudioCtxIfNeeded()
      }
      await tick()
      const el = audioEl
      if (el) {
        const onCanPlay = (): void => {
          el.removeEventListener('canplay', onCanPlay)
          // Resume from the position saved before the previous app close.
          // resumeTime was captured (+ scoped to this track) above.
          if (resumeTime > 1 && Number.isFinite(el.duration)) {
            try {
              el.currentTime = Math.min(resumeTime, el.duration - 1)
              currentTime = el.currentTime
            } catch {
              // ignore — some streams reject seek before fully ready
            }
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
      // Surface the error only if this is still the active target —
      // a stale rejection (user switched tracks) shouldn't blank the
      // bar over what the newer resolve is doing.
      if (resolvingId === track.id) {
        playStatus = 'error'
        playError = e instanceof Error ? e.message : String(e)
      }
    } finally {
      // Only clear the spinner state if WE are still the active target.
      // Otherwise the newer resolve owns this state.
      if (resolvingId === track.id) resolvingId = null
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
    // Restart-on-prev: if we're more than 3s into the current track, the first
    // Prev press restarts it (seek to 0) rather than jumping to the previous
    // track — matches Spotify / YT Music / foobar / basically every player.
    // Press Prev again within the first 3s to actually go back a track.
    if (playing.streamUrl && audioEl && audioEl.currentTime > 3) {
      audioEl.currentTime = 0
      currentTime = 0
      return
    }
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

  // ---- per-audio event handlers ------------------------------------------
  // Both audio elements share the same handler set, parametrised by 'a'/'b'.
  // We only update UI state when the event came from the CURRENTLY-active
  // audio — the fading-out audio during a crossfade continues to fire its
  // own timeupdate / ended, and we don't want those touching the seek bar
  // or kicking off another track.

  function onAudioElementPlay(key: 'a' | 'b'): void {
    if (key === activeAudioKey) isPlaying = true
  }
  function onAudioElementPause(key: 'a' | 'b'): void {
    if (key !== activeAudioKey) return
    isPlaying = false
    persistSession()
  }
  function onAudioElementSeeked(key: 'a' | 'b'): void {
    if (key !== activeAudioKey) return
    persistSession()
    syncMediaPositionState()
  }
  function onAudioElementLoaded(key: 'a' | 'b'): void {
    if (key !== activeAudioKey) return
    const a = key === 'a' ? audioElA : audioElB
    duration = a?.duration ?? 0
    syncMediaPositionState()
  }
  function onAudioElementTimeUpdate(key: 'a' | 'b'): void {
    if (key !== activeAudioKey) return
    const a = key === 'a' ? audioElA : audioElB
    if (!seeking && a) currentTime = a.currentTime
    maybePersistSessionOnTime()
    syncMediaPositionState()
    maybeStartCrossfade()
  }
  function onAudioElementEnded(key: 'a' | 'b'): void {
    // Safety net for the crossfade gain ramp. During a fade the OUTGOING
    // element is the non-active one; its natural end is expected. Normally
    // the rAF ramp has already finished the fade by now, but if rAF was
    // throttled (an occluded window pauses requestAnimationFrame) the
    // incoming track is still sitting at gain 0 — silent. Snapping the
    // fade to completion here forces the new track up to full volume the
    // instant the old one ends, so we never strand it playing inaudibly.
    // (backgroundThrottling:false should keep rAF alive, but this guards
    // the case regardless of platform throttling quirks.)
    if (crossfadeActive && key !== activeAudioKey) {
      finishCrossfade(key, activeAudioKey)
      return
    }
    // Only the ACTIVE audio's natural end advances the queue.
    if (key !== activeAudioKey) return
    // If a crossfade is somehow still in progress on the active (incoming)
    // element, let the fade resolve normally rather than double-advancing.
    if (crossfadeActive) return
    onAudioEnded()
  }

  // ---- crossfade helpers -------------------------------------------------

  // Load a stream URL onto whichever audio is currently active, with
  // full gain. Silences and clears the inactive one. Used by playTrack
  // (manual selection) — instant load, no fade.
  function loadOnActive(streamUrl: string): void {
    if (activeAudioKey === 'a') {
      audioASrc = streamUrl
      audioBSrc = ''
      gainA = 1
      gainB = 0
    } else {
      audioBSrc = streamUrl
      audioASrc = ''
      gainB = 1
      gainA = 0
    }
  }

  // Tear down any in-progress crossfade. After this, the currently-
  // active audio holds the canonical track at full gain; the other one
  // is silenced + cleared. Called from playTrack so a manual selection
  // never inherits a fade halfway through.
  function cancelCrossfade(): void {
    if (crossfadeRaf != null) {
      cancelAnimationFrame(crossfadeRaf)
      crossfadeRaf = null
    }
    crossfadeActive = false
    crossfadeTriggered = false
    // Pause + clear whichever audio is currently inactive (during a
    // fade that's whichever one was the OLD outgoing track).
    if (activeAudioKey === 'a') {
      audioElB?.pause()
      audioBSrc = ''
      gainB = 0
      gainA = 1
    } else {
      audioElA?.pause()
      audioASrc = ''
      gainA = 0
      gainB = 1
    }
  }

  // Picks the next track using the SAME rules playNext uses (queue
  // first, then shuffle/sequential with repeat-all wrap). Returns the
  // track + whether picking it should consume a queue entry — the
  // consume happens once we've actually committed (resolved + swapped),
  // so a resolve failure doesn't strand the user's queued item.
  function peekNextTrack(): { track: SearchResult; consumeQueue: boolean } | null {
    if (!playing) return null
    if (userQueue.length > 0) return { track: userQueue[0], consumeQueue: true }
    const list = playing.sourceList
    if (shuffleMode) {
      const idx = pickShuffleIndex(list, playing.id)
      if (idx >= 0) return { track: list[idx], consumeQueue: false }
      if (repeatMode === 'all') {
        const fb = findPlayableIndex(list, 0, 1)
        if (fb >= 0) return { track: list[fb], consumeQueue: false }
      }
      return null
    }
    const idx = list.findIndex((r) => r.id === playing!.id)
    if (idx < 0) return null
    let nextIdx = findPlayableIndex(list, idx + 1, 1)
    if (nextIdx < 0 && repeatMode === 'all') nextIdx = findPlayableIndex(list, 0, 1)
    if (nextIdx < 0) return null
    return { track: list[nextIdx], consumeQueue: false }
  }

  // Called from onAudioElementTimeUpdate on the ACTIVE audio. Decides
  // whether the current track is close enough to its end to start
  // overlapping the next one. Bails when crossfade is disabled, already
  // triggered, repeat-one (which restarts the same track), or there's
  // no candidate next track.
  function maybeStartCrossfade(): void {
    if (crossfadeDuration <= 0) return
    if (crossfadeTriggered) return
    if (repeatMode === 'one') return
    if (!playing) return
    const a = audioEl
    if (!a) return
    const dur = a.duration
    if (!Number.isFinite(dur) || dur <= 0) return
    const remaining = dur - a.currentTime
    if (!Number.isFinite(remaining)) return
    // Outside the fade window — wait.
    if (remaining > crossfadeDuration) return
    // Already past the end — let the natural ended handler take over.
    if (remaining < 0.05) return
    void startCrossfade()
  }

  async function startCrossfade(): Promise<void> {
    if (crossfadeTriggered) return
    crossfadeTriggered = true
    const picked = peekNextTrack()
    if (!picked) {
      crossfadeTriggered = false
      return
    }
    const { track, consumeQueue } = picked
    if (track.unavailable) {
      crossfadeTriggered = false
      return
    }
    let r: { title: string; format: string; streamUrl: string }
    try {
      r = await window.api.resolveAudio(track.id)
    } catch {
      crossfadeTriggered = false
      return
    }
    // Commit — consume the queue entry now that we have a real URL.
    if (consumeQueue) userQueue = userQueue.slice(1)
    // Push the outgoing track into history (deduped) so shuffle-prev
    // can walk back to it.
    if (playing && playing.streamUrl && playing.id !== track.id) {
      const last = playHistory[playHistory.length - 1]
      if (!last || last.id !== playing.id) {
        pushHistory({
          id: playing.id,
          title: playing.title,
          artist: playing.artist,
          duration: '',
          thumbnail: playing.thumbnail
        })
      }
    }
    // Swap roles: the previously inactive audio is now "active" (will
    // hold the new track at full gain after the fade completes).
    const fadingKey = activeAudioKey
    const newKey: 'a' | 'b' = activeAudioKey === 'a' ? 'b' : 'a'
    activeAudioKey = newKey
    // Set src on the new active. The fading audio keeps its old src
    // and continues playing the outgoing track during the fade.
    if (newKey === 'a') {
      audioASrc = r.streamUrl
      gainA = 0
      gainB = 1
    } else {
      audioBSrc = r.streamUrl
      gainB = 0
      gainA = 1
    }
    // Update playing for UI consumers — seek bar, cover, MediaSession,
    // mini-player etc. all read from playing.
    playing = {
      id: track.id,
      title: track.title || r.title,
      artist: track.artist,
      format: r.format,
      streamUrl: r.streamUrl,
      thumbnail: track.thumbnail,
      sourceList: playing!.sourceList,
      sourceListId: playing!.sourceListId,
      sourceListTitle: playing!.sourceListTitle
    }
    currentTime = 0
    duration = 0
    await tick()
    const newAudio = newKey === 'a' ? audioElA : audioElB
    if (newAudio) {
      const onCanPlay = (): void => {
        newAudio.removeEventListener('canplay', onCanPlay)
        const ids = nextIdsFrom(track.id, playing!.sourceList)
        if (ids.length > 0) void window.api.prefetchAudio(ids)
      }
      newAudio.addEventListener('canplay', onCanPlay)
      newAudio.play().catch(() => {})
    }
    persistSession(0)
    runFadeAnimation(fadingKey, newKey)
  }

  function runFadeAnimation(fadingKey: 'a' | 'b', newKey: 'a' | 'b'): void {
    crossfadeActive = true
    const start = performance.now()
    const durMs = Math.max(100, crossfadeDuration * 1000)
    const step = (): void => {
      if (!crossfadeActive) return
      const elapsed = performance.now() - start
      const t = Math.max(0, Math.min(1, elapsed / durMs))
      // Linear amplitude ramp — perceptually close enough to equal-
      // power for typical music crossfade, and dead simple.
      const fadingGain = 1 - t
      const newGain = t
      if (fadingKey === 'a') gainA = fadingGain
      else gainB = fadingGain
      if (newKey === 'a') gainA = newGain
      else gainB = newGain
      if (t < 1) {
        crossfadeRaf = requestAnimationFrame(step)
      } else {
        finishCrossfade(fadingKey, newKey)
      }
    }
    crossfadeRaf = requestAnimationFrame(step)
  }

  function finishCrossfade(fadingKey: 'a' | 'b', newKey: 'a' | 'b'): void {
    crossfadeRaf = null
    crossfadeActive = false
    crossfadeTriggered = false
    if (fadingKey === 'a') {
      audioElA?.pause()
      audioASrc = ''
      gainA = 0
    } else {
      audioElB?.pause()
      audioBSrc = ''
      gainB = 0
    }
    if (newKey === 'a') gainA = 1
    else gainB = 1
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

  // Liked state of the currently-playing track, derived from whatever
  // list it was launched from. setTrackLikedEverywhere keeps that list
  // in sync after toggle, so this stays accurate without us having to
  // store `liked` on `playing` itself.
  const playingLiked = $derived(
    playing == null
      ? false
      : isLiked({
          id: playing.id,
          liked: playing.sourceList?.find((t) => t.id === playing!.id)?.liked
        })
  )

  // Player-bar heart toggle. Synthesizes a minimal SearchResult so
  // toggleTrackLike's optimistic update path can run against `playing`.
  async function togglePlayingLikeFromBar(): Promise<void> {
    if (!playing) return
    await toggleTrackLike({
      id: playing.id,
      title: playing.title,
      artist: playing.artist,
      duration: '',
      thumbnail: playing.thumbnail,
      liked: playingLiked
    })
  }

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
    // Radio rows aren't reorderable — the list is ephemeral and
    // savePlaylistOverride would be a no-op anyway.
    if (isRadioId(openPlaylistId)) return
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

<svelte:window bind:innerWidth={winWidth} />

<main class:mini={miniMode} class:platform-mac={isMac}>
  {#if !miniMode}
    <!-- The playing cover, blurred, behind the whole window. Keyed on the
         URL so a new cover fades in OVER the old one; the old one stays
         fully opaque until the fade is done (fading both at once would
         let the dark base show through mid-way). |global: the transitions
         must run when the key block swaps, not only when the if toggles. -->
    <div class="cover-backdrop" aria-hidden="true" style:--cover-dim={coverDim}>
      {#key coverUrl}
        {#if coverUrl}
          <img
            class="cover-backdrop-img"
            src={coverUrl}
            alt=""
            in:fade|global={{ duration: prefersReducedMotion.current ? 0 : 700 }}
            out:fade|global={{ delay: prefersReducedMotion.current ? 0 : 700, duration: 1 }}
          />
        {/if}
      {/key}
      <div class="cover-backdrop-shade"></div>
    </div>
  {/if}
  <!-- Custom window controls. Hidden on macOS where the native traffic
       lights (left side, positioned via trafficLightPosition in main)
       cover min/max/close already. Rendered in the window's top-right
       corner: the "Now playing" column when it's open, otherwise the end
       of the top bar (or the connect-screen header). The maximize/restore
       icon swaps based on `windowMaximized`, seeded on mount and re-synced
       via window:maximize-changed so Aero snap / OS gestures stay
       reflected. -->
  {#snippet windowControls()}
      <div class="window-controls">
        <button
          class="win-ctrl"
          onclick={() => void window.api.window.minimize()}
          aria-label={t('window.minimize')}
          title={t('window.minimize')}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="5" y1="13" x2="19" y2="13" />
          </svg>
        </button>
        <button
          class="win-ctrl"
          onclick={async () => {
            windowMaximized = await window.api.window.toggleMaximize()
          }}
          aria-label={windowMaximized ? t('window.restore') : t('window.maximize')}
          title={windowMaximized ? t('window.restore') : t('window.maximize')}
        >
          {#if windowMaximized}
            <!-- Restore icon: two overlapping rectangles -->
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
              <rect x="7" y="4" width="13" height="13" rx="1.5" />
              <path d="M4 7v13h13" />
            </svg>
          {:else}
            <!-- Maximize icon: single rounded rectangle -->
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect x="5" y="5" width="14" height="14" rx="1.5" />
            </svg>
          {/if}
        </button>
        <button
          class="win-ctrl close"
          onclick={() => void window.api.window.close()}
          aria-label={t('window.close')}
          title={t('window.close')}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
  {/snippet}

  <!-- Loading skeletons: grey placeholders in the shape of what's coming
       (rows, shelves, tiles) with a soft shimmer, instead of a lone
       spinner in the corner. Widths vary per row so it doesn't read as a
       barcode. The shimmer stops under prefers-reduced-motion (app.css). -->
  {#snippet skelRows(n: number)}
    <div class="skel-rows" role="status" aria-busy="true">
      <span class="sr-only">{t('common.loading')}</span>
      {#each Array.from({ length: n }) as _, i (i)}
        <div class="skel-row" aria-hidden="true">
          <span class="skel skel-num"></span>
          <span class="skel skel-thumb"></span>
          <span class="skel-lines">
            <span class="skel skel-line" style:width="{42 + ((i * 37) % 38)}%"></span>
            <span class="skel skel-line short" style:width="{22 + ((i * 23) % 26)}%"></span>
          </span>
          <span class="skel skel-time"></span>
        </div>
      {/each}
    </div>
  {/snippet}
  {#snippet skelCards(n: number, row: boolean)}
    <div class={row ? 'shelf-row' : 'grid'} aria-hidden="true">
      {#each Array.from({ length: n }) as _, i (i)}
        <div class="card-tile skel-card">
          <div class="skel tile-thumb"></div>
          <span class="skel skel-line" style:width="{60 + ((i * 29) % 30)}%"></span>
          <span class="skel skel-line short" style:width="{40 + ((i * 17) % 30)}%"></span>
        </div>
      {/each}
    </div>
  {/snippet}
  {#snippet skelShelf()}
    <section class="section shelf">
      <div class="shelf-head"><span class="skel skel-heading"></span></div>
      {@render skelCards(8, true)}
    </section>
  {/snippet}

  <!-- Up next: the user's queue, then the source list (or a note when
       shuffle / repeat-one make the order unknowable). Shared by the
       Now-playing column and the queue popover. -->
  {#snippet queueRow(r: SearchResult, onPlay: () => void)}
    <button class="q-row" onclick={onPlay} title={r.artist ? `${r.title} — ${r.artist}` : r.title}>
      <span
        class="q-thumb"
        style:background-image={r.thumbnail ? `url("${thumbnailFor(r.id, r.thumbnail)}")` : 'none'}
      ></span>
      <span class="q-meta">
        <span class="q-title">{r.title}</span>
        <span class="q-artist">{r.artist}</span>
      </span>
      <span class="q-time">{r.duration}</span>
    </button>
  {/snippet}
  {#snippet upNextList()}
    {#if upNext.queued.length > 0}
      <div class="q-label">{t('np.queued')}</div>
      {#each upNext.queued as r, i (i + ':' + r.id)}
        {@render queueRow(r, () => playQueuedAt(i))}
      {/each}
    {/if}
    <div class="q-label">{t('np.queue')}</div>
    {#if upNext.mode === 'shuffle'}
      <p class="q-note">
        {playing?.sourceListTitle
          ? t('np.queueShuffle', { title: playing.sourceListTitle })
          : t('np.queueShuffleNoTitle')}
      </p>
    {:else if upNext.mode === 'repeatOne'}
      <p class="q-note">{t('np.queueRepeatOne')}</p>
    {:else if upNext.next.length === 0}
      <p class="q-note">{t('np.queueEnd')}</p>
    {:else}
      {#each upNext.next as r, i (i + ':' + r.id)}
        {@render queueRow(r, () => playFromUpNext(r))}
      {/each}
    {/if}
  {/snippet}

  {#if !miniMode}
    {#if !connectedBrowser}
      <header>
        <img class="wordmark" src={wordmark} alt="eCoda" />
        {#if !isMac}{@render windowControls()}{/if}
      </header>
    {/if}

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
        <!-- Safari on macOS reads its cookies from the app sandbox, which
             requires Full Disk Access for eCoda. Without that, yt-dlp
             gets a permission error and the "no login found" message
             would be misleading. Show a hint while Safari is in the
             list so users know what to do BEFORE picking it. -->
        {#if isMac && browsers.some((b) => b.id === 'safari')}
          <p class="hint" style:margin-top="0.6rem">{t('connect.safariFda')}</p>
        {/if}
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
        <div class="sidebar-brand">
          <img class="wordmark" src={wordmark} alt="eCoda" />
        </div>
        <nav class="side-nav" aria-label={t('nav.sections')}>
          <button
            class="nav"
            class:active={view === 'home'}
            onclick={() => navigate({ kind: 'home' })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" /></svg>
            {t('nav.home')}
          </button>
          <button
            class="nav"
            class:active={view === 'library'}
            onclick={openLibrary}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 4v16M10 4v16M15 4l5 16" /></svg>
            {t('nav.library')}
          </button>
          <button
            class="nav"
            class:active={view === 'playlist' && isDownloadedId(openPlaylistId)}
            onclick={() => navigate({ kind: 'playlist', id: DOWNLOADED_ID })}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>
            {t('nav.downloaded')}
          </button>
        </nav>

        {#if pinnedPlaylists.length > 0}
          <div class="side-group">
          <div class="side-label">{t('nav.pinned')}</div>
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
                  class:liked-thumb={!p.thumbnail && isLikedMusicId(p.id)}
                  style:background-image={p.thumbnail ? `url("${p.thumbnail}")` : 'none'}
                >
                  {#if !p.thumbnail && isLikedMusicId(p.id)}
                    <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
                      <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
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
          </div>
        {/if}

        <div class="nav-spacer"></div>
        <button
          class="nav"
          class:active={view === 'settings'}
          onclick={() => navigate({ kind: 'settings' })}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></svg>
          {t('nav.settings')}
        </button>
      </aside>

      <div class="center">
        <div class="topbar">
            <div class="history-nav">
              <button
                class="hist"
                onclick={goBack}
                disabled={!canBack}
                aria-label={t('nav.back')}
                title={t('nav.back')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
              </button>
              <button
                class="hist"
                onclick={goForward}
                disabled={!canForward}
                aria-label={t('nav.forward')}
                title={t('nav.forward')}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
          <label class="top-search">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input
              type="search"
              bind:this={topSearchEl}
              bind:value={query}
              placeholder={t('search.placeholder')}
              aria-label={t('nav.search')}
              onkeydown={(e) => e.key === 'Enter' && doSearch()}
            />
          </label>
          {#if !npVisible && !isMac}{@render windowControls()}{/if}
        </div>

      <section class="view-wrap">
        {#if view === 'home'}
          {#if homeLoading}
            <div class="skel-page" role="status" aria-busy="true">
              <span class="sr-only">{t('home.loading')}</span>
              <section class="section" aria-hidden="true">
                <span class="skel skel-heading"></span>
                <div class="pin-tiles">
                  {#each Array.from({ length: 3 }) as _, i (i)}
                    <div class="pin-tile skel-pin">
                      <span class="skel pin-tile-cover"></span>
                      <span class="skel skel-line" style:width="{45 + i * 12}%"></span>
                    </div>
                  {/each}
                </div>
              </section>
              {@render skelShelf()}
              {@render skelShelf()}
            </div>
          {:else if homeError}
            <p class="status error">{t('home.error', { error: homeError })}</p>
            <button onclick={() => loadHome()}>{t('home.retry')}</button>
          {:else if homeSections && homeSections.length > 0}
            <!-- Pinned playlists + Downloaded as wide tiles: the places the
                 user actually returns to, one click from the start page. -->
            <section class="section">
              <h3>{t('nav.pinned')}</h3>
              <div class="pin-tiles">
                {#each pinnedPlaylists as p (p.id)}
                  <button
                    class="pin-tile"
                    onclick={() =>
                      openPlaylist(p.id, { fallbackTitle: p.title, fallbackThumbnail: p.thumbnail })}
                  >
                    <span
                      class="pin-tile-cover"
                      class:liked-thumb={!p.thumbnail && isLikedMusicId(p.id)}
                      style:background-image={p.thumbnail ? `url("${p.thumbnail}")` : 'none'}
                    >
                      {#if !p.thumbnail && isLikedMusicId(p.id)}
                        <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
                          <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
                        </svg>
                      {/if}
                    </span>
                    <span class="pin-tile-title">{isLikedMusicId(p.id) ? t('liked.music') : p.title}</span>
                  </button>
                {/each}
                <button
                  class="pin-tile"
                  onclick={() => navigate({ kind: 'playlist', id: DOWNLOADED_ID })}
                >
                  <span class="pin-tile-cover downloaded">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
                    </svg>
                  </span>
                  <span class="pin-tile-text">
                    <span class="pin-tile-title">{t('nav.downloaded')}</span>
                    <span class="pin-tile-sub">{t('home.downloadedSub')}</span>
                  </span>
                </button>
              </div>
            </section>
            {#each homeSections as section (section.title)}
              <section class="section shelf">
                <div class="shelf-head">
                  <h3>{section.title}</h3>
                  <div class="shelf-nav">
                    <button
                      class="shelf-arrow prev"
                      onclick={(e) => scrollShelf(e, -1)}
                      aria-label={t('shelf.prev')}
                      title={t('shelf.prev')}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
                    </button>
                    <button
                      class="shelf-arrow next"
                      onclick={(e) => scrollShelf(e, 1)}
                      aria-label={t('shelf.next')}
                      title={t('shelf.next')}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
                    </button>
                  </div>
                </div>
                <div class="shelf-row" use:shelfOverflow>
                  {#each section.items as item (item.id)}
                    <button class="card-tile" onclick={() => openCard(item)} title={item.title}>
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
              </section>
            {/each}
          {:else}
            <p class="status">{t('home.empty')}</p>
          {/if}
        {:else if view === 'search'}
          {#if !searched && !searching && !searchError}
            <p class="status">{t('search.hint')}</p>
          {/if}
          {#if searching}
            {@render skelRows(8)}
          {/if}
          {#if searchError}
            <p class="status error">{t('search.error', { error: searchError })}</p>
          {/if}
          {#if searched && !searching && searchResults.length === 0 && !searchError}
            <p class="status">{t('search.empty')}</p>
          {/if}
          {#if searchResults.length > 0}
            <h3 class="results-title">{t('search.resultsFor', { query: searchedQuery })}</h3>
            <ul class="track-list">
              {#each searchResults as r, i (r.id)}
                <li class="track-li">
                  <button
                    class="track-row"
                    class:current={playing?.id === r.id}
                    onclick={() => playTrack(r, searchResults)}
                    oncontextmenu={(e) => openCtxMenu(e, r, searchResults)}
                  >
                    <span class="row-num" aria-hidden="true">
                      {#if playing?.id === r.id}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z" /></svg>
                      {:else}
                        {i + 1}
                      {/if}
                    </span>
                    <div
                      class="thumb"
                      class:resolving={resolvingId === r.id}
                      style:background-image={r.thumbnail ? `url("${r.thumbnail}")` : 'none'}
                    >
                      {#if resolvingId === r.id}
                        <span class="thumb-spinner" aria-hidden="true"></span>
                      {/if}
                    </div>
                    <div class="meta">
                      <div class="title">{r.title}</div>
                      <div class="artist">
                        {#if r.artistId}
                          <span
                            class="artist-link"
                            role="link"
                            tabindex="0"
                            onclick={(e) => {
                              e.stopPropagation()
                              openArtist(r.artistId!)
                            }}
                            onkeydown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                openArtist(r.artistId!)
                              }
                            }}>{r.artist}</span>
                        {:else}
                          {r.artist}
                        {/if}
                      </div>
                    </div>
                  </button>
                  <button
                    class="like-btn"
                    class:liked={isLiked(r)}
                    onclick={() => void toggleTrackLike(r)}
                    aria-label={isLiked(r) ? t('like.remove') : t('like.add')}
                    title={isLiked(r) ? t('like.remove') : t('like.add')}
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill={isLiked(r) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
                    </svg>
                  </button>
                  <div class="duration">{r.duration}</div>
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
                  {:else if isRadioId(openPlaylistId)}
                    {t('radio.subtitle')}
                  {:else if playlistView.isAlbum && playlistView.artistName}
                    <!-- Album-specific layout: "Album · Artist (link)
                         · 2024". Falls through to the YT-provided full
                         subtitle when the artist info isn't extractable. -->
                    {t('album.label')}
                    {#if playlistView.artistId}
                      ·
                      <span
                        class="artist-link"
                        role="link"
                        tabindex="0"
                        onclick={() => openArtist(playlistView!.artistId!)}
                        onkeydown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            openArtist(playlistView!.artistId!)
                          }
                        }}>{playlistView.artistName}</span>
                    {:else}
                      · {playlistView.artistName}
                    {/if}
                    {#if playlistView.year}
                      · {playlistView.year}
                    {/if}
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
                           rows stay in their positions. Hidden on the
                           radio view — radio is ephemeral, no override
                           to persist. -->
                      {#if playlistView.tracks.length > 1 && !isRadioId(openPlaylistId)}
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
                      {#if !isDownloadedId(openPlaylistId) && !isRadioId(openPlaylistId)}
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

                      {#if !isLikedMusicId(openPlaylistId) && !isDownloadedId(openPlaylistId) && !isRadioId(openPlaylistId)}
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
          {#if playlistLoading && !(playlistView && playlistView.tracks.length > 0)}
            {@render skelRows(10)}
          {:else if playlistLoading}
            <div class="spinner"></div>
          {/if}
          {#if playlistError}
            <p class="status error">{t('home.error', { error: playlistError })}</p>
          {/if}
          {#if !playlistLoading && isDownloadedId(openPlaylistId) && playlistView && playlistView.tracks.length === 0}
            <p class="status empty">{t('downloaded.empty')}</p>
          {/if}
          {#if playlistView && playlistView.tracks.length > 0}
            <div class="track-head" aria-hidden="true">
              <span class="row-num">#</span>
              <span class="th-thumb"></span>
              <span class="th-meta">
                <span>{t('tracks.title')}</span>
                <span class="th-artist">{t('tracks.artist')}</span>
              </span>
              <span class="th-like"></span>
              <span class="duration">{t('tracks.time')}</span>
              <span class="th-dl"></span>
            </div>
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
                  ondrop={(e) => onRowDrop(e, idx)}
                  ondragend={onRowDragEnd}
                  animate:flip={{ duration: motion(240), easing: quintOut }}
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
                    disabled={r.unavailable}
                    title={r.unavailable ? t('track.unavailable') : undefined}
                  >
                    <span class="row-num" aria-hidden="true">
                      {#if playing?.id === r.id}
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z" /></svg>
                      {:else}
                        {idx + 1}
                      {/if}
                    </span>
                    <div
                      class="thumb"
                      class:resolving={resolvingId === r.id}
                      style:background-image={`url("${thumbnailFor(r.id, r.thumbnail)}")`}
                    >
                      {#if resolvingId === r.id}
                        <span class="thumb-spinner" aria-hidden="true"></span>
                      {/if}
                    </div>
                    <div class="meta">
                      <div class="title">{r.title}</div>
                      <div class="artist">
                        {#if r.unavailable}
                          {t('track.unavailable')}
                        {:else if r.artistId}
                          <span
                            class="artist-link"
                            role="link"
                            tabindex="0"
                            onclick={(e) => {
                              e.stopPropagation()
                              openArtist(r.artistId!)
                            }}
                            onkeydown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                openArtist(r.artistId!)
                              }
                            }}>{r.artist}</span>
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
                  </button>
                  <!-- Inline like toggle, YT-Music-style: filled heart =
                       liked, outlined = not. Optimistic update; reverts
                       if the IPC fails. Disabled on unavailable rows. -->
                  <button
                    class="like-btn"
                    class:liked={isLiked(r)}
                    onclick={() => void toggleTrackLike(r)}
                    aria-label={isLiked(r) ? t('like.remove') : t('like.add')}
                    title={isLiked(r) ? t('like.remove') : t('like.add')}
                    disabled={r.unavailable}
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" fill={isLiked(r) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
                    </svg>
                  </button>
                  <div class="duration">{r.duration}</div>
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
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
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
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if view === 'artist'}
          {#if artistLoading && !artistView}
            <div class="skel-page" role="status" aria-busy="true">
              <span class="sr-only">{t('common.loading')}</span>
              <div class="artist-header" aria-hidden="true">
                <span class="skel artist-photo"></span>
                <div class="artist-info skel-artist-info">
                  <span class="skel skel-title"></span>
                  <span class="skel skel-line short" style:width="40%"></span>
                </div>
              </div>
              {@render skelRows(6)}
            </div>
          {/if}
          {#if artistError}
            <p class="status error">{t('home.error', { error: artistError })}</p>
          {/if}
          {#if artistView}
            <div class="artist-header">
              {#if artistView.thumbnail}
                <div
                  class="artist-photo"
                  style:background-image={`url("${artistView.thumbnail}")`}
                ></div>
              {/if}
              <div class="artist-info">
                <div class="artist-name">{artistView.title || t('artist.untitled')}</div>
                {#if artistView.subtitle}
                  <div class="artist-sub">{formatSubscriberLine(artistView.subtitle, lang)}</div>
                {/if}
                {#if artistView.songs.length > 0}
                  <div class="artist-actions">
                    <button
                      class="play-big"
                      onclick={playArtistFromStart}
                      aria-label={t('player.play')}
                      title={t('player.play')}
                    >
                      <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
                        <path d="M9 5v14l11-7z" />
                      </svg>
                    </button>
                    <button
                      class="dl-icon-btn"
                      onclick={shufflePlayArtist}
                      aria-label={t('artist.shufflePlay')}
                      title={t('artist.shufflePlay')}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                        <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
                      </svg>
                    </button>
                  </div>
                {/if}
              </div>
            </div>
            {#if artistView.songs.length > 0}
              <div class="section">
                <h3>{t('artist.topSongs')}</h3>
                <ul class="track-list">
                  {#each artistView.songs as r, idx (`art-${idx}-${r.id}`)}
                    <li class="track-li" class:unavailable={r.unavailable}>
                      <button
                        class="track-row"
                        class:current={playing?.id === r.id}
                        onclick={() => playTrack(r, artistView!.songs, { title: artistView!.title })}
                        oncontextmenu={(e) => openCtxMenu(e, r, artistView!.songs, { title: artistView!.title })}
                        disabled={r.unavailable}
                        title={r.unavailable ? t('track.unavailable') : undefined}
                      >
                        <span class="row-num" aria-hidden="true">
                              {#if playing?.id === r.id}
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z" /></svg>
                              {:else}
                                {idx + 1}
                              {/if}
                            </span>
                            <div
                          class="thumb"
                          class:resolving={resolvingId === r.id}
                          style:background-image={`url("${thumbnailFor(r.id, r.thumbnail)}")`}
                        >
                          {#if resolvingId === r.id}
                            <span class="thumb-spinner" aria-hidden="true"></span>
                          {/if}
                        </div>
                        <div class="meta">
                          <div class="title">{r.title}</div>
                          <div class="artist">
                            {#if r.unavailable}
                              {t('track.unavailable')}
                            {:else if r.artistId}
                              <span
                                class="artist-link"
                                role="link"
                                tabindex="0"
                                onclick={(e) => {
                                  e.stopPropagation()
                                  openArtist(r.artistId!)
                                }}
                                onkeydown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    openArtist(r.artistId!)
                                  }
                                }}>{r.artist}</span>
                            {:else}
                              {r.artist}
                            {/if}
                          </div>
                        </div>
                      </button>
                      <button
                        class="like-btn"
                        class:liked={isLiked(r)}
                        onclick={() => void toggleTrackLike(r)}
                        aria-label={isLiked(r) ? t('like.remove') : t('like.add')}
                        title={isLiked(r) ? t('like.remove') : t('like.add')}
                        disabled={r.unavailable}
                      >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill={isLiked(r) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                          <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
                        </svg>
                      </button>
                      <div class="duration">{r.duration}</div>
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
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
                        {:else if downloadingIds.has(r.id)}
                          <span class="busy-content">
                            <svg class="dl-ring" viewBox="0 0 36 36" width="18" height="18">
                              <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="3" />
                              <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="{downloadPercent.get(r.id) ?? 0}, 100" transform="rotate(-90 18 18)" stroke-linecap="round" />
                            </svg>
                          </span>
                          <span class="cancel-x" aria-hidden="true">✕</span>
                        {:else}
                          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>
                        {/if}
                      </button>
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
            {#each artistView.sections as section (section.title)}
              <div class="section">
                <h3>{section.title}</h3>
                <div class="grid">
                  {#each section.items as item (item.id)}
                    <button class="card-tile" onclick={() => openCard(item)}>
                      <div
                        class="tile-thumb"
                        class:circle={item.type === 'artist'}
                        style:background-image={item.thumbnail ? `url("${item.thumbnail}")` : 'none'}
                      ></div>
                      <div class="tile-title">{item.title}</div>
                      <div class="tile-subtitle">{item.subtitle}</div>
                    </button>
                  {/each}
                </div>
              </div>
            {/each}
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
              <h4>{t('settings.behaviour.title')}</h4>
              <p class="settings-line">{t('settings.behaviour.defaultTab')}</p>
              <div class="seg">
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'home'}
                  onclick={() => changeDefaultTab('home')}
                >
                  {t('nav.home')}
                </button>
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'search'}
                  onclick={() => changeDefaultTab('search')}
                >
                  {t('nav.search')}
                </button>
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'library'}
                  onclick={() => changeDefaultTab('library')}
                >
                  {t('nav.library')}
                </button>
              </div>
              <p class="settings-hint">{t('settings.behaviour.hint')}</p>
              <p class="settings-line" style:margin-top="0.9rem">
                {t('settings.closeAction.label')}
              </p>
              <div class="seg">
                <button
                  class="seg-btn"
                  class:active={closeAction === 'tray'}
                  onclick={() => changeCloseAction('tray')}
                >
                  {t('settings.closeAction.tray')}
                </button>
                <button
                  class="seg-btn"
                  class:active={closeAction === 'quit'}
                  onclick={() => changeCloseAction('quit')}
                >
                  {t('settings.closeAction.quit')}
                </button>
              </div>
              <p class="settings-hint">{t('settings.closeAction.hint')}</p>
              <p class="settings-line" style:margin-top="0.9rem">
                {t('settings.mediaKeys.label')}
              </p>
              <div class="seg">
                <button
                  class="seg-btn"
                  class:active={mediaKeyMode === 'system'}
                  onclick={() => void changeMediaKeyMode('system')}
                >
                  {t('settings.mediaKeys.system')}
                </button>
                <button
                  class="seg-btn"
                  class:active={mediaKeyMode === 'global'}
                  onclick={() => void changeMediaKeyMode('global')}
                >
                  {t('settings.mediaKeys.global')}
                </button>
              </div>
              <p class="settings-hint">{t('settings.mediaKeys.hint')}</p>
            </section>

            <section class="settings-card">
              <h4>{t('settings.keys.title')}</h4>
              <dl class="keys-list">
                <dt><kbd>{t('settings.keys.space')}</kbd></dt>
                <dd>{t('settings.keys.playPause')}</dd>
                <dt><kbd>←</kbd> <kbd>→</kbd></dt>
                <dd>{t('settings.keys.seek')}</dd>
                <dt><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd> + <kbd>←</kbd> <kbd>→</kbd></dt>
                <dd>{t('settings.keys.track')}</dd>
                <dt><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd> + <kbd>↑</kbd> <kbd>↓</kbd></dt>
                <dd>{t('settings.keys.volume')}</dd>
                <dt><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd> + <kbd>F</kbd></dt>
                <dd>{t('settings.keys.search')}</dd>
              </dl>
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
              <h4>{t('settings.output.title')}</h4>
              <p class="settings-line">{t('settings.output.line')}</p>
              <div class="output-row">
                <!-- Re-enumerate on focus so plugging in / starting a virtual
                     mixer shows up without reopening Settings. -->
                <select
                  class="output-select"
                  bind:value={selectedOutputId}
                  onfocus={() => void refreshOutputDevices()}
                >
                  <option value="">{t('settings.output.systemDefault')}</option>
                  {#if savedOutputDevice && !outputDevices.some((d) => d.id === savedOutputDevice!.id)}
                    <!-- Saved device currently absent — keep it pickable so the
                         select doesn't silently snap to another value. -->
                    <option value={savedOutputDevice.id}>
                      ⚠ {savedOutputDevice.label || savedOutputDevice.id} ({t('settings.output.missing')})
                    </option>
                  {/if}
                  {#each outputDevices as d (d.id)}
                    <option value={d.id}>{d.label}</option>
                  {/each}
                </select>
                <button class="output-save" onclick={() => void saveOutputDevice()}>
                  {t('settings.output.save')}
                </button>
              </div>
              <p class="settings-hint">{t('settings.output.hint')}</p>
            </section>

            <section class="settings-card">
              <h4>{t('settings.crossfade.title')}</h4>
              <div class="crossfade-row">
                <input
                  type="range"
                  class="crossfade-slider"
                  min="0"
                  max="12"
                  step="1"
                  value={crossfadeDuration}
                  oninput={(e) =>
                    void changeCrossfadeDuration(
                      Number((e.currentTarget as HTMLInputElement).value)
                    )}
                  style:--p="{(crossfadeDuration / 12) * 100}%"
                />
                <span class="crossfade-value">
                  {crossfadeDuration === 0
                    ? t('settings.crossfade.off')
                    : t('settings.crossfade.seconds', { n: crossfadeDuration })}
                </span>
              </div>
              <p class="settings-hint">{t('settings.crossfade.hint')}</p>
            </section>

            <section class="settings-card">
              <div class="eq-head">
                <h4>{t('settings.eq.title')}</h4>
                <button
                  class="eq-toggle"
                  class:on={eqEnabled}
                  role="switch"
                  aria-checked={eqEnabled}
                  onclick={() => toggleEqualizer(!eqEnabled)}
                  title={eqEnabled ? t('settings.eq.on') : t('settings.eq.off')}
                >
                  <span class="eq-toggle-knob"></span>
                </button>
              </div>

              <!-- Preset chips. Active one is highlighted; "custom"
                   only shows as active after a manual slider tweak that
                   doesn't match any preset. -->
              <div class="eq-presets" class:disabled={!eqEnabled}>
                {#each EQ_PRESET_ORDER as p (p)}
                  <button
                    class="eq-preset"
                    class:active={eqPreset === p}
                    disabled={!eqEnabled}
                    onclick={() => applyEqPreset(p)}
                  >
                    {t('eq.preset.' + p)}
                  </button>
                {/each}
                {#if eqPreset === 'custom'}
                  <span class="eq-preset active eq-preset-custom">{t('eq.preset.custom')}</span>
                {/if}
              </div>

              <!-- 10 vertical sliders. Each is a rotated range input;
                   value is dB (-12..+12). The band label sits under
                   each, the current dB above. -->
              <div class="eq-bands" class:disabled={!eqEnabled}>
                {#each EQ_BAND_LABELS as label, i (label)}
                  <div class="eq-band">
                    <span class="eq-band-db">{eqGains[i] > 0 ? '+' : ''}{eqGains[i]}</span>
                    <input
                      type="range"
                      class="eq-slider"
                      min="-12"
                      max="12"
                      step="1"
                      value={eqGains[i]}
                      disabled={!eqEnabled}
                      oninput={(e) =>
                        setEqBand(i, Number((e.currentTarget as HTMLInputElement).value))}
                    />
                    <span class="eq-band-label">{label}</span>
                  </div>
                {/each}
              </div>
              <p class="settings-hint">{t('settings.eq.hint')}</p>
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

              <div class="ytdlp-block">
                <p class="settings-line">
                  {t('settings.ytdlp.label')}
                  <strong>{ytdlpInfo?.active ?? t('settings.ytdlp.unknown')}</strong>
                </p>
                {#if ytdlpChecking}
                  <p class="settings-hint">{t('settings.ytdlp.checking')}</p>
                {:else if ytdlpResult?.kind === 'updated'}
                  <p class="settings-hint">
                    {t('settings.ytdlp.updated', { version: ytdlpResult.version })}
                  </p>
                {:else if ytdlpResult?.kind === 'up-to-date'}
                  <p class="settings-hint">{t('settings.ytdlp.upToDate')}</p>
                {:else if ytdlpResult?.kind === 'error'}
                  <p class="settings-hint" style:color="#ff8db5">
                    {t('settings.ytdlp.error', { message: ytdlpResult.message })}
                  </p>
                {:else}
                  <p class="settings-hint">
                    {t('settings.ytdlp.hint')}
                    {ytdlpInfo?.checkedAt
                      ? t('settings.ytdlp.lastCheck', { when: formatCheckedAt(ytdlpInfo.checkedAt) })
                      : t('settings.ytdlp.never')}
                  </p>
                {/if}
                <div class="upd-actions">
                  <button class="settings-btn" onclick={checkYtdlpNow} disabled={ytdlpChecking}>
                    {ytdlpChecking ? t('settings.ytdlp.checkingBtn') : t('settings.ytdlp.checkBtn')}
                  </button>
                </div>
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
                onclick={() => window.open('https://ko-fi.com/erneywhite', '_blank')}
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
              <a href="https://github.com/erneywhite/eCoda" target="_blank" rel="noreferrer">
                github.com/erneywhite/eCoda
              </a>
            </p>
          </div>
        {:else if view === 'library'}
          <!-- Phase B native: page-proxy signs InnerTube calls so we get
               the real authenticated library response, then we render the
               cards ourselves with the same grid as Home. -->
          {#if libraryLoading}
            <div class="skel-page" role="status" aria-busy="true">
              <span class="sr-only">{t('common.loading')}</span>
              <span class="skel skel-heading" aria-hidden="true"></span>
              {@render skelCards(12, false)}
            </div>
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

      {#if npVisible && playing}
        <aside class="np-col" aria-label={t('np.label')}>
          <div class="np-top">
            {#if !isMac}{@render windowControls()}{/if}
          </div>
          <div class="np-scroll">
          <div class="np-label" title={playing.sourceListTitle ?? ''}>
            {playing.sourceListTitle
              ? t('np.labelFrom', { title: playing.sourceListTitle })
              : t('np.label')}
          </div>
          <img
            class="np-col-cover"
            src={npCoverSrc}
            alt=""
            onerror={() => (npCoverHiFailedUrl = hiResThumb(playing?.thumbnail ?? ''))}
          />
          <div class="np-col-meta">
            <h2 class="np-col-title" title={playing.title}>{playing.title}</h2>
            {#if playingRow?.artistId}
              <button
                class="np-col-artist link"
                onclick={() => openArtist(playingRow!.artistId!)}
                title={playing.artist}
              >
                <span>{playing.artist}</span>
              </button>
            {:else}
              <div class="np-col-artist" title={playing.artist}>{playing.artist}</div>
            {/if}
          </div>
          <div class="np-col-actions">
            <button
              class="np-icon-btn"
              class:liked={playingLiked}
              onclick={() => void togglePlayingLikeFromBar()}
              aria-label={playingLiked ? t('like.remove') : t('like.add')}
              title={playingLiked ? t('like.remove') : t('like.add')}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill={playingLiked ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" /></svg>
            </button>
            <button class="np-pill" onclick={startRadioFromPlaying}>
              {t('ctx.startRadio')}
            </button>
          </div>
          <div class="np-queue">
            {@render upNextList()}
          </div>
          </div>
        </aside>
      {/if}
    </div>
  {/if}
  {/if}

    <!-- Resolving feedback moved onto the playing track's thumbnail (see
         .thumb.resolving in each row). The floating bar that used to
         live here was visually disconnected from anything the user
         clicked. Error stays as a banner since there's no row state to
         overlay it on. -->
    {#if playStatus === 'error' && !miniMode}
      <div class="resolving-bar error">{t('player.error', { error: playError })}</div>
    {/if}

    {#if playing}
      <div class="player-bar" style:display={miniMode ? 'none' : 'flex'}>
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
            <!-- Cover wrapper lets the previous + next cover overlap
                 briefly while {#key playing.id} swaps them, so a track
                 change reads as a soft crossfade rather than an
                 instant pop. -->
            <div class="np-cover-wrap">
              {#key playing.id}
                <div
                  class="np-cover"
                  style:background-image={`url("${thumbnailFor(playing.id, playing.thumbnail)}")`}
                  in:fade={{ duration: motion(260), easing: quintOut }}
                  out:fade={{ duration: motion(200) }}
                ></div>
              {/key}
            </div>
            <div class="np-meta">
              <div class="np-title" title={playing.title}>{playing.title}</div>
              {#if playingRow?.artistId}
                <button
                  class="np-artist link"
                  onclick={() => openArtist(playingRow!.artistId!)}
                  title={playing.artist}
                >
                  <span>{playing.artist}</span>
                </button>
              {:else}
                <div class="np-artist" title={playing.artist || playing.format}>
                  {playing.artist || playing.format}
                </div>
              {/if}
            </div>
            {#if playing.streamUrl}
              <button
                class="ctrl small like-bar"
                class:liked={playingLiked}
                onclick={() => void togglePlayingLikeFromBar()}
                aria-label={playingLiked ? t('like.remove') : t('like.add')}
                title={playingLiked ? t('like.remove') : t('like.add')}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill={playingLiked ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
                </svg>
              </button>
            {/if}
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
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M16 4h4v4M4 20 20 4M16 20h4v-4M15 15l5 5M4 4l5 5" />
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
          </div>

          <div class="player-extras">
            {#if playing.streamUrl}
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
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>
                {:else}
                  <!-- ↓ download arrow -->
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>
                {/if}
              </button>
            {/if}
            {#if !npVisible}
              <button
                class="ctrl small queue-btn"
                class:active={queueOpen}
                onclick={() => (queueOpen = !queueOpen)}
                aria-label={t('player.queue')}
                aria-expanded={queueOpen}
                title={t('player.queue')}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M4 6h12M4 12h12M4 18h7M17 15v6l5-3z" />
                </svg>
              </button>
            {/if}
            <button
              class="ctrl small"
              onclick={() => void window.api.window.enterMini('compact')}
              aria-label={t('mini.enter')}
              title={t('mini.enter')}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <rect x="12" y="12" width="6" height="4" rx="1" />
              </svg>
            </button>
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
        </div>

        <!-- Two audio elements so we can crossfade between tracks.
             `activeAudioKey` says which one is the logical "current"
             player; the other is silent unless a fade is in progress.
             Both are always mounted (no {#if playing.streamUrl})
             because tearing one down mid-fade would chop the audio. -->
        <!-- crossorigin is set to 'anonymous' ONLY when the equalizer is
             on. Routing an element through Web Audio (MediaElementSource)
             taints + silences the output unless the media was fetched
             with CORS — and googlevideo doesn't send Access-Control-
             Allow-Origin natively, so main injects it via onHeadersReceived
             (+ on the media:// handler). We keep crossorigin OFF by
             default so a CORS hiccup can never break plain playback for
             users who don't touch the EQ; toggling EQ on reloads the
             active track so it re-fetches WITH the CORS request.
             onstalled/onwaiting log buffering hiccups to main.log — a
             cheap breadcrumb if the "lag" report recurs. -->
        <audio
          bind:this={audioElA}
          src={audioASrc}
          crossorigin={eqEnabled ? 'anonymous' : undefined}
          onended={() => onAudioElementEnded('a')}
          onplay={() => onAudioElementPlay('a')}
          onpause={() => onAudioElementPause('a')}
          onseeked={() => onAudioElementSeeked('a')}
          onloadedmetadata={() => onAudioElementLoaded('a')}
          ontimeupdate={() => onAudioElementTimeUpdate('a')}
          onstalled={() => onAudioStall('a', 'stalled')}
          onwaiting={() => onAudioStall('a', 'waiting')}
        ></audio>
        <audio
          bind:this={audioElB}
          src={audioBSrc}
          crossorigin={eqEnabled ? 'anonymous' : undefined}
          onended={() => onAudioElementEnded('b')}
          onplay={() => onAudioElementPlay('b')}
          onpause={() => onAudioElementPause('b')}
          onseeked={() => onAudioElementSeeked('b')}
          onloadedmetadata={() => onAudioElementLoaded('b')}
          ontimeupdate={() => onAudioElementTimeUpdate('b')}
          onstalled={() => onAudioStall('b', 'stalled')}
          onwaiting={() => onAudioStall('b', 'waiting')}
        ></audio>
      </div>
      {#if queueOpen && !npVisible && !miniMode}
        <div class="queue-pop" role="dialog" aria-label={t('player.queue')} transition:fade={{ duration: motion(120) }}>
          {@render upNextList()}
        </div>
      {/if}
      <!-- Mini-player volume control: a mute button whose icon reflects the
           current volume/mute state, with a slider that slides out on hover.
           Reuses the SAME `volume`/`muted` state + handlers as the full bar
           (the $effect higher up applies them to the audio elements), so this
           is purely UI. The popup grows upward-left from the button so it
           never clips against the tiny mini-window edges. A snippet so both
           the compact and square layouts share one definition. -->
      {#snippet miniVolume(placement: 'up' | 'left')}
        <div
          class="mini-vol mini-vol-{placement}"
          class:open={miniVolOpen}
          role="group"
          onpointerenter={openMiniVol}
          onpointerleave={closeMiniVolSoon}
        >
          <button
            class="mini-btn"
            onclick={toggleMute}
            onfocus={openMiniVol}
            onblur={closeMiniVolSoon}
            title={muted || volume === 0 ? t('player.unmute') : t('player.mute')}
            aria-label={muted || volume === 0 ? t('player.unmute') : t('player.mute')}
          >
            {#if muted || volume === 0}
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.59 3L20 8.41 18.59 7 15 10.59 11.41 7 10 8.41 13.59 12 10 15.59 11.41 17 15 13.41 18.59 17 20 15.59z"/></svg>
            {:else if volume > 0.5}
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06A7 7 0 0 1 14 18.71v2.06A9 9 0 0 0 14 3.23z"/></svg>
            {:else}
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 9v6h4l5 5V4l-5 5H7zm9.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12z"/></svg>
            {/if}
          </button>
          <div class="mini-vol-pop">
            <input
              type="range"
              class="vol mini-vol-slider"
              min="0"
              max="1"
              step="0.01"
              value={muted ? 0 : volume}
              oninput={onVolumeInput}
              onfocus={openMiniVol}
              onblur={closeMiniVolSoon}
              style:--p="{(muted ? 0 : volume) * 100}%"
              aria-label={t('player.mute')}
            />
          </div>
        </div>
      {/snippet}
      {#if miniMode}
        <!-- Mini-player shell. Same `playing` state as the full UI,
             just rendered as either a horizontal pill (compact / A) or
             a cover-focused card (square / B). The whole shell is the
             drag region; interactive children (`.mini-btn`, the seek
             input) opt out via -webkit-app-region: no-drag. Audio
             element stays mounted inside the hidden player-bar above so
             playback isn't interrupted across the mode toggle.

             --seek-pct is a CSS custom property that drives the
             progress fill in the seek track's gradient — without it
             the track stayed flat-gray regardless of playback. -->
        <div
          class="mini-shell"
          class:layout-square={miniLayout === 'square'}
          style:--seek-pct={duration > 0 ? `${(currentTime / duration) * 100}%` : '0%'}
        >
          <!-- The playing cover, blurred, as the card's background — the
               same look as the main window. Painted under the content via
               the shell's isolation + z-index:-1, so no child's
               positioning changes (the volume popup relies on it). -->
          <div
            class="mini-backdrop"
            aria-hidden="true"
            style:background-image={coverUrl ? `url("${coverUrl}")` : 'none'}
          ></div>
          <!-- Thin seek strip at the very top of the shell — same role
               as the one on the full player bar. Renders as a block at
               the top so it's never clipped by overflow. -->
          <input
            type="range"
            class="mini-seek"
            min="0"
            max={Math.max(0, duration)}
            step="0.1"
            value={currentTime}
            onpointerdown={() => (seeking = true)}
            oninput={(e) => {
              const v = parseFloat((e.currentTarget as HTMLInputElement).value)
              if (Number.isFinite(v)) currentTime = v
            }}
            onchange={(e) => {
              const v = parseFloat((e.currentTarget as HTMLInputElement).value)
              if (Number.isFinite(v) && audioEl) audioEl.currentTime = v
              seeking = false
            }}
          />
          {#if miniLayout === 'compact'}
            <!-- A: horizontal pill. Below the seek strip = a single row. -->
            <div class="mini-row">
              <div
                class="mini-cover-sm"
                style:background-image={`url("${thumbnailFor(playing.id, playing.thumbnail)}")`}
              ></div>
              <div class="mini-meta">
                <div class="mini-title" title={playing.title}>{playing.title}</div>
                <div class="mini-artist" title={playing.artist}>{playing.artist}</div>
              </div>
              <div class="mini-controls">
                <button class="mini-btn" onclick={() => void playPrev()} title={t('player.prev')}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
                </button>
                <button class="mini-btn mini-btn-primary" onclick={togglePlay} title={isPlaying ? t('player.pause') : t('player.play')}>
                  {#if isPlaying}
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
                  {:else}
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 5v14l11-7z"/></svg>
                  {/if}
                </button>
                <button class="mini-btn" onclick={() => void playNext({ fromUserClick: true })} title={t('player.next')}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 18l8.5-6L6 6zM16 6h2v12h-2z"/></svg>
                </button>
                {@render miniVolume('left')}
                <button
                  class="mini-btn mini-btn-like"
                  class:liked={playingLiked}
                  onclick={() => void togglePlayingLikeFromBar()}
                  title={playingLiked ? t('like.remove') : t('like.add')}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d={playingLiked ? CTX_ICONS.like : CTX_ICONS.unlike}/></svg>
                </button>
                <button
                  class="mini-btn"
                  onclick={() => void window.api.window.setMiniLayout('square')}
                  title={t('mini.switchToSquare')}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z"/></svg>
                </button>
                <button
                  class="mini-btn"
                  onclick={() => void window.api.window.exitMini()}
                  title={t('mini.exit')}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 5h6V3H3v8h2zm14 0h-6V3h8v8h-2zM5 19h6v2H3v-8h2zm14 0h-6v2h8v-8h-2z"/></svg>
                </button>
              </div>
            </div>
          {:else}
            <!-- B: square cover-focused. Cover sized so the remaining
                 height comfortably fits the meta + transport row. -->
            <div class="mini-square-top">
              <button
                class="mini-btn mini-btn-bare"
                onclick={() => void window.api.window.setMiniLayout('compact')}
                title={t('mini.switchToCompact')}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 5h18v6H3zm0 8h18v6H3z"/></svg>
              </button>
              <button
                class="mini-btn mini-btn-bare"
                onclick={() => void window.api.window.exitMini()}
                title={t('mini.exit')}
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M5 5h6V3H3v8h2zm14 0h-6V3h8v8h-2zM5 19h6v2H3v-8h2zm14 0h-6v2h8v-8h-2z"/></svg>
              </button>
            </div>
            <button
              class="mini-cover-lg"
              onclick={togglePlay}
              style:background-image={`url("${thumbnailFor(playing.id, playing.thumbnail)}")`}
              title={isPlaying ? t('player.pause') : t('player.play')}
            >
              <span class="mini-cover-overlay" aria-hidden="true">
                {#if isPlaying}
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
                {:else}
                  <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor"><path d="M9 5v14l11-7z"/></svg>
                {/if}
              </span>
            </button>
            <div class="mini-meta-square">
              <div class="mini-title" title={playing.title}>{playing.title}</div>
              <div class="mini-artist" title={playing.artist}>{playing.artist}</div>
            </div>
            <div class="mini-controls mini-controls-square">
              <button class="mini-btn" onclick={() => void playPrev()} title={t('player.prev')}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
              </button>
              <button class="mini-btn mini-btn-primary" onclick={togglePlay} title={isPlaying ? t('player.pause') : t('player.play')}>
                {#if isPlaying}
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
                {:else}
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M9 5v14l11-7z"/></svg>
                {/if}
              </button>
              <button class="mini-btn" onclick={() => void playNext({ fromUserClick: true })} title={t('player.next')}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 18l8.5-6L6 6zM16 6h2v12h-2z"/></svg>
              </button>
              <button
                class="mini-btn mini-btn-like"
                class:liked={playingLiked}
                onclick={() => void togglePlayingLikeFromBar()}
                title={playingLiked ? t('like.remove') : t('like.add')}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d={playingLiked ? CTX_ICONS.like : CTX_ICONS.unlike}/></svg>
              </button>
              {@render miniVolume('up')}
            </div>
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
      bind:this={ctxMenuEl}
      style:left="{ctxMenu.x}px"
      style:top="{ctxMenu.y}px"
      transition:scale={{ duration: motion(130), start: 0.94, opacity: 0, easing: quintOut }}
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

  <!-- Add-to-playlist modal — opened from a track's right-click menu.
       Compact + window-size-adaptive: the tile grid uses auto-fill so it
       reflows from 2 to N columns as the window widens, a search box
       filters by name, and a "Show all" toggle keeps the initial height
       small for a windowed player. Recents float to the top when no
       search is active. -->
  {#if addModal}
    {@const visible = filteredAddPlaylists(addModal)}
    {@const collapsed = !addModal.showAll && !addModal.query.trim()}
    {@const shown = collapsed ? visible.slice(0, ADD_MODAL_COLLAPSED_COUNT) : visible}
    {@const hiddenCount = visible.length - shown.length}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="add-backdrop"
      onclick={(e) => {
        if (e.target === e.currentTarget) closeAddToPlaylist()
      }}
    >
      <div class="add-card" role="dialog" aria-modal="true" tabindex="-1">
        <div class="add-head">
          <div class="add-title">{t('addModal.title')}</div>
          <button class="add-close" onclick={closeAddToPlaylist} aria-label={t('addModal.close')}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>
        <!-- Track being added — small reminder of what this affects. -->
        <div class="add-track">
          <img class="add-track-cover" src={addModal.track.thumbnail} alt="" />
          <div class="add-track-meta">
            <div class="add-track-title">{addModal.track.title}</div>
            <div class="add-track-artist">{addModal.track.artist}</div>
          </div>
        </div>

        {#if addModal.loading}
          <div class="add-loading"><div class="spinner"></div></div>
        {:else if addModal.playlists.length === 0}
          <p class="add-empty">{t('addModal.empty')}</p>
        {:else}
          <!-- Search filter — only worth showing once there are enough
               playlists that scanning the grid is slower than typing. -->
          {#if addModal.playlists.length > ADD_MODAL_COLLAPSED_COUNT}
            <input
              class="add-search"
              type="text"
              bind:value={addModal.query}
              placeholder={t('addModal.search')}
            />
          {/if}

          {#if visible.length === 0}
            <p class="add-empty">{t('addModal.noMatch')}</p>
          {:else}
            <div class="add-grid">
              {#each shown as p (p.id)}
                {@const busy = addModal.busyId === p.id}
                <button
                  class="add-tile"
                  disabled={addModal.busyId != null}
                  onclick={() => void addTrackToPlaylist(p)}
                  title={p.title}
                >
                  <div class="add-tile-cover">
                    {#if p.thumbnail}
                      <img src={p.thumbnail} alt="" />
                    {:else}
                      <div class="add-tile-placeholder">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                          <path d="M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zM17 6v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V8h3V6h-5z" />
                        </svg>
                      </div>
                    {/if}
                    <!-- Overlay: spinner while this tile's add is in flight. -->
                    {#if busy}
                      <div class="add-tile-overlay"><span class="spinner spinner-inline"></span></div>
                    {/if}
                  </div>
                  <div class="add-tile-title">{p.title}</div>
                </button>
              {/each}
            </div>

            <!-- Show all / less — only when collapsing actually hides tiles. -->
            {#if collapsed && hiddenCount > 0}
              <button class="add-more" onclick={() => (addModal!.showAll = true)}>
                {t('addModal.showAll', { count: hiddenCount })}
              </button>
            {:else if addModal.showAll && !addModal.query.trim() && visible.length > ADD_MODAL_COLLAPSED_COUNT}
              <button class="add-more" onclick={() => (addModal!.showAll = false)}>
                {t('addModal.showLess')}
              </button>
            {/if}
          {/if}
        {/if}
      </div>
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

  <!-- macOS Full Disk Access prompt. macOS gives apps no way to request
       FDA with a system dialog, so this explains why it's needed and
       deep-links to the right Settings pane; the grant only reliably
       applies after a restart, hence the relaunch button. -->
  {#if accessDialog}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="confirm-backdrop"
      onclick={(e) => {
        if (e.target === e.currentTarget) accessDialog = null
      }}
    >
      <div class="confirm-card access-card" role="dialog" aria-modal="true" tabindex="-1">
        <h3 class="access-title">{t('access.title')}</h3>
        <div class="confirm-message">{t('access.body', { browser: accessDialog.browser })}</div>
        <div class="confirm-actions">
          <button class="confirm-btn cancel" onclick={() => (accessDialog = null)}>
            {t('access.later')}
          </button>
          <button class="confirm-btn" onclick={relaunchApp}>
            {t('access.relaunch')}
          </button>
          <button class="confirm-btn ok" onclick={openAccessSettings}>
            {t('access.openSettings')}
          </button>
        </div>
      </div>
    </div>
  {/if}
</main>

<style>
  /* Accent — applyPalette() rewrites these from the playing cover at
     runtime (cover-palette.ts). The values here are the brand violet,
     shown on first paint and whenever nothing is loaded. */
  :global(:root) {
    --accent: #c97df6;
    --accent-2: #ff6dc8;
    --accent-rgb: 201, 125, 246;
    --cover-blur: 90px;
    --cover-dim: 0.5;
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

  /* Window background. Base layer: near-black with one soft brand-violet
     glow, which is all you see while nothing is loaded. Over it, the
     .cover-backdrop: the playing cover blown up and blurred until only its
     colours remain, then shaded towards the bottom so text stays legible.
     Both pinned to the viewport. */
  :global(body) {
    position: relative;
  }
  :global(body)::before {
    content: '';
    position: fixed;
    inset: 0;
    background:
      radial-gradient(1100px 560px at 18% -12%, rgba(201, 125, 246, 0.22), transparent 70%),
      var(--surface-base);
    z-index: -2;
    pointer-events: none;
  }
  .cover-backdrop {
    position: fixed;
    inset: 0;
    z-index: -1;
    overflow: hidden;
    pointer-events: none;
  }
  /* Overhang = 3× the blur radius on every side: blur pulls transparency
     in from the image edge, and a %-based overhang left a dark vignette
     in narrower windows. */
  .cover-backdrop-img {
    position: absolute;
    left: calc(-3 * var(--cover-blur));
    top: calc(-3 * var(--cover-blur));
    width: calc(100% + 6 * var(--cover-blur));
    height: calc(100% + 6 * var(--cover-blur));
    object-fit: cover;
    filter: blur(var(--cover-blur)) saturate(1.4) brightness(var(--cover-dim));
    will-change: opacity;
  }
  .cover-backdrop-shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      rgba(12, 10, 16, 0.22) 0%,
      rgba(12, 10, 16, 0.45) 60%,
      rgba(12, 10, 16, 0.85) 100%
    );
  }

  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ---- mini-player ------------------------------------------------------- */

  /* Container — also the OS-level drag region. Backdrop is intentionally
     a touch transparent (alpha 0.78) so when the user has the mini
     widget pinned in a corner, whatever they're working on still reads
     through. Heavy blur + a thin accent-tinted border keeps it legible
     against busy backgrounds anyway. */
  .mini-shell {
    /* Fills the whole window edge-to-edge — no inset, no border-radius.
       The window itself is opaque + rectangular; rounding the shell
       would just leave dark body-coloured triangles in the corners. */
    position: fixed;
    inset: 0;
    background: var(--surface-base);
    color: #ffffff;
    isolation: isolate;
    -webkit-app-region: drag;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .mini-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.5rem 0.7rem;
    flex: 1;
    min-height: 0;
  }
  /* Square (B) layout — extra padding for the cover-meta-controls
     stack. The cover is sized below; everything else fits within the
     remaining height. */
  .mini-shell.layout-square {
    padding: 0;
    gap: 0;
  }

  .mini-cover-sm {
    flex: 0 0 auto;
    width: 56px;
    height: 56px;
    border-radius: 9px;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.45);
  }
  .mini-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .mini-meta-square {
    text-align: center;
    padding: 0 0.6rem;
    margin-top: 0.3rem;
    flex: 0 0 auto;
  }
  .mini-title {
    color: #ffffff;
    font-size: 0.86rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mini-artist {
    color: var(--ink-2);
    font-size: 0.74rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mini-controls {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 0.15rem;
  }
  .mini-controls-square {
    justify-content: center;
    gap: 0.4rem;
    padding: 0.4rem 0;
    flex: 0 0 auto;
  }

  .mini-btn {
    -webkit-app-region: no-drag;
    width: 28px;
    height: 28px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s ease, color 0.12s ease, transform 0.1s ease;
  }
  .mini-btn:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #ffffff;
  }
  .mini-btn:active {
    transform: scale(0.9);
  }
  .mini-btn-bare {
    width: 22px;
    height: 22px;
  }
  .mini-btn-like.liked {
    color: var(--accent);
  }
  .mini-btn-like:hover {
    color: #ffffff;
    background: rgba(255, 255, 255, 0.12);
  }
  .mini-backdrop {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background-size: cover;
    background-position: center;
    filter: blur(28px) saturate(1.4) brightness(0.45);
    /* blur pulls the edges in; overscale so they stay outside the card */
    transform: scale(1.3);
  }

  .mini-btn-primary {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: var(--ink-1);
    color: var(--surface-base);
  }
  .mini-btn-primary:hover {
    background: #ffffff;
    color: var(--surface-base);
  }

  /* Mini volume: a mute button with a slider that pops out on hover. The
     popup is absolutely positioned ABOVE the button (the mini window is only
     ~108px tall in compact mode, so a popup that grows upward is the only
     thing that reliably clears the window edges) and centred over it. Hidden
     by default; revealed on hover of the wrapper or keyboard focus within, so
     it's reachable without a mouse too. */
  .mini-vol {
    position: relative;
    display: inline-flex;
    -webkit-app-region: no-drag;
  }
  .mini-vol-pop {
    /* no-drag: without it the popup sits over the shell's drag region and
       eats its own pointer events (slider becomes undraggable). */
    -webkit-app-region: no-drag;
    position: absolute;
    opacity: 0;
    pointer-events: none;
    padding: 0.5rem 0.55rem;
    background: rgba(22, 19, 28, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    transition: opacity 0.13s ease, transform 0.13s ease;
    z-index: 20;
  }
  /* "up" placement (square / B layout — tall window, room above the button):
     popup floats centred above the button. The padding-bottom bridge closes
     the gap to the button so the cursor never crosses bare drag-region
     between them (which would drop the pointerenter chain). */
  .mini-vol-up .mini-vol-pop {
    bottom: 100%;
    padding-bottom: 8px;
    left: 50%;
    transform: translateX(-50%) scaleY(0.6);
    transform-origin: bottom center;
  }
  .mini-vol-up.open .mini-vol-pop {
    transform: translateX(-50%) scaleY(1);
  }
  /* "left"/compact (A layout — short 108px window). The popup drops BELOW the
     volume button, anchored to its right edge and extending left, into the
     empty lower strip of the pill — so it no longer overlaps the play /
     prev / next buttons (which sit in the centre row, above it). padding-top
     bridges the gap to the button (drag-region: the cursor must never cross
     bare drag surface between button and popup or the pointerenter chain
     drops). */
  .mini-vol-left .mini-vol-pop {
    top: 100%;
    right: 0;
    /* Tight padding: the compact pill is only 108px tall, so the popup must
       fit in the ~33px strip below the button without clipping. padding-top
       doubles as the no-gap bridge to the button. */
    padding: 4px 8px;
    padding-top: 7px;
    transform: scaleY(0.6);
    transform-origin: top right;
  }
  .mini-vol-left.open .mini-vol-pop {
    transform: scaleY(1);
  }
  .mini-vol.open .mini-vol-pop {
    opacity: 1;
    pointer-events: auto;
  }
  /* Horizontal slider inside the popup — reuses the full-bar `.vol` track +
     thumb styling (3px gradient track, --p fill). Fixed 100px so the popup
     stays narrow enough to clear the mini window edges.
     NOTE: the selector is `.mini-vol-pop .mini-vol-slider`, NOT just
     `.mini-vol-slider` — paid for in blood. `.vol` (also a single class)
     sets `width: 100%` and is defined LATER in this file, so a bare
     `.mini-vol-slider { width: 100px }` lost the cascade tie-break and the
     slider collapsed to 0 width inside the auto-width popup (100% of nothing).
     The descendant selector bumps specificity so the fixed width wins. */
  .mini-vol-pop .mini-vol-slider {
    -webkit-app-region: no-drag;
    width: 100px;
    max-width: 100px;
  }
  /* The full-bar .vol hides its thumb until hover; in the popup the slider IS
     the point, so keep the thumb always visible for an obvious drag target. */
  .mini-vol-pop .mini-vol-slider::-webkit-slider-thumb {
    opacity: 1;
  }

  /* Top-of-shell seek strip. The element is 14px tall to give the
     mouse a comfortable click target; the VISIBLE track inside is
     only 4px (centred via the negative thumb margin). Progress fill
     is a gradient with stops anchored to --seek-pct, which the
     renderer updates via inline style on each timeupdate. */
  .mini-seek {
    -webkit-app-region: no-drag;
    appearance: none;
    width: 100%;
    height: 14px;
    margin: 0;
    background: transparent;
    cursor: pointer;
    border: none;
    outline: none;
    padding: 0;
    flex: 0 0 auto;
    /* Sits on top of any sibling so the click target isn't covered
       by the row's hit-test area. */
    position: relative;
    z-index: 2;
  }
  .mini-seek::-webkit-slider-runnable-track {
    height: 4px;
    background: linear-gradient(
      to right,
      var(--accent) 0%,
      var(--accent) var(--seek-pct, 0%),
      rgba(255, 255, 255, 0.14) var(--seek-pct, 0%),
      rgba(255, 255, 255, 0.14) 100%
    );
    border: none;
  }
  .mini-seek::-webkit-slider-thumb {
    appearance: none;
    width: 12px;
    height: 12px;
    /* Centre the thumb vertically on the 4px track. (12-4)/2 = 4px
       above + 4px below; negative margin-top pulls the thumb up. */
    margin-top: -4px;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
    box-shadow: 0 0 6px rgba(var(--accent-rgb), 0.7);
  }

  /* Square layout-specific extras. The drag-bar strip up top holds
     the toggle/exit buttons; cover is intentionally sized in px (not
     100% width / aspect-ratio) so the remaining height comfortably
     fits the meta + transport — when those were `aspect-ratio: 1/1`
     they consumed the full window height and pushed the rest off. */
  .mini-square-top {
    -webkit-app-region: drag;
    display: flex;
    justify-content: flex-end;
    gap: 0.2rem;
    padding: 0.25rem 0.4rem 0.2rem;
    flex: 0 0 auto;
  }
  .mini-cover-lg {
    color: #ffffff;
    -webkit-app-region: no-drag;
    flex: 0 0 auto;
    align-self: center;
    width: 180px;
    height: 180px;
    border-radius: 12px;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
    cursor: pointer;
    border: none;
    padding: 0;
    position: relative;
    overflow: hidden;
    transition: transform 0.2s ease;
  }
  .mini-cover-lg:hover {
    transform: scale(1.02);
  }
  .mini-cover-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.4);
    color: #ffffff;
    opacity: 0;
    transition: opacity 0.18s ease;
  }
  .mini-cover-lg:hover .mini-cover-overlay {
    opacity: 1;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
    /* Whole header is the OS drag region for the frameless window — grab
       anywhere in the empty space to move the window, double-click to
       toggle maximize. Interactive children (.wordmark, .hist, .win-ctrl)
       opt out via -webkit-app-region: no-drag below. This MUST live on the
       base rule, not only the macOS override — otherwise the window can't
       be dragged at all on Windows. */
    -webkit-app-region: drag;
    /* Asymmetric padding: match .layout — header should sit above the
       sidebar with the same 1rem left gutter. Right side has zero
       padding because the window controls (.window-controls) hug the
       window's actual right edge; the right gutter is built into the
       controls' own internal padding. */
    padding: 1rem 0 0.7rem 1rem;
    flex-shrink: 0;
  }
  /* macOS draws its three traffic-light circles inside our drag region
     at the top-left (positioned via trafficLightPosition in main).
     Pad the header left so the wordmark + back/forward chips don't
     collide with them. ~78px clears the 70px-wide cluster.
     padding-top is bumped so the wordmark sits BELOW the traffic-
     lights vertically (otherwise they overlap on the same baseline,
     which reads as a collision); padding-bottom is trimmed so the
     total header height stays close to the Windows side.
     padding-right gives the back/forward + mini-player cluster a bit
     of breathing room from the window edge — on Windows our own
     close/min/max buttons provided that gutter; on macOS the traffic
     lights live on the left, so there's nothing on the right edge
     otherwise. */
  main.platform-mac header {
    /* Wordmark slot is exactly the sidebar width (200px). The 1rem
       padding-left matches `.layout`'s own padding so the wordmark
       slot lines up perfectly with the sidebar slot below — same
       left edge, same width, same centre line. */
    padding-left: 1rem;
    padding-top: 2.2rem;
    padding-bottom: 0.6rem;
    /* Right cluster (back / forward / mini-player) lines up with the
       right edge of the floating .player-bar below (`margin: 0 2rem
       1.2rem 1rem`). 2rem on both keeps a clean vertical line down
       the right side of the window. */
    padding-right: 2rem;
  }
  /* All interactive header elements must opt out of the drag region —
     otherwise clicks land as drag attempts and the buttons feel dead. */
  .wordmark,
  .hist,
  .win-ctrl,
  .top-search {
    -webkit-app-region: no-drag;
  }

  /* Wordmark image is the eCoda lettering — no need for a separate
     text "eCoda" alongside it.
     The slot is exactly the sidebar width (200px, see .layout's
     grid-template-columns) so the lettering's visual centre lines up
     with the sidebar's centre below — one vertical axis down the
     left side of the window. `object-fit: contain` centres the
     raccoon+lettering inside that box without distorting the aspect
     ratio. The current artwork is 3.05:1 (600×197), so at width 200
     the rendered image is 200×65.6 and naturally fills the sidebar's
     full visual width below. drop-shadow gives the neon halo. */
  .wordmark {
    width: 200px;
    height: 70px;
    object-fit: contain;
    object-position: center;
    display: block;
    filter: drop-shadow(0 0 18px rgba(180, 60, 240, 0.35));
  }

  .ghost {
    padding: 0.5rem 1rem;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 9px;
    background: transparent;
    color: var(--ink-2);
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
  }

  /* History (back / forward) controls — sit next to the disconnect button
     in the right side of the header. Disabled state reads dimmer. */
  .history-nav {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: none;
  }

  .hist {
    width: 34px;
    height: 34px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--scrim);
    color: var(--ink-1);
    display: inline-grid;
    place-items: center;
    cursor: pointer;
    transition: background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out);
  }

  .hist:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.14);
    color: #ffffff;
  }

  .hist:disabled {
    color: var(--ink-3);
    opacity: 0.6;
    cursor: default;
  }

  /* Custom window controls (minimize / maximize / close). Sized to
     match the back/forward .hist chips so the right cluster reads as
     a single row of equally-weighted controls rather than two
     full-height bars overpowering a pair of small circles next to them.
     Rounded squares (not circles) keep them visually distinct from the
     navigation pair while staying in the same family. Close keeps a
     pink-red hover — matches the app's existing danger palette
     (rgba(255, 60, 120, X)) rather than the louder Windows red. */
  .window-controls {
    display: flex;
    align-self: center;
    gap: 2px;
    margin-left: auto;
  }
  .win-ctrl {
    width: 36px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--ink-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .win-ctrl:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
  .win-ctrl:active {
    background: rgba(255, 255, 255, 0.14);
  }
  .win-ctrl.close:hover {
    background: rgba(232, 17, 35, 0.9);
    color: #ffffff;
  }
  .win-ctrl.close:active {
    background: #e63b56;
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
    font-family: var(--font-display);
    font-size: 1.15rem;
    font-weight: 600;
    color: #ffffff;
  }

  h3 {
    margin: 0 0 0.7rem 0;
    font-family: var(--font-display);
    font-size: 1.1rem;
    color: #ffffff;
    font-weight: 600;
  }

  .hint {
    margin: 0;
    color: var(--ink-2);
    font-size: 0.92rem;
    line-height: 1.5;
  }

  .browsers {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  /* ---- layout ------------------------------------------------------------- */

  /* ---- shell (1.6.0) ---------------------------------------------------
     Three columns over the blurred cover: sidebar · centre (top bar +
     view) · "Now playing" (only while a track is loaded and the window
     is ≥ NP_COLUMN_MIN_WIDTH wide). No glass cards — the panels sit
     straight on the background, the column gets a light scrim. */
  .layout {
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
    flex: 1;
    min-height: 0;
  }
  .layout:has(> .np-col) {
    grid-template-columns: 232px minmax(0, 1fr) clamp(300px, 24vw, 360px);
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    /* Tighter in short windows so the pinned list doesn't get squeezed
       into a scroll box at the 560px minimum height. */
    gap: clamp(14px, 3.5vh, 28px);
    padding: 0 12px 16px 16px;
    min-height: 0;
  }
  /* The top padding lives on the brand block (a drag region), so the
     strip above the wordmark still moves the window. */
  .sidebar-brand {
    flex: none;
    padding-top: 18px;
    -webkit-app-region: drag;
  }
  /* macOS: the traffic lights sit top-left (trafficLightPosition in main);
     drop the wordmark below them — the strip around them stays draggable. */
  main.platform-mac .sidebar-brand {
    padding-top: 46px;
  }
  .sidebar-brand .wordmark {
    width: 150px;
    height: 49px;
    object-position: left center;
    -webkit-app-region: drag;
  }
  .side-nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .side-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-height: 0;
  }
  .side-label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--ink-3);
    padding: 0 12px 6px;
  }

  .center {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  /* Top bar = drag region of the frameless window (buttons and the search
     field opt out via the no-drag list above). */
  .topbar {
    height: 64px;
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: 0 20px 0 32px;
    -webkit-app-region: drag;
  }
  /* Connect screen: keep the controls off the window's very edge. */
  header .window-controls {
    padding-right: 12px;
  }
  .top-search {
    flex: 0 1 460px;
    min-width: 0;
    height: 40px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px;
    border-radius: 20px;
    background: rgba(0, 0, 0, 0.32);
    color: var(--ink-2);
    cursor: text;
    transition: box-shadow var(--dur-base) var(--ease-out);
  }
  .top-search:focus-within {
    box-shadow: 0 0 0 2px rgba(var(--accent-rgb), 0.7);
  }
  .top-search input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--ink-1);
    font-size: var(--text-md);
  }
  .top-search input::placeholder {
    color: var(--ink-3);
  }

  /* ---- "Now playing" column ---- */
  .np-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background: rgba(0, 0, 0, 0.22);
    border-left: 1px solid var(--hairline);
  }
  /* Everything below the window controls scrolls; the controls (and the
     drag strip around them) stay put. */
  .np-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 0 24px 20px;
  }
  /* Without this the flex children shrink instead of the area scrolling
     (the label collapsed to 0px). */
  .np-scroll > * {
    flex-shrink: 0;
  }
  .np-top {
    height: 64px;
    flex: none;
    display: flex;
    align-items: center;
    padding: 0 20px 0 24px;
    -webkit-app-region: drag;
  }
  .np-label {
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--accent);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Capped by window height too: in a short window (≈720px) a full-width
     cover pushed the queue out of sight. */
  .np-col-cover {
    width: min(100%, 32vh);
    aspect-ratio: 1 / 1;
    flex: none;
    object-fit: cover;
    border-radius: var(--radius-lg);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  }
  .np-col-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }
  .np-col-title {
    margin: 0;
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 26px;
    line-height: 1.1;
    letter-spacing: -0.01em;
    color: var(--ink-1);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .np-col-artist {
    max-width: 100%;
    font-size: var(--text-lg);
    font-weight: 400;
    color: #e3d9e6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
  }
  button.np-col-artist {
    padding: 0;
    border: 0;
    background: none;
    font-family: inherit;
    cursor: pointer;
  }
  button.np-col-artist > span,
  button.np-artist > span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.np-col-artist:hover {
    color: #ffffff;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .np-col-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .np-icon-btn {
    width: 44px;
    height: 44px;
    flex: none;
    padding: 0;
    border-radius: 50%;
    border: 0;
    background: transparent;
    color: #e3d9e6;
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .np-icon-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
  .np-icon-btn.liked {
    color: var(--accent);
  }
  .np-pill {
    height: 40px;
    padding: 0 18px;
    border-radius: 20px;
    border: 1px solid var(--outline);
    background: transparent;
    color: var(--ink-1);
    font-size: var(--text-md);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .np-pill:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .nav {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 40px;
    flex: none;
    text-align: left;
    padding: 0 12px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink-nav);
    font-size: var(--text-base);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }

  .nav svg {
    flex: 0 0 auto;
    opacity: 0.85;
  }

  .nav.active svg {
    opacity: 1;
  }

  .nav:hover:not(:disabled) {
    background: var(--surface-hover);
    color: #ffffff;
  }

  .nav.active {
    background: var(--surface-2);
    color: #ffffff;
    font-weight: 600;
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
    gap: 2px;
    overflow-y: auto;
    min-height: 0;
    flex-shrink: 1;
  }

  .pin-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: #e6dfea;
    font-size: var(--text-md);
    font-weight: 500;
    cursor: pointer;
    text-align: left;
    transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }

  .pin-row:hover {
    background: var(--surface-hover);
    color: #ffffff;
  }

  .pin-row.active {
    background: var(--surface-2);
    color: #ffffff;
    font-weight: 600;
  }

  .pin-thumb {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    border-radius: var(--radius-sm);
    background-color: rgba(255, 255, 255, 0.06);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(255, 255, 255, 0.7);
  }
  .pin-thumb.liked-thumb {
    background-image: linear-gradient(135deg, #8e5cf6, #ff6f91) !important;
    color: #ffffff;
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
    gap: 10px;
    margin-top: 10px;
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
    background: var(--accent);
    color: #150b18;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.4);
    transition: transform var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out);
  }
  .play-big:hover {
    filter: brightness(1.08);
    transform: scale(1.04);
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
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--outline);
    border-radius: 20px;
    background: transparent;
    color: var(--ink-1);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }
  .dl-icon-btn:hover:not(:disabled):not(.busy) {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
  .dl-icon-btn.done {
    color: var(--accent);
  }
  .dl-icon-btn:disabled {
    cursor: default;
    opacity: 0.85;
  }
  .dl-icon-btn.busy {
    cursor: default;
    color: var(--ink-2);
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
    gap: 8px;
    height: 40px;
    padding: 0 16px;
    border: 1px solid var(--outline);
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--ink-1);
    font-size: var(--text-md);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }

  .pin-toggle:hover {
    background: rgba(255, 255, 255, 0.14);
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
    gap: 16px;
    max-width: 720px;
  }
  /* Wide view: cards flow into two columns (CSS columns = masonry, so
     cards of different heights don't leave holes). */
  @container view (min-width: 900px) {
    .settings-page {
      display: block;
      max-width: 1180px;
      columns: 2;
      column-gap: 16px;
    }
    .settings-page > h3 {
      column-span: all;
      margin-bottom: 16px;
    }
    .settings-page > .settings-card {
      break-inside: avoid;
      margin-bottom: 16px;
    }
    .settings-page > .settings-sig {
      column-span: all;
    }
  }
  @container view (min-width: 1500px) {
    .settings-page {
      max-width: 1700px;
      columns: 3;
    }
  }

  .settings-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 18px 20px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius-lg);
    background: rgba(12, 10, 16, 0.45);
  }

  .settings-card h4 {
    margin: 0 0 4px 0;
    color: var(--ink-1);
    font-family: var(--font-display);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .settings-line {
    margin: 0;
    color: #e6dfea;
    font-size: var(--text-md);
  }

  .settings-line strong {
    color: #ffffff;
    font-weight: 600;
  }

  .keys-list {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 8px 16px;
    margin: 0;
    font-size: var(--text-md);
  }
  .keys-list dt {
    color: var(--ink-1);
    white-space: nowrap;
  }
  .keys-list dd {
    margin: 0;
    color: var(--ink-2);
  }
  .keys-list kbd {
    display: inline-block;
    min-width: 1.8em;
    padding: 1px 6px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    font-family: inherit;
    font-size: var(--text-sm);
    text-align: center;
  }

  .settings-hint {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .settings-btn {
    align-self: flex-start;
    margin-top: 4px;
    padding: 8px 16px;
    border: 1px solid var(--outline);
    border-radius: 999px;
    background: transparent;
    color: var(--ink-1);
    font-size: var(--text-md);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }

  .settings-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
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
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: #e6dfea;
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
    color: var(--ink-2);
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
  /* yt-dlp sub-block inside the Updates card — a hairline separates it
     from the app's own update controls above. */
  .ytdlp-block {
    margin-top: 0.9rem;
    padding-top: 0.9rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
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
    padding: 7px 14px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 999px;
    background: transparent;
    color: var(--ink-2);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }

  .seg-btn:hover:not(.active) {
    background: rgba(255, 255, 255, 0.06);
    color: #ffffff;
  }

  .seg-btn.active {
    background: var(--surface-2);
    border-color: rgba(255, 255, 255, 0.3);
    color: #ffffff;
    font-weight: 600;
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

  /* Output-device picker row — select stretches, Save button keeps its
     natural width. The select gets the same glass-input look as .add-search. */
  .output-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0.4rem 0 0.5rem;
  }
  .output-select {
    flex: 1;
    min-width: 0;
    padding: 0.55rem 0.8rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 9px;
    color: #ffffff;
    font-size: 0.85rem;
    outline: none;
    cursor: pointer;
  }
  .output-select:focus {
    border-color: rgba(var(--accent-rgb), 0.55);
  }
  /* Chromium styles the dropdown list itself from the select's colors;
     dark background keeps the option list readable on Windows. */
  .output-select option {
    background: #1a122c;
    color: #ffffff;
  }
  .output-save {
    flex: 0 0 auto;
    padding: 0.55rem 1.2rem;
    border: none;
    border-radius: 9px;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    color: #ffffff;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(var(--accent-rgb), 0.4);
  }
  .output-save:hover {
    filter: brightness(1.08);
  }

  /* Crossfade slider row — slider stretches, value label sits to the
     right with tabular-nums so "0s / 4s / 12s" don't shift width. */
  .crossfade-row {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    margin: 0.4rem 0 0.5rem;
  }
  .crossfade-slider {
    flex: 1;
    appearance: none;
    height: 6px;
    border-radius: 4px;
    background: linear-gradient(
      to right,
      var(--accent) 0%,
      var(--accent) var(--p, 0%),
      rgba(255, 255, 255, 0.12) var(--p, 0%),
      rgba(255, 255, 255, 0.12) 100%
    );
    cursor: pointer;
    outline: none;
  }
  .crossfade-slider::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--accent);
    border: 2px solid #ffffff;
    cursor: pointer;
    box-shadow: 0 0 6px rgba(var(--accent-rgb), 0.6);
  }
  .crossfade-value {
    min-width: 70px;
    text-align: right;
    color: #e6dfea;
    font-size: 0.88rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* ---- equalizer ---------------------------------------------------------- */
  .eq-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  /* iOS-style toggle switch for the EQ on/off */
  .eq-toggle {
    color: #ffffff;
    position: relative;
    width: 44px;
    height: 24px;
    border-radius: 12px;
    border: none;
    background: rgba(255, 255, 255, 0.14);
    cursor: pointer;
    padding: 0;
    transition: background 0.18s ease;
    flex: 0 0 auto;
  }
  .eq-toggle.on {
    background: var(--accent);
  }
  .eq-toggle-knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .eq-toggle.on .eq-toggle-knob {
    transform: translateX(20px);
  }

  .eq-presets {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.6rem 0 0.9rem;
    transition: opacity 0.18s ease;
  }
  .eq-presets.disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .eq-preset {
    padding: 0.32rem 0.7rem;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    background: transparent;
    color: var(--ink-2);
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
  }
  .eq-preset:hover:not(:disabled) {
    border-color: rgba(var(--accent-rgb), 0.5);
    color: #fff;
  }
  .eq-preset.active {
    background: rgba(var(--accent-rgb), 0.22);
    border-color: rgba(var(--accent-rgb), 0.6);
    color: #fff;
  }
  .eq-preset-custom {
    cursor: default;
    border-style: dashed;
  }

  /* The 10 vertical band sliders. Each <input type=range> is rotated
     -90° so it stands up; the wrapper gives it a fixed footprint. */
  .eq-bands {
    display: flex;
    justify-content: space-between;
    gap: 0.2rem;
    margin: 0.3rem 0 0.6rem;
    transition: opacity 0.18s ease;
  }
  .eq-bands.disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .eq-band {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    flex: 1 1 0;
    min-width: 0;
  }
  .eq-band-db {
    font-size: 0.68rem;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
    min-height: 0.9rem;
  }
  .eq-band-label {
    font-size: 0.68rem;
    color: var(--ink-3);
  }
  .eq-slider {
    appearance: none;
    writing-mode: vertical-lr;
    direction: rtl;
    width: 6px;
    height: 96px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.12);
    cursor: pointer;
    outline: none;
  }
  .eq-slider::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 12px;
    border-radius: 3px;
    background: var(--accent);
    border: 2px solid #fff;
    cursor: pointer;
    box-shadow: 0 0 5px rgba(var(--accent-rgb), 0.55);
  }
  .eq-slider:disabled::-webkit-slider-thumb {
    background: #6b6280;
    border-color: var(--ink-2);
  }
  .quality-btn {
    flex: 1 1 130px;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 10px;
    background: transparent;
    color: var(--ink-2);
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
    color: var(--ink-3);
  }
  .quality-btn.active .quality-sub {
    color: var(--ink-2);
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
    container: view / inline-size;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 32px 24px 32px;
    display: flex;
    flex-direction: column;
    gap: 1.6rem;
  }

  /* ---- search ------------------------------------------------------------- */

  /* Base button = primary action: solid accent pill (the accent follows
     the cover). Every specialised button overrides what it needs. */
  button {
    padding: 0.6rem 1.2rem;
    border: none;
    border-radius: 999px;
    background: var(--accent);
    color: #150b18;
    font-size: var(--text-md);
    font-weight: 600;
    cursor: pointer;
  }

  button:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .status {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-md);
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
    margin: 1.5rem auto 0;
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
    gap: 14px;
  }
  .section > h3 {
    margin: 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 24px 20px;
  }

  /* ---- home shelves ---------------------------------------------------
     One row per section, as many columns as the width allows (container
     queries on the shelf), the rest reachable with the ‹ › buttons or a
     horizontal scroll. Cards always fill the row exactly. */
  .shelf {
    container-type: inline-size;
    --shelf-n: 8;
  }
  @container (max-width: 1240px) { .shelf-row { --shelf-n: 7; } }
  @container (max-width: 1080px) { .shelf-row { --shelf-n: 6; } }
  @container (max-width: 920px) { .shelf-row { --shelf-n: 5; } }
  @container (max-width: 760px) { .shelf-row { --shelf-n: 4; } }
  @container (max-width: 560px) { .shelf-row { --shelf-n: 3; } }
  .shelf-head {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .shelf-head h3 {
    margin: 0;
    flex: 1;
    min-width: 0;
  }
  .shelf-nav {
    display: none;
    gap: var(--space-1);
  }
  .shelf:global([data-overflow='1']) .shelf-nav {
    display: flex;
  }
  .shelf-arrow {
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--scrim);
    color: var(--ink-1);
    display: grid;
    place-items: center;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
  }
  .shelf-arrow:hover {
    background: rgba(255, 255, 255, 0.14);
  }
  .shelf:global([data-at-start='1']) .shelf-arrow.prev,
  .shelf:global([data-at-end='1']) .shelf-arrow.next {
    opacity: 0.35;
    pointer-events: none;
  }
  .shelf-row {
    --shelf-gap: 20px;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: calc((100% - (var(--shelf-n) - 1) * var(--shelf-gap)) / var(--shelf-n));
    gap: var(--shelf-gap);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    /* room for the cover's hover lift so it isn't clipped */
    padding-top: 4px;
    margin-top: -4px;
  }
  .shelf-row::-webkit-scrollbar {
    display: none;
  }
  .shelf-row > .card-tile {
    scroll-snap-align: start;
  }

  /* ---- pinned tiles (home) ---- */
  .pin-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 12px;
  }
  .pin-tile {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    padding: 10px;
    border: 0;
    border-radius: 12px;
    background: var(--surface-1);
    color: var(--ink-1);
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .pin-tile:hover {
    background: rgba(255, 255, 255, 0.12);
  }
  .pin-tile-cover {
    flex: none;
    width: 56px;
    height: 56px;
    border-radius: var(--radius-sm);
    background-color: rgba(255, 255, 255, 0.08);
    background-size: cover;
    background-position: center;
    display: grid;
    place-items: center;
    color: #e3d9e6;
  }
  .pin-tile-cover.liked-thumb {
    background-image: linear-gradient(135deg, #8e5cf6, #ff6f91) !important;
    color: #ffffff;
  }
  .pin-tile-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .pin-tile-title {
    font-size: var(--text-base);
    font-weight: 600;
    min-width: 0;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .pin-tile-sub {
    font-size: var(--text-sm);
    color: var(--ink-2);
  }

  /* Cover-first cards (home shelves, library, artist pages): no frame, the
     cover carries the card; hover lifts it a little. */
  .card-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    /* <button> defaults to align-items:flex-start in Chromium, which
       sizes the text lines to their content and kills the ellipsis. */
    align-items: stretch;
    gap: 8px;
    padding: 0;
    /* min-width:0 lets the grid/shelf item shrink to its column. */
    min-width: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--ink-1);
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  /* Pin/unpin overlay shown in the top-right of a Library card. Hidden
     until hover (or while pinned so the user can tell at a glance which
     tiles are in their sidebar already). stopPropagation on the click
     keeps the outer card-tile from also opening the playlist. */
  .card-pin {
    position: absolute;
    top: 8px;
    right: 8px;
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

  .card-tile:hover .tile-title {
    color: #ffffff;
  }

  .tile-thumb {
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: var(--radius-md);
    background-color: rgba(255, 255, 255, 0.06);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    transition:
      transform var(--dur-base) var(--ease-out),
      box-shadow var(--dur-base) var(--ease-out);
  }
  /* Subtle Spotify-style zoom on the cover when hovering the tile —
     gives the static grid some life without making any one tile shout.
     overflow:hidden on .card-tile keeps the scaled cover inside its
     rounded corners. */
  .card-tile:hover .tile-thumb {
    transform: translateY(-3px);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
  }

  .tile-title {
    font-size: var(--text-md);
    font-weight: 600;
    line-height: 1.3;
    color: var(--ink-1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tile-subtitle {
    margin-top: -6px;
    font-size: var(--text-sm);
    line-height: 1.3;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ---- playlist header ---------------------------------------------------- */

  .playlist-header {
    display: flex;
    gap: 28px;
    align-items: flex-end;
  }

  .playlist-cover {
    flex: 0 0 auto;
    width: clamp(140px, 24cqi, 210px);
    aspect-ratio: 1 / 1;
    height: auto;
    border-radius: var(--radius-lg);
    background-color: var(--surface-base);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }

  .playlist-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .playlist-title {
    color: var(--ink-1);
    font-family: var(--font-display);
    /* sized by the view's width (container units), not the window's */
    font-size: clamp(24px, 4.4cqi, 44px);
    font-weight: 600;
    line-height: 1.08;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }

  .playlist-subtitle {
    color: #e6dcea;
    font-size: var(--text-md);
    font-weight: 600;
  }

  .playlist-count {
    color: var(--ink-2);
    font-size: var(--text-base);
  }

  /* (.library-frame removed — Phase B replaced the embedded webview with
     a native page-proxied playlist grid. The class wasn't referenced by
     any HTML for a few releases.) */

  /* ---- offline download buttons (playlist view only) --------------------- */

  .track-li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    position: relative;
    /* Drag pickup needs to smoothly fade in the shadow + grow the
       scale; same eased values back when the row is dropped. background
       is included so the .dragging tint also fades. */
    transition: opacity 0.14s ease, box-shadow 0.18s ease,
      transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1),
      background 0.18s ease;
  }
  .track-li .track-row {
    flex: 1;
    /* Without min-width:0, the row's intrinsic min-content width
       (driven by the title's longest unbroken run) keeps it from
       shrinking — long titles then push the heart / duration / dl-btn
       columns past the viewport instead of letting the title ellipsise. */
    min-width: 0;
  }
  /* Inline like toggle — borrowed visual language from the dl-btn so
     the three trailing controls (heart / duration / download) read as
     a small cluster. Filled red when liked. */
  .like-btn {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--ink-3);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out);
  }
  .like-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
  .like-btn.liked {
    color: var(--accent);
  }
  .like-btn.liked:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: var(--accent);
  }
  .like-btn:active:not(:disabled) {
    transform: scale(0.88);
  }
  .like-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  /* Drag-and-drop reorder visuals:
     .dragging  — the row currently being dragged. Instead of fading
                  it (which looks "broken"), keep it vibrant but lift
                  it slightly with a soft accent-tinted shadow — reads
                  like a card you've literally picked up off the page.
     .drag-over — the row currently under the cursor; a 2px accent line
                  on top serves as the drop indicator. Drop lands the
                  row ABOVE the indicator, matching the visual cue. */
  .track-li.dragging {
    transform: scale(1.012);
    box-shadow: 0 8px 22px rgba(var(--accent-rgb), 0.28),
      0 2px 6px rgba(0, 0, 0, 0.35);
    background: rgba(var(--accent-rgb), 0.06);
    border-radius: 10px;
    z-index: 2;
  }
  .track-li.drag-over::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: -1px;
    height: 2px;
    background: linear-gradient(
      90deg,
      transparent 0%,
      var(--accent) 20%,
      var(--accent-2) 80%,
      transparent 100%
    );
    border-radius: 2px;
    box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.7);
    pointer-events: none;
    animation: drop-indicator-in 0.18s ease-out both;
  }
  @keyframes drop-indicator-in {
    from {
      transform: scaleX(0.55);
      opacity: 0;
    }
    to {
      transform: scaleX(1);
      opacity: 1;
    }
  }
  /* Pinned-row indicator: a small accent-tinted pin between the artist
     meta and the duration column. The whole row stays clickable; only
     the pin glyph turns accent so it doesn't bleed into the row hover
     colour. */
  /* Badge on the cover's top-right corner — kept out of the row's flex
     flow so pinned rows line up with the column header. Cover sits at
     10px padding + 28px number + 12px gap = 50px, 40px wide. */
  .pin-mark {
    position: absolute;
    left: 78px;
    top: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: rgba(12, 10, 16, 0.85);
    color: var(--accent);
    opacity: 0.95;
  }
  .track-li.pinned .pin-mark {
    opacity: 1;
  }

  .dl-btn {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--ink-3);
    font-size: 1rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  }

  .dl-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }

  .dl-btn.done {
    color: var(--accent);
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
    color: #e6dfea;
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

  /* Track tables (playlist / album / Downloaded / search / artist top
     songs). The view is a size container: from 760px of width the artist
     gets its own column (A layout), below that it sits under the title
     so a quarter-screen window keeps readable titles. */
  .track-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row-num {
    flex: 0 0 28px;
    text-align: right;
    color: var(--ink-3);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    display: inline-flex;
    justify-content: flex-end;
    align-items: center;
  }
  .track-row.current .row-num {
    color: var(--accent);
  }
  .track-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 0 8px;
    margin-bottom: 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--ink-3);
    font-size: var(--text-sm);
  }
  .track-head .row-num {
    margin-left: 10px;
  }
  /* .view-wrap spaces its children 1.6rem apart; the header belongs to
     the table, so pull the list back up under it. */
  .results-title + .track-list {
    margin-top: calc(14px - 1.6rem);
  }
  .track-head + .track-list {
    margin-top: calc(4px - 1.6rem);
  }
  .th-thumb {
    flex: 0 0 40px;
    margin-left: 4px;
  }
  /* Header cells line up with the row: the row button adds 10px padding
     and 12px gaps where the header row has 8px gaps. */
  .th-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 16px;
    margin: 0 10px 0 4px;
  }
  .th-meta > span {
    flex: 1.5;
  }
  .th-meta > .th-artist {
    flex: 1;
    display: none;
  }
  .th-like,
  .th-dl {
    flex: 0 0 32px;
  }

  .track-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 6px 10px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ink-1);
    font-size: var(--text-base);
    font-weight: normal;
    cursor: pointer;
    text-align: left;
  }

  .track-row:hover:not(:disabled) {
    background: var(--surface-hover);
  }

  .track-row.current {
    background: rgba(255, 255, 255, 0.1);
  }
  .track-row.current .title {
    color: var(--accent);
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
  .track-li.unavailable .dl-btn,
  .track-li.unavailable .like-btn {
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
    width: 40px;
    height: 40px;
    border-radius: var(--radius-xs);
    background-color: rgba(255, 255, 255, 0.06);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    position: relative;
  }

  /* The cover is dimmed while we're resolving its stream URL so the
     centred spinner stays legible against any thumbnail colour. */
  .thumb.resolving::before {
    content: '';
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    border-radius: 6px;
  }
  .thumb-spinner {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.2);
    border-top-color: var(--accent);
    animation: thumb-spin 0.9s linear infinite;
  }
  @keyframes thumb-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .title {
    color: var(--ink-1);
    font-size: var(--text-base);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artist {
    color: var(--ink-2);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @container view (min-width: 760px) {
    .meta {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr);
      align-items: center;
      column-gap: 16px;
    }
    .artist {
      font-size: var(--text-md);
    }
    .th-meta > .th-artist {
      display: block;
    }
  }

  /* Clickable artist name inside a track row's artist line. Hover
     reveals the underline + lightens the colour, signalling it's
     navigable. Lives inside a button (.track-row) so the click handler
     stopPropagations to avoid triggering playback on the parent. */
  .artist-link {
    color: inherit;
    cursor: pointer;
    transition: color 0.15s ease;
  }
  .artist-link:hover,
  .artist-link:focus {
    color: #ffffff;
    text-decoration: underline;
    text-underline-offset: 2px;
    outline: none;
  }

  /* ---- artist view ------------------------------------------------------- */

  .artist-header {
    display: flex;
    gap: 1.4rem;
    align-items: flex-end;
    padding: 1.5rem 0 1.2rem;
    margin-bottom: 0.4rem;
  }
  .artist-photo {
    flex: 0 0 auto;
    width: 168px;
    height: 168px;
    border-radius: 50%;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(var(--accent-rgb), 0.22);
  }
  .artist-info {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-width: 0;
  }
  .artist-name {
    color: #ffffff;
    font-family: var(--font-display);
    font-size: 2.4rem;
    font-weight: 600;
    line-height: 1.05;
    letter-spacing: -0.01em;
  }
  .artist-sub {
    color: var(--ink-2);
    font-size: 0.92rem;
  }
  .artist-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.6rem;
  }
  /* Round tile-thumbs (used for the "related artists" carousel items
     so artist faces read as faces, not as album squares). */
  .tile-thumb.circle {
    border-radius: 50%;
  }

  .duration {
    flex: 0 0 44px;
    text-align: right;
    color: var(--ink-2);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }

  /* ---- player bar (YT Music style) -------------------------------------- */

  /* Bottom player (1.6.0): full width under all three columns, glass over
     the cover background, progress line along its top edge. */
  .player-bar {
    display: flex;
    flex-direction: column;
    position: relative;
    background: rgba(12, 10, 16, 0.72);
    backdrop-filter: blur(28px);
    -webkit-backdrop-filter: blur(28px);
    border-top: 1px solid var(--hairline);
    flex-shrink: 0;
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
  /* The progress line hugs the bar's top edge, full width. The input
     itself is taller (25px hit area) and hangs above the line; hover
     thickens the visible track inside it, so nothing shifts. */
  .seek-wrap {
    position: relative;
    height: 3px;
    margin: 0;
  }
  .seek {
    -webkit-appearance: none;
    appearance: none;
    display: block;
    position: absolute;
    left: 0;
    right: 0;
    /* 13px hit area centred on the 3px line at the bar's top edge (the
       track draws in the input's vertical middle): 5px above the bar —
       it used to hang 11px over the rows above and steal their clicks */
    top: -5px;
    height: 13px;
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
  /* Keyboard focus: no ring around the 25px hit area — show the thumb
     and thicken the track instead, same as hover. */
  .seek:focus-visible::-webkit-slider-thumb {
    opacity: 1;
    margin-top: -3px;
  }
  .seek:focus-visible::-webkit-slider-runnable-track {
    height: 5px;
  }
  .seek-wrap,
  .seek-wrap:focus-within {
    outline: none;
  }

  .bottom-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: var(--space-6);
    align-items: center;
    min-height: 84px;
    padding: 0 var(--space-6);
  }

  .now-playing {
    display: flex;
    gap: 14px;
    align-items: center;
    min-width: 0;
  }

  /* Wrapper sized to the cover so absolute children can overlap during
     the crossfade without disturbing the layout of the meta column. */
  .np-cover-wrap {
    flex: 0 0 auto;
    position: relative;
    width: 54px;
    height: 54px;
  }
  .np-cover {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-sm);
    background-color: var(--surface-base);
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
  }

  .np-meta {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .np-title {
    max-width: 100%;
    color: var(--ink-1);
    font-size: var(--text-base);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .np-artist {
    max-width: 100%;
    color: var(--ink-2);
    font-size: var(--text-sm);
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.np-artist {
    padding: 0;
    border: 0;
    border-radius: 0;
    background: none;
    text-align: left;
    cursor: pointer;
  }
  button.np-artist:hover {
    color: var(--ink-1);
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  /* ---- transport (center column) ---- */

  .transport-buttons {
    display: flex;
    gap: 10px;
    align-items: center;
    justify-content: center;
  }

  /* Override the global purple-gradient button rule for control buttons —
     they're icon buttons, not full-width CTAs. */
  .ctrl {
    width: 44px;
    height: 44px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: #e9e3ee;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition:
      background var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out);
  }

  .ctrl:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }

  .ctrl.small {
    width: 36px;
    height: 36px;
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
  .ctrl.small.like-bar {
    flex: none;
    color: var(--ink-2);
  }
  .ctrl.small.like-bar:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
  .ctrl.small.like-bar.liked {
    color: var(--accent);
  }
  .ctrl.small.like-bar.liked:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--accent);
  }
  .ctrl.small.like-bar:active {
    transform: scale(0.88);
  }

  .ctrl.small.dl {
    position: relative;
    color: var(--ink-2);
  }
  .ctrl.small.dl.busy:hover {
    color: #ff8db5;
    background: rgba(255, 60, 120, 0.18);
  }
  .ctrl.small.dl.done {
    color: var(--accent);
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
    background: var(--ink-1);
    color: var(--surface-base);
  }

  .ctrl.play:hover {
    background: #ffffff;
    color: var(--surface-base);
    transform: scale(1.05);
  }

  /* Inline time readout next to the transport buttons, YT-Music style:
     "0:50 / 2:44". One element, no fixed width, just sits right of next. */
  .time-inline {
    color: var(--ink-2);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    margin-left: var(--space-2);
    white-space: nowrap;
  }

  /* Right side of the player: download · queue · mini-player · volume. */
  .player-extras {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    min-width: 0;
  }
  .ctrl.small.queue-btn.active {
    color: var(--accent);
    background: rgba(255, 255, 255, 0.08);
  }

  /* ---- up next (Now-playing column + queue popover) ---- */
  .np-queue {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 4px -10px 0;
  }
  .q-label {
    padding: 10px 10px 6px;
    font-size: var(--text-md);
    font-weight: 600;
    color: var(--ink-2);
  }
  .q-note {
    margin: 0;
    padding: 0 10px 6px;
    font-size: var(--text-sm);
    color: var(--ink-3);
  }
  .q-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 7px 10px;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink-1);
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  .q-row:hover {
    background: var(--surface-hover);
  }
  .q-thumb {
    flex: none;
    width: 42px;
    height: 42px;
    border-radius: var(--radius-xs);
    background-color: rgba(255, 255, 255, 0.06);
    background-size: cover;
    background-position: center;
  }
  .q-meta {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .q-title,
  .q-artist {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .q-title {
    font-size: var(--text-md);
    font-weight: 600;
  }
  .q-artist {
    font-size: var(--text-sm);
    color: var(--ink-2);
  }
  .q-time {
    flex: none;
    font-size: var(--text-sm);
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
  }
  .queue-pop {
    position: fixed;
    right: var(--space-4);
    bottom: 100px;
    z-index: 40;
    width: 360px;
    max-height: min(60vh, 520px);
    overflow-y: auto;
    padding: var(--space-2);
    border-radius: var(--radius-lg);
    background: rgba(20, 16, 26, 0.94);
    backdrop-filter: blur(28px);
    -webkit-backdrop-filter: blur(28px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
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
    background: rgba(22, 19, 28, 0.96);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    /* Safety net for a menu taller than a short window (e.g. mini-player):
       cap height to the viewport and scroll. The clampCtxMenu action keeps
       the box inside the window horizontally + vertically; this stops a very
       tall menu from overflowing when there's simply not enough height. */
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    /* Scale-in transition uses the top-left corner as the origin so
       the menu appears to grow OUT of the click point (where its
       absolute-positioned top-left was placed), rather than ballooning
       from its centre and looking detached from the cursor. */
    transform-origin: top left;
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
    color: #e6dfea;
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
    color: var(--ink-2);
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
    background: rgba(22, 19, 28, 0.97);
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
    color: #e6dfea;
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
  .access-card {
    max-width: 500px;
  }
  .access-title {
    margin: 0 0 0.6rem;
    font-size: 1.05rem;
  }
  @keyframes confirm-bg-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes confirm-card-in {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  /* ---- add-to-playlist modal ----
     Same glass-card language as the confirm dialog, but laid out for a
     compact, window-adaptive playlist picker. The card caps its size to
     a fraction of the viewport (min() against vw/vh) so it stays usable
     when the player is a small floating window, and the tile grid uses
     auto-fill so column count tracks the available width. */
  .add-backdrop {
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
  .add-card {
    display: flex;
    flex-direction: column;
    width: min(440px, 92vw);
    max-height: min(560px, 82vh);
    padding: 1.1rem 1.2rem 1.2rem;
    background: rgba(22, 19, 28, 0.97);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
    color: #ffffff;
    animation: confirm-card-in 0.16s ease-out;
  }
  .add-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.7rem;
  }
  .add-title {
    font-size: 1.05rem;
    font-weight: 700;
  }
  .add-close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .add-close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: #ffffff;
  }
  .add-track {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.5rem 0.6rem;
    margin-bottom: 0.8rem;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 10px;
  }
  .add-track-cover {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    border-radius: 6px;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.06);
  }
  .add-track-meta {
    min-width: 0;
  }
  .add-track-title {
    font-size: 0.88rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .add-track-artist {
    font-size: 0.78rem;
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .add-loading {
    display: flex;
    justify-content: center;
    padding: 1.5rem 0 2rem;
  }
  .add-empty {
    padding: 1.2rem 0.2rem;
    text-align: center;
    color: var(--ink-2);
    font-size: 0.88rem;
  }
  .add-search {
    width: 100%;
    margin-bottom: 0.8rem;
    padding: 0.55rem 0.8rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 9px;
    color: #ffffff;
    font-size: 0.85rem;
    outline: none;
  }
  .add-search::placeholder {
    color: #8a7daa;
  }
  .add-search:focus {
    border-color: rgba(var(--accent-rgb), 0.55);
  }
  .add-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 0.7rem;
    overflow-y: auto;
    /* Let the grid scroll inside the capped card instead of growing it. */
    padding: 0.1rem 0.2rem 0.2rem 0.1rem;
    margin: 0 -0.2rem;
  }
  .add-tile {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0;
    border: none;
    background: transparent;
    color: #e6dfea;
    cursor: pointer;
    text-align: left;
  }
  .add-tile:disabled {
    cursor: default;
  }
  .add-tile-cover {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    border-radius: 8px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.06);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    transition: transform 0.14s ease, box-shadow 0.14s ease;
  }
  .add-tile:hover:not(:disabled) .add-tile-cover {
    transform: translateY(-2px);
    box-shadow: 0 8px 20px rgba(0, 0, 0, 0.5);
  }
  .add-tile-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .add-tile-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #8a7daa;
  }
  .add-tile-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(15, 10, 28, 0.55);
  }
  .add-tile-title {
    font-size: 0.78rem;
    font-weight: 500;
    line-height: 1.25;
    /* Two-line clamp so long playlist names don't blow out tile height. */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .add-more {
    margin-top: 0.8rem;
    padding: 0.5rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 9px;
    background: transparent;
    color: #e6dfea;
    font-size: 0.83rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }
  .add-more:hover {
    background: rgba(255, 255, 255, 0.07);
    color: #ffffff;
  }

  .toast {
    position: fixed;
    left: 50%;
    bottom: 110px;
    transform: translateX(-50%);
    z-index: 999;
    padding: 0.6rem 1.1rem;
    background: rgba(28, 24, 34, 0.94);
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
    pointer-events: none;
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
  .vol:focus-visible::-webkit-slider-thumb {
    opacity: 1;
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
    color: var(--ink-2);
    font-size: 0.84rem;
    background: rgba(var(--accent-rgb), 0.08);
    border-top: 1px solid #241a38;
    flex-shrink: 0;
  }

  .resolving-bar.error {
    color: #ff6b9d;
    background: rgba(255, 60, 120, 0.1);
  }
  /* ---- loading skeletons ------------------------------------------------
     Defined last so .skel's background wins over the shapes it borrows
     (.tile-thumb, .pin-tile-cover, .artist-photo). */
  .skel {
    display: block;
    position: relative;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.07) !important;
    border-radius: var(--radius-sm);
    box-shadow: none !important;
  }
  .skel::after {
    content: '';
    position: absolute;
    inset: 0;
    transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.07), transparent);
    animation: skel-shimmer 1.6s var(--ease-in-out) infinite;
  }
  @keyframes skel-shimmer {
    to {
      transform: translateX(100%);
    }
  }
  .skel-page {
    display: flex;
    flex-direction: column;
    gap: 1.6rem;
  }
  .skel-heading {
    width: 180px;
    height: 20px;
    border-radius: 6px;
  }
  .skel-title {
    width: min(360px, 60%);
    height: 34px;
    border-radius: 8px;
  }
  .skel-line {
    height: 12px;
    border-radius: 6px;
  }
  .skel-line.short {
    height: 10px;
  }
  .skel-rows {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .skel-row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 6px 10px;
  }
  .skel-num {
    flex: 0 0 14px;
    height: 10px;
    margin-left: 14px;
    border-radius: 4px;
  }
  .skel-thumb {
    flex: 0 0 40px;
    height: 40px;
    border-radius: var(--radius-xs);
  }
  .skel-lines {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .skel-time {
    flex: 0 0 34px;
    height: 10px;
    margin-right: 6px;
    border-radius: 4px;
  }
  .skel-card {
    cursor: default;
  }
  .skel-card:hover .tile-thumb {
    transform: none;
  }
  .skel-pin:hover {
    background: var(--surface-1);
  }
  .skel-card .skel-line {
    margin-top: 2px;
  }
  .skel-pin {
    cursor: default;
  }
  .skel-pin .skel-line {
    flex: 1;
    max-width: 60%;
  }
  .skel-artist-info {
    flex: 1;
    gap: 12px;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
