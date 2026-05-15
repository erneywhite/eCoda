<script lang="ts">
  import { onMount, tick } from 'svelte'
  import logo from './assets/logo.png'

  type PlayStatus = 'idle' | 'resolving' | 'playing' | 'error'
  type SearchResultUI = {
    id: string
    title: string
    artist: string
    duration: string
    thumbnail: string
  }

  let connectedBrowser = $state<string | null>(null)
  let browsers = $state<{ id: string; name: string }[]>([])
  let connecting = $state<string | null>(null)
  let connectError = $state('')

  let query = $state('')
  let searching = $state(false)
  let searchError = $state('')
  let searchResults = $state<SearchResultUI[]>([])
  let searched = $state(false)

  let playing = $state<{
    id: string
    title: string
    artist: string
    format: string
    streamUrl: string
  } | null>(null)
  let playStatus = $state<PlayStatus>('idle')
  let playError = $state('')
  let audioEl = $state<HTMLAudioElement>()

  onMount(async () => {
    browsers = await window.api.auth.browsers()
    connectedBrowser = await window.api.auth.status()
  })

  async function connect(browser: { id: string; name: string }): Promise<void> {
    connecting = browser.id
    connectError = ''
    try {
      const ok = await window.api.auth.connect(browser.id)
      if (ok) {
        connectedBrowser = browser.id
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
    searchResults = []
    searched = false
    playing = null
    playStatus = 'idle'
  }

  function browserName(id: string | null): string {
    return browsers.find((b) => b.id === id)?.name ?? id ?? ''
  }

  async function doSearch(): Promise<void> {
    const q = query.trim()
    if (!q || searching) return
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

  async function play(result: SearchResultUI): Promise<void> {
    if (playStatus === 'resolving') return
    playStatus = 'resolving'
    playError = ''
    try {
      const r = await window.api.resolveAudio(result.id)
      playing = {
        id: result.id,
        title: r.title || result.title,
        artist: result.artist,
        format: r.format,
        streamUrl: r.streamUrl
      }
      playStatus = 'playing'
      await tick()
      audioEl?.play().catch(() => {})
    } catch (e) {
      playStatus = 'error'
      playError = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<main>
  <header>
    <img class="mark" src={logo} alt="eCoda" />
    <div class="title-block">
      <div class="logo">eCoda</div>
      <div class="badge">Фаза 1 · поиск + воспроизведение</div>
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
        eCoda берёт твою сессию YouTube из браузера, где ты уже залогинен —
        вводить ничего не нужно. Браузер можно держать закрытым, вкладка с
        YouTube не нужна. Выбери браузер:
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
    <section class="card">
      <div class="row">
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
        <ul class="results">
          {#each searchResults as r (r.id)}
            <li>
              <button
                class="result"
                onclick={() => play(r)}
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
    </section>

    {#if playing}
      <section class="card now-playing">
        <div class="track">
          <div class="track-title">{playing.title}</div>
          <div class="track-meta">{playing.artist} · формат: {playing.format}</div>
        </div>
        <audio bind:this={audioEl} src={playing.streamUrl} controls></audio>
      </section>
    {/if}

    {#if playStatus === 'resolving'}
      <p class="status">Достаю поток…</p>
    {/if}
    {#if playStatus === 'error'}
      <p class="status error">Не получилось проиграть: {playError}</p>
    {/if}
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    height: 100vh;
    padding: 2.5rem;
    overflow-y: auto;
  }

  header {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .mark {
    width: 72px;
    height: 72px;
    filter: drop-shadow(0 0 18px rgba(180, 60, 240, 0.45));
  }

  .title-block {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .logo {
    font-size: 1.9rem;
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

  .row {
    display: flex;
    gap: 0.6rem;
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

  .results {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .result {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    width: 100%;
    padding: 0.55rem;
    border: none;
    border-radius: 9px;
    background: transparent;
    color: #ffffff;
    font-size: 0.9rem;
    font-weight: normal;
    cursor: pointer;
    text-align: left;
  }

  .result:hover:not(:disabled) {
    background: rgba(168, 85, 247, 0.09);
  }

  .result:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .thumb {
    flex: 0 0 auto;
    width: 56px;
    height: 56px;
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
    font-size: 0.95rem;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .artist {
    color: #a99bc9;
    font-size: 0.82rem;
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

  .now-playing {
    border-color: #3a2d52;
  }

  .track {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .track-title {
    color: #ffffff;
    font-size: 1rem;
    font-weight: 600;
  }

  .track-meta {
    color: #8c7da8;
    font-size: 0.8rem;
  }

  audio {
    width: 100%;
  }
</style>
