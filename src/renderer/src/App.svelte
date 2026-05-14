<script lang="ts">
  const version = '0.0.1'
</script>

<main>
  <div class="logo">eCoda</div>
  <p class="tagline">Десктопный клиент YouTube Music — владей своей музыкой</p>
  <div class="badge">Фаза 0 · каркас · v{version}</div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
    gap: 1rem;
    padding: 2rem;
    text-align: center;
  }

  .logo {
    font-size: 4rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    background: linear-gradient(135deg, #a855f7, #e879f9);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 0 28px rgba(168, 85, 247, 0.45));
  }

  .tagline {
    margin: 0;
    color: #b9acd6;
    font-size: 1.05rem;
  }

  .badge {
    margin-top: 0.5rem;
    padding: 0.35rem 0.9rem;
    border: 1px solid #3a2d52;
    border-radius: 999px;
    background: rgba(168, 85, 247, 0.07);
    color: #a99bc9;
    font-size: 0.8rem;
  }
</style>
