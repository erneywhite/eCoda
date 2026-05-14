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
    background: linear-gradient(135deg, #ff5e62, #ff9966);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .tagline {
    margin: 0;
    color: #b3b3b3;
    font-size: 1.05rem;
  }

  .badge {
    margin-top: 0.5rem;
    padding: 0.35rem 0.9rem;
    border: 1px solid #2a2a2a;
    border-radius: 999px;
    color: #888;
    font-size: 0.8rem;
  }
</style>
