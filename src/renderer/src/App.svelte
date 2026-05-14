<script lang="ts">
  import logo from './assets/logo.png'

  const version = '0.0.1'
</script>

<main>
  <img class="mark" src={logo} alt="eCoda" />
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
    gap: 0.85rem;
    padding: 2rem;
    text-align: center;
  }

  .mark {
    width: 200px;
    height: 200px;
    filter: drop-shadow(0 0 36px rgba(180, 60, 240, 0.4));
  }

  .logo {
    font-size: 2.6rem;
    font-weight: 800;
    letter-spacing: -0.04em;
    background: linear-gradient(135deg, #a22ff0, #e24dff);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .tagline {
    margin: 0;
    color: #b9acd6;
    font-size: 1rem;
  }

  .badge {
    margin-top: 0.25rem;
    padding: 0.35rem 0.9rem;
    border: 1px solid #3a2d52;
    border-radius: 999px;
    background: rgba(168, 85, 247, 0.07);
    color: #a99bc9;
    font-size: 0.8rem;
  }
</style>
