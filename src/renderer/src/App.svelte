<script lang="ts">
  import { onMount, tick } from 'svelte'
  import logo from './assets/logo.png'
  import type { HomeItem, HomeSection, PlaylistView, SearchResult } from '../../preload/index.d'

  type View = 'home' | 'search' | 'playlist'
  type PlayStatus = 'idle' | 'resolving' | 'playing' | 'error'

  // ---- auth state -----------------------------------------------------------
  let connectedBrowser = $state<string | null>(null)
  let browsers = $state<{ id: string; name: string }[]>([])
  let connecting = $state<string | null>(null)
  let connectError = $state('')

  // ---- navigation -----------------------------------------------------------
  let view = $state<View>('home')

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

  // ---- player ---------------------------------------------------------------
  let playing = $state<{
    id: string
    title: string
    artist: string
    format: string
    streamUrl: string
    sourceList: SearchResult[]
  } | null>(null)
  let playStatus = $state<PlayStatus>('idle')
  let playError = $state('')
  let audioEl = $state<HTMLAudioElement>()

  // The "queue" that prefetch + next-track use is whatever list the user is
  // currently looking at — search results or a playlist's track list.
  function currentList(): SearchResult[] {
    if (view === 'playlist' && playlistView) return playlistView.tracks
    return searchResults
  }

  onMount(async () => {
    browsers = await window.api.auth.browsers()
    connectedBrowser = await window.api.auth.status()
    if (connectedBrowser) void loadHome()
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
    view = 'home'
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
    view = 'search'
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

  async function openPlaylist(
    id: string,
    fallback?: { fallbackTitle?: string; fallbackThumbnail?: string }
  ): Promise<void> {
    view = 'playlist'
    openPlaylistId = id
    playlistLoading = true
    playlistError = ''
    // Seed with fallback so the header doesn't flash empty
    playlistView = {
      title: fallback?.fallbackTitle ?? '',
      subtitle: '',
      thumbnail: fallback?.fallbackThumbnail ?? '',
      tracks: []
    }
    try {
      playlistView = await window.api.metadata.playlist(id)
    } catch (e) {
      playlistError = e instanceof Error ? e.message : String(e)
    } finally {
      playlistLoading = false
    }
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
        title: r.title || track.title,
        artist: track.artist,
        format: r.format,
        streamUrl: r.streamUrl,
        sourceList
      }
      playStatus = 'playing'
      await tick()
      const el = audioEl
      if (el) {
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
    <img class="mark" src={logo} alt="eCoda" />
    <div class="title-block">
      <div class="logo">eCoda</div>
      <div class="badge">Фаза 1 · home + search + playlists</div>
    </div>
    {#if connectedBrowser}
      <button class="ghost" onclick={disconnect}>
        Отключить · {browserName(connectedBrowser)}
      </button>
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
          onclick={() => {
            view = 'home'
            if (!homeSections && !homeLoading) void loadHome()
          }}
        >
          🏠 Главная
        </button>
        <button
          class="nav"
          class:active={view === 'search'}
          onclick={() => (view = 'search')}
        >
          🔍 Поиск
        </button>
        <button class="nav" disabled title="Скоро — фикс парсера youtubei.js">
          📚 Библиотека
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
                <li>
                  <button
                    class="track-row"
                    class:current={playing?.id === r.id}
                    onclick={() => playTrack(r, playlistView!.tracks)}
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
        <div class="player-meta">
          <div class="player-title">{playing.title}</div>
          <div class="player-artist">
            {playing.artist} · {playing.format}
          </div>
        </div>
        <div class="player-controls">
          <button class="ctrl" onclick={playPrev} title="Предыдущий">⏮</button>
          <button class="ctrl" onclick={playNext} title="Следующий">⏭</button>
        </div>
        <audio bind:this={audioEl} src={playing.streamUrl} controls onended={playNext}></audio>
      </div>
    {/if}
  {/if}
</main>

<style>
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

  .mark {
    width: 56px;
    height: 56px;
    filter: drop-shadow(0 0 18px rgba(180, 60, 240, 0.45));
  }

  .title-block {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .logo {
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    background: linear-gradient(135deg, #a22ff0, #e24dff);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
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
    margin-left: auto;
    padding: 0.5rem 1rem;
    border: 1px solid #34284e;
    border-radius: 9px;
    background: transparent;
    color: #b9acd6;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
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
    border: 1px solid #241a38;
    border-radius: 14px;
    background: #150f22;
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
    grid-template-columns: 200px 1fr;
    flex: 1;
    min-height: 0;
    gap: 1rem;
    padding: 0 2rem;
  }

  .sidebar {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.5rem 0;
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
    background: rgba(168, 85, 247, 0.07);
    color: #ffffff;
  }

  .nav.active {
    background: rgba(168, 85, 247, 0.18);
    color: #ffffff;
  }

  .nav:disabled {
    opacity: 0.4;
    cursor: default;
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
    padding: 0.5rem;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: #ffffff;
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .card-tile:hover {
    background: rgba(168, 85, 247, 0.09);
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---- playlist header ---------------------------------------------------- */

  .playlist-header {
    display: flex;
    gap: 1.3rem;
    align-items: flex-end;
  }

  .playlist-cover {
    flex: 0 0 auto;
    width: 180px;
    height: 180px;
    border-radius: 10px;
    background-color: #0e0a16;
    background-position: center;
    background-size: cover;
    background-repeat: no-repeat;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.5);
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

  /* ---- player bar --------------------------------------------------------- */

  .player-bar {
    display: grid;
    grid-template-columns: 1fr auto 2fr;
    gap: 1.2rem;
    align-items: center;
    padding: 0.8rem 2rem;
    border-top: 1px solid #241a38;
    background: #110b1c;
    flex-shrink: 0;
  }

  .player-meta {
    min-width: 0;
  }

  .player-title {
    color: #ffffff;
    font-size: 0.95rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .player-artist {
    color: #8c7da8;
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .player-controls {
    display: flex;
    gap: 0.5rem;
  }

  .ctrl {
    width: 38px;
    height: 38px;
    padding: 0;
    font-size: 1rem;
    background: rgba(168, 85, 247, 0.14);
    color: #ffffff;
  }

  .ctrl:hover {
    background: rgba(168, 85, 247, 0.28);
  }

  audio {
    width: 100%;
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
