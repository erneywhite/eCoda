<script lang="ts">
  import { onMount, tick } from 'svelte'
  import wordmark from './assets/wordmark.png'
  import type {
    DownloadProgress,
    HomeItem,
    HomeSection,
    PlaylistView,
    SearchResult
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
      // different id.
      if (openPlaylistId !== entry.id) void loadPlaylistData(entry.id)
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
  let openPlaylistId = $state<string | null>(null)
  let playlistView = $state<PlaylistView | null>(null)
  let playlistLoading = $state(false)
  let playlistError = $state('')

  // ---- settings -----------------------------------------------------------
  let appInfo = $state<{ name: string; version: string; userData: string; repoUrl: string } | null>(
    null
  )
  let cacheStats = $state<{ tracks: number; bytes: number } | null>(null)
  let clearingCache = $state(false)
  let defaultTab = $state<'home' | 'search' | 'library'>('home')

  async function loadSettings(): Promise<void> {
    appInfo = await window.api.app.info()
    cacheStats = await window.api.downloads.stats()
    defaultTab = await window.api.settings.getDefaultTab()
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
    if (
      !confirm(
        'Очистить весь оффлайн-кеш? Все скачанные треки будут удалены с диска. Действие нельзя отменить.'
      )
    )
      return
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
    if (downloadingIds.has(track.id)) return
    if (downloadedIds.has(track.id)) {
      // already downloaded → delete
      const ok = await window.api.downloads.delete(track.id)
      if (ok) removeDownloaded(track.id)
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

  async function downloadCurrentPlaylist(): Promise<void> {
    if (!playlistView || bulkProgress) return
    const pending = playlistView.tracks.filter((t) => !downloadedIds.has(t.id))
    if (pending.length === 0) return
    bulkProgress = { done: 0, total: pending.length, currentTitle: '' }
    try {
      await window.api.downloads.playlist(
        pending.map((t) => ({
          videoId: t.id,
          title: t.title,
          artist: t.artist,
          thumbnail: t.thumbnail
        }))
      )
    } catch (err) {
      console.warn('bulk download failed', err)
    } finally {
      bulkProgress = null
    }
  }

  function handleDownloadProgress(p: DownloadProgress): void {
    if (!p.errored) addDownloaded(p.videoId)
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

  function fmtTime(s: number): string {
    if (!Number.isFinite(s) || s < 0) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  function togglePlay(): void {
    if (!audioEl) return
    if (audioEl.paused) audioEl.play().catch(() => {})
    else audioEl.pause()
  }

  function onSeekInput(e: Event): void {
    seeking = true
    currentTime = Number((e.target as HTMLInputElement).value)
  }
  function onSeekCommit(e: Event): void {
    if (audioEl) audioEl.currentTime = Number((e.target as HTMLInputElement).value)
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

  onMount(async () => {
    browsers = await window.api.auth.browsers()
    connectedBrowser = await window.api.auth.status()
    if (connectedBrowser) {
      // Honour the user's preferred startup tab.
      const initial = await window.api.settings.getDefaultTab()
      defaultTab = initial
      // Reset history to start from the chosen view so back-button
      // doesn't reveal a stale 'home' entry the user never visited.
      historyStack = [{ kind: initial }]
      historyIndex = 0
      view = initial
      applyEntry({ kind: initial })
    }
    // Subscribe to per-track download progress; live updates for the bulk
    // progress UI + flipping each row's badge as it completes.
    const unsub = window.api.downloads.onProgress(handleDownloadProgress)
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
    return () => {
      unsub()
      window.removeEventListener('mouseup', onMouse)
    }
  })

  async function connect(browser: { id: string; name: string }): Promise<void> {
    connecting = browser.id
    connectError = ''
    try {
      const ok = await window.api.auth.connect(browser.id)
      if (ok) {
        connectedBrowser = browser.id
        void loadHome()
      } else {
        connectError = `В ${browser.name} не найден вход в YouTube. Войди в YouTube в этом браузере и попробуй снова.`
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
      playlistView = {
        ...data,
        title: data.title || fallbackTitle,
        thumbnail: data.thumbnail || fallbackThumb
      }
      // Once we have the track list, check which of them are already on
      // disk so the download badges render in the correct state.
      void refreshDownloadStatus(playlistView.tracks)
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

  async function playTrack(track: SearchResult, sourceList: SearchResult[]): Promise<void> {
    if (playStatus === 'resolving') return
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
        sourceList
      }
      playStatus = 'playing'
      // Reset transport state so the UI doesn't briefly show old times
      currentTime = 0
      duration = 0
      await tick()
      const el = audioEl
      if (el) {
        el.volume = volume
        el.muted = muted
        const onCanPlay = (): void => {
          el.removeEventListener('canplay', onCanPlay)
          const ids = nextIdsFrom(track.id, sourceList)
          if (ids.length > 0) void window.api.prefetchAudio(ids)
        }
        el.addEventListener('canplay', onCanPlay)
        el.play().catch(() => {})
      }
    } catch (e) {
      playStatus = 'error'
      playError = e instanceof Error ? e.message : String(e)
    }
  }

  async function playNext(): Promise<void> {
    if (!playing) return
    const list = playing.sourceList
    const idx = list.findIndex((r) => r.id === playing!.id)
    if (idx < 0 || idx + 1 >= list.length) return
    await playTrack(list[idx + 1], list)
  }

  async function playPrev(): Promise<void> {
    if (!playing) return
    const list = playing.sourceList
    const idx = list.findIndex((r) => r.id === playing!.id)
    if (idx <= 0) return
    await playTrack(list[idx - 1], list)
  }
</script>

<main>
  <header>
    <img class="wordmark" src={wordmark} alt="eCoda" />
    <div class="badge">Фаза 2 · native library + offline cache</div>
    {#if connectedBrowser}
      <div class="history-nav">
        <button
          class="hist"
          onclick={goBack}
          disabled={!canBack}
          aria-label="Назад"
          title="Назад"
        >
          ‹
        </button>
        <button
          class="hist"
          onclick={goForward}
          disabled={!canForward}
          aria-label="Вперёд"
          title="Вперёд"
        >
          ›
        </button>
      </div>
    {/if}
  </header>

  {#if !connectedBrowser}
    <section class="card">
      <h2>Подключить аккаунт YouTube</h2>
      <p class="hint">
        eCoda берёт твою сессию YouTube из браузера, где ты уже залогинен — вводить
        ничего не нужно. Браузер можно держать закрытым, вкладка с YouTube не нужна.
        Выбери браузер:
      </p>
      {#if browsers.length > 0}
        <div class="browsers">
          {#each browsers as b (b.id)}
            <button onclick={() => connect(b)} disabled={connecting !== null}>
              {connecting === b.id ? `Проверяю ${b.name}…` : b.name}
            </button>
          {/each}
        </div>
      {:else}
        <p class="status">Поддерживаемые браузеры на этом компьютере не найдены.</p>
      {/if}
      {#if connectError}
        <p class="status error">{connectError}</p>
        <button class="ghost" onclick={() => window.api.auth.openYouTube()}>
          Войти в YouTube в браузере
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
          🏠 Главная
        </button>
        <button
          class="nav"
          class:active={view === 'search'}
          onclick={() => navigate({ kind: 'search' })}
        >
          🔍 Поиск
        </button>
        <button
          class="nav"
          class:active={view === 'library'}
          onclick={openLibrary}
        >
          📚 Библиотека
        </button>
        <div class="nav-spacer"></div>
        <button
          class="nav"
          class:active={view === 'settings'}
          onclick={() => navigate({ kind: 'settings' })}
        >
          ⚙ Настройки
        </button>
      </aside>

      <section class="view-wrap">
        {#if view === 'home'}
          {#if homeLoading}
            <p class="status">Загружаю главную…</p>
          {:else if homeError}
            <p class="status error">Не получилось: {homeError}</p>
            <button onclick={() => loadHome()}>Попробовать ещё раз</button>
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
              placeholder="Поиск трека, артиста, альбома"
              onkeydown={(e) => e.key === 'Enter' && doSearch()}
            />
            <button onclick={doSearch} disabled={searching}>
              {searching ? 'Ищу…' : 'Найти'}
            </button>
          </div>
          {#if searchError}
            <p class="status error">Поиск не получился: {searchError}</p>
          {/if}
          {#if searched && !searching && searchResults.length === 0 && !searchError}
            <p class="status">Ничего не нашлось по запросу.</p>
          {/if}
          {#if searchResults.length > 0}
            <ul class="track-list">
              {#each searchResults as r (r.id)}
                <li>
                  <button
                    class="track-row"
                    class:current={playing?.id === r.id}
                    onclick={() => playTrack(r, searchResults)}
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
                <div class="playlist-title">{playlistView.title || 'Без названия'}</div>
                <div class="playlist-subtitle">{playlistView.subtitle}</div>
                {#if !playlistLoading}
                  <div class="playlist-count">
                    {playlistView.tracks.length} треков
                  </div>
                  {#if bulkProgress}
                    <div class="bulk-progress">
                      Скачиваю {bulkProgress.done} / {bulkProgress.total}
                      {#if bulkProgress.currentTitle}
                        · {bulkProgress.currentTitle}
                      {/if}
                    </div>
                  {:else if playlistView.tracks.some((t) => !downloadedIds.has(t.id))}
                    <button class="dl-bulk" onclick={downloadCurrentPlaylist}>
                      📥 Скачать ({playlistView.tracks.filter((t) => !downloadedIds.has(t.id)).length})
                    </button>
                  {:else}
                    <div class="all-saved">✓ Все треки сохранены</div>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
          {#if playlistLoading}
            <p class="status">Загружаю плейлист…</p>
          {/if}
          {#if playlistError}
            <p class="status error">Не получилось: {playlistError}</p>
          {/if}
          {#if playlistView && playlistView.tracks.length > 0}
            <ul class="track-list">
              {#each playlistView.tracks as r (r.id)}
                <li class="track-li">
                  <button
                    class="track-row"
                    class:current={playing?.id === r.id}
                    onclick={() => playTrack(r, playlistView!.tracks)}
                    disabled={playStatus === 'resolving'}
                  >
                    <div
                      class="thumb"
                      style:background-image={`url("${thumbnailFor(r.id, r.thumbnail)}")`}
                    ></div>
                    <div class="meta">
                      <div class="title">{r.title}</div>
                      <div class="artist">{r.artist}</div>
                    </div>
                    <div class="duration">{r.duration}</div>
                  </button>
                  <button
                    class="dl-btn"
                    class:done={downloadedIds.has(r.id)}
                    class:busy={downloadingIds.has(r.id)}
                    title={downloadedIds.has(r.id)
                      ? 'Удалить с устройства'
                      : downloadingIds.has(r.id)
                        ? 'Скачиваю…'
                        : 'Скачать'}
                    onclick={() => toggleTrackDownload(r)}
                    disabled={downloadingIds.has(r.id)}
                  >
                    {#if downloadedIds.has(r.id)}
                      ✓
                    {:else if downloadingIds.has(r.id)}
                      ⋯
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
            <h3>Настройки</h3>

            <section class="settings-card">
              <h4>Аккаунт</h4>
              <p class="settings-line">
                Подключён браузер: <strong>{browserName(connectedBrowser)}</strong>
              </p>
              <p class="settings-hint">
                eCoda берёт твою сессию YouTube из этого браузера. Если ты сменишь
                аккаунт там — переподключи здесь.
              </p>
              <button class="settings-btn" onclick={disconnect}>Отключить</button>
            </section>

            <section class="settings-card">
              <h4>Поведение</h4>
              <p class="settings-line">Открывать при запуске:</p>
              <div class="seg">
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'home'}
                  onclick={() => changeDefaultTab('home')}
                >
                  🏠 Главная
                </button>
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'search'}
                  onclick={() => changeDefaultTab('search')}
                >
                  🔍 Поиск
                </button>
                <button
                  class="seg-btn"
                  class:active={defaultTab === 'library'}
                  onclick={() => changeDefaultTab('library')}
                >
                  📚 Библиотека
                </button>
              </div>
              <p class="settings-hint">
                Эта вкладка откроется сразу после подключения аккаунта при следующем
                запуске.
              </p>
            </section>

            <section class="settings-card">
              <h4>Оффлайн-кеш</h4>
              {#if cacheStats}
                <p class="settings-line">
                  {cacheStats.tracks} треков · {fmtBytes(cacheStats.bytes)}
                </p>
              {:else}
                <p class="settings-line">Загружаю…</p>
              {/if}
              <p class="settings-hint">
                Скачанные треки играют мгновенно с диска, даже без интернета.
                Управлять отдельными треками можно из плейлистов.
              </p>
              <button
                class="settings-btn danger"
                onclick={clearCache}
                disabled={clearingCache || !cacheStats || cacheStats.tracks === 0}
              >
                {clearingCache ? 'Чищу…' : 'Очистить весь кеш'}
              </button>
            </section>

            <section class="settings-card">
              <h4>Обновления</h4>
              <p class="settings-line">Текущая версия: <strong>{appInfo?.version ?? '…'}</strong></p>
              <p class="settings-hint">
                Автообновление пока не подключено. Скоро: проверка новых релизов
                на GitHub и установка в один клик.
              </p>
              <button class="settings-btn" disabled title="Скоро">
                Проверить обновления
              </button>
            </section>

            <section class="settings-card">
              <h4>О приложении</h4>
              <p class="settings-line">{appInfo?.name ?? 'eCoda'}</p>
              <p class="settings-hint">
                Личный десктоп-клиент YouTube Music. Открытый код.
              </p>
              {#if appInfo?.repoUrl}
                <button
                  class="settings-btn"
                  onclick={() => window.open(appInfo!.repoUrl, '_blank')}
                >
                  Открыть на GitHub
                </button>
              {/if}
            </section>

            <section class="settings-card">
              <h4>Понравилась программа?</h4>
              <p class="settings-hint">
                eCoda полностью бесплатна и open-source. Если хочешь поддержать
                разработку — можно угостить кофе.
              </p>
              <button
                class="settings-btn donate"
                onclick={() => window.open('https://dalink.to/toristarm', '_blank')}
              >
                ☕ Купить мне кофе
              </button>
            </section>
          </div>
        {:else if view === 'library'}
          <!-- Phase B native: page-proxy signs InnerTube calls so we get
               the real authenticated library response, then we render the
               cards ourselves with the same grid as Home. -->
          {#if libraryLoading}
            <p class="status">Загружаю библиотеку…</p>
          {:else if libraryError}
            <p class="status error">Не получилось: {libraryError}</p>
            <button onclick={openLibrary}>Попробовать ещё раз</button>
          {:else if libraryPlaylists && libraryPlaylists.items.length > 0}
            <div class="section">
              <h3>{libraryPlaylists.title}</h3>
              <div class="grid">
                {#each libraryPlaylists.items as item (item.id)}
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
          {:else if libraryPlaylists}
            <p class="status">В библиотеке пока пусто.</p>
          {/if}
        {/if}
      </section>
    </div>

    {#if playStatus === 'resolving'}
      <div class="resolving-bar">Достаю поток…</div>
    {/if}
    {#if playStatus === 'error'}
      <div class="resolving-bar error">Не получилось: {playError}</div>
    {/if}

    {#if playing}
      <div class="player-bar">
        <!-- Thin full-width progress strip flush to the top edge of the
             player bar (visually replaces the top border). Times live
             inline with the transport buttons below, the same way YT Music
             arranges them. -->
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
            <button class="ctrl" onclick={playPrev} aria-label="Предыдущий">
              <!-- skip_previous (material): vertical bar + leftward triangle -->
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6 6h2v12H6z" />
                <path d="M9.5 12 18 6v12z" />
              </svg>
            </button>
            <button class="ctrl play" onclick={togglePlay} aria-label={isPlaying ? 'Пауза' : 'Играть'}>
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
            <button class="ctrl" onclick={playNext} aria-label="Следующий">
              <!-- skip_next (material): rightward triangle + vertical bar -->
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M6 6v12l8.5-6z" />
                <path d="M16 6h2v12h-2z" />
              </svg>
            </button>
            <span class="time-inline">
              {fmtTime(currentTime)} / {fmtTime(duration)}
            </span>
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

        <audio
          bind:this={audioEl}
          src={playing.streamUrl}
          onended={playNext}
          onplay={() => (isPlaying = true)}
          onpause={() => (isPlaying = false)}
          onloadedmetadata={() => (duration = audioEl?.duration ?? 0)}
          ontimeupdate={() => {
            if (!seeking && audioEl) currentTime = audioEl.currentTime
          }}
          onvolumechange={() => {
            if (audioEl) {
              volume = audioEl.volume
              muted = audioEl.muted
            }
          }}
        ></audio>
      </div>
    {/if}
  {/if}
</main>

<style>
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
      radial-gradient(900px 600px at 8% 12%, rgba(201, 125, 246, 0.32), transparent 60%),
      radial-gradient(700px 500px at 92% 18%, rgba(255, 109, 200, 0.18), transparent 60%),
      radial-gradient(900px 700px at 50% 95%, rgba(80, 110, 255, 0.14), transparent 60%),
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
    padding: 1.2rem 2rem;
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

  .badge {
    width: fit-content;
    padding: 0.25rem 0.7rem;
    border: 1px solid #3a2d52;
    border-radius: 999px;
    background: rgba(168, 85, 247, 0.07);
    color: #a99bc9;
    font-size: 0.72rem;
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
    background: rgba(168, 85, 247, 0.18);
    border-color: rgba(168, 85, 247, 0.5);
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
    grid-template-columns: 160px 1fr;
    flex: 1;
    min-height: 0;
    gap: 1rem;
    padding: 0 2rem;
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
    height: fit-content;
    margin-top: 0.5rem;
  }

  .nav {
    display: block;
    text-align: left;
    padding: 0.6rem 0.9rem;
    border: none;
    border-radius: 9px;
    background: transparent;
    color: #b9acd6;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
  }

  .nav:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.05);
    color: #ffffff;
  }

  .nav.active {
    background: linear-gradient(
      90deg,
      rgba(201, 125, 246, 0.28),
      rgba(255, 109, 200, 0.14)
    );
    color: #ffffff;
    box-shadow: 0 4px 18px rgba(201, 125, 246, 0.18);
  }

  .nav:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Pushes whatever follows it to the bottom of the sidebar (Settings). */
  .nav-spacer {
    flex: 1;
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
    background: rgba(168, 85, 247, 0.18);
    border-color: rgba(168, 85, 247, 0.5);
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

  /* "Buy me a coffee" — warm-yellow gradient so it stands out as a
     thank-you button rather than a normal action. */
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
    background: rgba(168, 85, 247, 0.1);
    color: #ffffff;
  }

  .seg-btn.active {
    background: rgba(168, 85, 247, 0.22);
    border-color: rgba(168, 85, 247, 0.55);
    color: #ffffff;
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

  input {
    flex: 1;
    padding: 0.65rem 0.85rem;
    border: 1px solid #34284e;
    border-radius: 9px;
    background: #0e0a16;
    color: #ffffff;
    font-size: 0.9rem;
    outline: none;
  }

  input:focus {
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

  .card-tile:hover {
    background: rgba(255, 255, 255, 0.07);
    border-color: rgba(201, 125, 246, 0.45);
    transform: translateY(-3px);
    box-shadow: 0 14px 36px rgba(201, 125, 246, 0.18);
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

  /* ---- library (embedded YT Music) --------------------------------------- */

  /* The webview consumes the entire view-wrap so YT Music's own scroller is
     the one in charge. .view-wrap has padding by default — we negate it so
     the iframe-equivalent goes edge to edge inside the main column. */
  .library-frame {
    display: flex;
    flex: 1;
    width: 100%;
    min-height: 0;
    border: none;
    margin: 0 0 -1.5rem 0;
  }

  /* ---- offline download buttons (playlist view only) --------------------- */

  .track-li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .track-li .track-row {
    flex: 1;
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
    background: rgba(168, 85, 247, 0.18);
    border-color: rgba(168, 85, 247, 0.5);
    color: #ffffff;
  }

  .dl-btn.done {
    border-color: rgba(120, 200, 120, 0.55);
    background: rgba(120, 200, 120, 0.15);
    color: #9eef9e;
  }

  .dl-btn.busy {
    cursor: default;
    opacity: 0.7;
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

  .bulk-progress {
    margin-top: 0.4rem;
    color: #c9b8e6;
    font-size: 0.82rem;
    font-style: italic;
  }

  .all-saved {
    margin-top: 0.4rem;
    color: #9eef9e;
    font-size: 0.82rem;
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
    background: rgba(168, 85, 247, 0.09);
  }

  .track-row.current {
    background: rgba(168, 85, 247, 0.18);
  }

  .track-row:disabled {
    opacity: 0.55;
    cursor: default;
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
    border-top: 1px solid rgba(255, 255, 255, 0.07);
    flex-shrink: 0;
  }

  /* The seek bar sits flush against the top of the player bar and visually
     replaces the top border. 12px tall input = generous click target, but
     the actual coloured track inside is only 3px (5px on hover). */
  .seek {
    -webkit-appearance: none;
    appearance: none;
    display: block;
    width: 100%;
    height: 12px;
    margin: 0;
    padding: 0;
    background: transparent;
    cursor: pointer;
  }

  .bottom-row {
    display: grid;
    grid-template-columns: minmax(220px, 1fr) auto minmax(140px, 1fr);
    gap: 1.5rem;
    align-items: center;
    padding: 0.5rem 1.5rem 0.85rem;
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
    background: rgba(168, 85, 247, 0.18);
    color: #ffffff;
  }

  .ctrl.small {
    width: 30px;
    height: 30px;
  }

  .ctrl.play {
    width: 48px;
    height: 48px;
    background: linear-gradient(135deg, #c97df6, #ff6dc8);
    color: #0a0612;
    box-shadow: 0 8px 22px rgba(201, 125, 246, 0.5);
  }

  .ctrl.play:hover {
    background: linear-gradient(135deg, #d493ff, #ff85d4);
    color: #0a0612;
    transform: scale(1.06);
    box-shadow: 0 10px 28px rgba(201, 125, 246, 0.65);
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
    /* anchor visible track to the top edge of the 12px-tall input */
    margin-top: 0;
    border-radius: 0;
    background: linear-gradient(
      to right,
      #c97df6 0%,
      #ff6dc8 var(--p, 0%),
      rgba(255, 255, 255, 0.08) var(--p, 0%),
      rgba(255, 255, 255, 0.08) 100%
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
    background: #c97df6;
    border: none;
    opacity: 0;
    transition: opacity 0.15s ease;
  }

  .seek:hover::-webkit-slider-thumb {
    opacity: 1;
    margin-top: -3px;
  }

  /* Volume — same look but anchored centred (it lives inline with controls,
     not as a top edge). */
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
  }

  .vol::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 999px;
    background: linear-gradient(
      to right,
      #c97df6 0%,
      #ff6dc8 var(--p, 0%),
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
    background: rgba(168, 85, 247, 0.07);
    border-top: 1px solid #241a38;
    flex-shrink: 0;
  }

  .resolving-bar.error {
    color: #ff6b9d;
    background: rgba(255, 60, 120, 0.1);
  }
</style>
