<script lang="ts">
  import { onMount, tick } from 'svelte'
  import logo from './assets/logo.png'

  type Status = 'idle' | 'resolving' | 'ready' | 'error'

  let connectedBrowser = $state<string | null>(null)
  let browsers = $state<{ id: string; name: string }[]>([])
  let connecting = $state<string | null>(null)
  let connectError = $state('')

  let input = $state('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  let status = $state<Status>('idle')
  let errorMsg = $state('')
  let title = $state('')
  let format = $state('')
  let streamUrl = $state('')
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
    status = 'idle'
  }

  function browserName(id: string | null): string {
    return browsers.find((b) => b.id === id)?.name ?? id ?? ''
  }

  async function resolveAndPlay(): Promise<void> {
    if (!input.trim() || status === 'resolving') return
    status = 'resolving'
    errorMsg = ''
    title = ''
    streamUrl = ''
    try {
      const result = await window.api.resolveAudio(input)
      title = result.title
      format = result.format
      streamUrl = result.streamUrl
      status = 'ready'
      await tick()
      audioEl?.play().catch(() => {})
    } catch (e) {
      status = 'error'
      errorMsg = e instanceof Error ? e.message : String(e)
    }
  }
</script>

<main>
  <header>
    <img class="mark" src={logo} alt="eCoda" />
    <div class="title-block">
      <div class="logo">eCoda</div>
      <div class="badge">Фаза 1 · вход + извлечение</div>
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
      <p class="hint">
        Вставь ссылку на трек/видео YouTube (или 11-значный ID) и нажми «Играть».
      </p>
      <div class="row">
        <input
          type="text"
          bind:value={input}
          placeholder="https://music.youtube.com/watch?v=…"
          onkeydown={(e) => e.key === 'Enter' && resolveAndPlay()}
        />
        <button onclick={resolveAndPlay} disabled={status === 'resolving'}>
          {status === 'resolving' ? 'Достаю…' : 'Играть'}
        </button>
      </div>

      {#if status === 'resolving'}
        <p class="status">yt-dlp достаёт поток…</p>
      {/if}
      {#if status === 'error'}
        <p class="status error">Не получилось: {errorMsg}</p>
      {/if}
      {#if status === 'ready'}
        <div class="track">
          <div class="track-title">{title}</div>
          <div class="track-meta">формат: {format}</div>
        </div>
        <audio bind:this={audioEl} src={streamUrl} controls></audio>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 2rem;
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
    max-width: 720px;
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
