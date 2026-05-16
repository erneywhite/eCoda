<div align="center">
  <img src="src/renderer/src/assets/wordmark.png" alt="eCoda" width="380" />

  ### Твой YouTube Music как обычное приложение для ПК

  [![Скачать](https://img.shields.io/github/v/release/erneywhite/eCoda?label=Скачать&style=for-the-badge&color=a22ff0)](https://github.com/erneywhite/eCoda/releases/latest)
  [![Лицензия](https://img.shields.io/github/license/erneywhite/eCoda?style=for-the-badge&color=8a2be2)](LICENSE)
</div>

---

**eCoda** — это нативный десктоп-клиент для YouTube Music. Без браузерных вкладок, которые теряются среди тридцати других. Без открытой в фоне страницы YT, которая сжирает гигабайт RAM. Своё окно, свой плеер, своя библиотека.

Просто открываешь приложение — и слушаешь.

<p align="center">
  <img src="docs/screenshot-library.png" alt="Главный экран eCoda" width="800" />
  <br>
  <sub><i>Если картинки нет — добавлю как только сделаю парочку чистых скриншотов :)</i></sub>
</p>

---

## ✨ Что умеет

- 🎵 **Твоя настоящая библиотека YT Music** — все плейлисты, «Понравившаяся музыка», подписки. То что у тебя есть в браузере — есть и тут
- 💾 **Качай музыку на диск** — отдельный трек, целый плейлист или всё что лайкнул. Слушай без интернета (например в самолёте)
- 🎚️ **Кросс-фейд между треками** — плавный переход вместо резкого обрыва. Настраивается ползунком 0–12 секунд
- 🪟 **Мини-плеер** — компактное окно поверх всех окон, чтобы переключать треки не отрываясь от работы. Два варианта: тонкая полоска или квадратик с обложкой
- ⌨️ **Медиа-клавиши работают** — Play/Pause/Next/Prev на клавиатуре, виджет на lockscreen Windows и в Now Playing на macOS
- 🎨 **8 цветовых тем** — от пастельных до неоновых
- 🦝 **Сворачивается в трей** — закрыл окно крестиком, музыка продолжает играть в фоне (можно отключить если бесит)
- 🌍 **Русский + English** интерфейс
- 🔁 **Помнит где остановился** — закрыл посреди трека, открыл назавтра, продолжил с той же секунды
- 🎲 **Для стримеров** — закрепляй интро трека на первом месте, тасуй остальное в один клик, drag-and-drop порядок треков

И ещё много мелочей которые видно только в процессе использования.

---

## 📥 Скачать

<div align="center">

### [⬇️ Последняя версия на GitHub Releases](https://github.com/erneywhite/eCoda/releases/latest)

</div>

| Платформа | Файл | Размер |
| --- | --- | --- |
| **Windows 10/11** (x64) | `eCoda-Setup-1.0.0.exe` | ~131 MB |
| **macOS** (Apple Silicon — M1/M2/M3/M4) | `eCoda-1.0.0-arm64.dmg` | ~180 MB |

---

## ⚙️ Установка

### Windows

1. Скачай `.exe` по ссылке выше и запусти
2. Windows может ругнуться: «Защитник: приложение от неизвестного издателя» — это нормально для приложений без официальной подписи Microsoft ($300/год не платил, извините). Жми **«Подробнее» → «Выполнить в любом случае»**
3. Пройди инсталлятор как обычно
4. Запусти eCoda. Выбери из списка браузер, в котором ты уже залогинен на YouTube — eCoda прочитает оттуда твою сессию. Пароли вводить не нужно

### macOS

1. Скачай `.dmg`, открой, перетащи **eCoda** в **Applications**
2. Первый запуск: macOS заматерится — приложение не подписано через Apple Developer Program ($99/год тоже не платил). Это исправить просто:
   - **Правый клик на иконке eCoda** в Applications → **«Открыть»**
   - В появившемся окне ещё раз нажми **«Открыть»**
   - Это нужно сделать **один раз**, дальше будет запускаться обычным двойным кликом
3. Выбери браузер с залогиненным YouTube — eCoda прочитает оттуда cookies

---

## 🧩 Что нужно

- **Установленный браузер** где ты залогинен на YouTube. Поддерживаются почти все:
  Firefox, Chrome, Edge, Brave, Opera, Vivaldi, Chromium, Whale, Safari (только Mac) + форки Firefox (Waterfox, LibreWolf, Floorp, Zen)
  > Браузер не обязательно держать открытым — eCoda просто читает cookies оттуда при подключении
- **YouTube Premium** — крайне рекомендуется. С Premium треки идут в 256 kbps Opus и без рекламных пауз. Без Premium тоже работает, но с рекламой и качеством до 128 kbps
- Никаких регистраций, аккаунтов, телеметрии. Всё локально у тебя на диске

---

## 🎯 Как пользоваться (быстрый старт)

После того как подключил браузер:

- **Слева сайдбар** — Главная (рекомендации YT), Поиск, Библиотека (твои плейлисты), Скачанные (то что лежит на диске)
- **Понравившаяся музыка** автоматически появится в сайдбаре сверху как закреплённый плейлист
- **Любой плейлист можно закрепить** в сайдбаре кнопкой 📌 — будет всегда под рукой
- **Правый клик по треку** — меню: «Играть следующим», «В очередь», «Радио по треку», «Закрепить позицию»
- **Сердечко рядом с треком** — лайкнуть/убрать. Лайки синхронятся с YT
- **Кнопка ⛶ в шапке** (рядом со стрелками) — мини-плеер
- **⚙️ Настройки** внизу сайдбара — темы, язык, качество скачивания, кросс-фейд, поведение крестика, и т.д.

---

## ❓ Часто задаваемые

<details>
<summary><b>Это легально?</b></summary>

eCoda — это просто клиент к YouTube. Он использует тот же API что и официальный YT Music, и проигрывает только то что доступно в твоём аккаунте.

Тем не менее — это **неофициальный** клиент, не аффилирован с YouTube или Google. Используй на свой страх и риск, уважай правила YouTube.

</details>

<details>
<summary><b>Будет ли мобильная версия?</b></summary>

Нет, проект только для десктопа. На мобильных есть официальное приложение YT Music — оно отлично работает.

</details>

<details>
<summary><b>Где хранятся скачанные треки?</b></summary>

- **Windows:** `%APPDATA%\ecoda\offline\`
- **macOS:** `~/Library/Application Support/ecoda/offline/`

Можно открыть прямо из приложения: Настройки → Диагностика → «Открыть» рядом с «Папка кеша».

</details>

<details>
<summary><b>Обновления приходят автоматически?</b></summary>

Да, при запуске eCoda тихо проверяет наличие новой версии на GitHub Releases. Если есть — покажет в Настройках → Обновления. Можно скачать одним кликом и нажать «Перезапустить и установить».

Если апдейтер молчит — можно проверить вручную там же, кнопкой «Проверить обновления».

</details>

<details>
<summary><b>На macOS Safari не работает / просит доступ</b></summary>

Safari хранит cookies в защищённой папке, и eCoda нужен **Полный доступ к диску** чтобы её прочитать:

Системные настройки → Конфиденциальность и безопасность → Полный доступ к диску → включить eCoda

После этого перезапусти приложение и Safari появится в списке браузеров.

</details>

<details>
<summary><b>Можно сменить аккаунт?</b></summary>

Да — Настройки → Аккаунт → «Отключить». Потом снова выбрать браузер. Если хочешь сменить аккаунт YouTube — перелогинься в браузере, потом подключи его в eCoda заново.

</details>

<details>
<summary><b>А что насчёт Linux?</b></summary>

Linux-сборки пока нет. В принципе код кросс-платформенный (Electron + youtubei.js + yt-dlp работают везде), просто руки не дошли собрать `.deb`/`.AppImage` и протестить. Если интересно — открой Issue, или сделай PR.

</details>

---

## 🎨 Благодарности

- 🦝 **Маскот-енот + wordmark** — нарисовал **[╻٭𝕊˙𖣐˙ℝ˙𝔸˙𝕊٭╹](https://t.me/S_O_R_A_S)**.
- 🛠️ **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** + **[youtubei.js](https://github.com/LuanRT/YouTube.js)** — без них этого приложения бы не было
- 🚀 **[Electron](https://www.electronjs.org/)** + **[Svelte](https://svelte.dev/)** + **[Deno](https://deno.com/)** — стек, на котором всё работает

---

## 📜 Лицензия + дисклеймер

[MIT](LICENSE) — делай с кодом что хочешь, только не вини меня если что-то сломается.

eCoda — **неофициальный** клиент, не связан с YouTube или Google. Сделан для личного использования. Уважай правила YouTube и местные законы.

Багрепорты и идеи — в [Issues](https://github.com/erneywhite/eCoda/issues).

<sub>Made with 🦝 by Erney White, 2026</sub>

---

<details>
<summary><h3>🇬🇧 English version</h3></summary>

<div align="center">

### Your YouTube Music as a real desktop app

[![Download](https://img.shields.io/github/v/release/erneywhite/eCoda?label=Download&style=for-the-badge&color=a22ff0)](https://github.com/erneywhite/eCoda/releases/latest)

</div>

---

**eCoda** is a native desktop client for YouTube Music. No browser tabs that get lost among thirty others. No background YT page eating a gigabyte of RAM. Its own window, its own player, your library — proper.

Just open the app and listen.

## ✨ What it does

- 🎵 **Your real YT Music library** — all your playlists, Liked Music, subscriptions. What you have in the browser, you have here
- 💾 **Download music to disk** — per track, per playlist, or your entire Liked Music. Listen offline (planes, subway, dodgy hotel WiFi)
- 🎚️ **Track-to-track crossfade** — smooth overlap instead of hard cuts. Slider 0–12 seconds in Settings
- 🪟 **Mini-player** — always-on-top compact window to skip tracks without leaving what you're doing. Two layouts: horizontal pill or square cover-focused
- ⌨️ **Hardware media keys work** — Play/Pause/Next/Prev on your keyboard, Windows lockscreen widget, macOS Now Playing
- 🎨 **8 colour themes** — pastel to neon
- 🦝 **Closes to system tray** — hit the X, music keeps playing in the background (toggleable if you'd rather it actually quit)
- 🌍 **Russian + English** UI
- 🔁 **Remembers where you left off** — close mid-track, reopen tomorrow, picks up at the same second
- 🎲 **Streamer-friendly playlists** — pin an intro track at position 0, reshuffle the rest with one click, drag-and-drop reorder

Plus dozens of small touches you'll only notice while using it.

## 📥 Download

[**⬇️ Latest release on GitHub**](https://github.com/erneywhite/eCoda/releases/latest)

| Platform | File | Size |
| --- | --- | --- |
| **Windows 10/11** (x64) | `eCoda-Setup-1.0.0.exe` | ~131 MB |
| **macOS** (Apple Silicon — M1/M2/M3/M4) | `eCoda-1.0.0-arm64.dmg` | ~180 MB |

## ⚙️ Install

**Windows:** download the `.exe`, run it. SmartScreen will warn (unsigned app — Microsoft asks $300/year for code-signing, hard pass). Click **"More info" → "Run anyway"**. Pick a browser where you're already signed into YouTube on first launch — eCoda reads your session from there.

**macOS:** open the `.dmg`, drag eCoda to Applications. First launch: **right-click → Open → Open** (Gatekeeper, app isn't notarised through Apple Developer Program — $99/year, also hard pass). One-time. Then pick a browser, same as Windows.

## 🧩 What you need

- A browser signed into YouTube — Firefox / Chrome / Edge / Brave / Opera / Vivaldi / Chromium / Whale / Safari (macOS) + Firefox forks. Doesn't need to be open afterwards.
- **YouTube Premium recommended** — 256 kbps Opus + no ad breaks. Works without, with ads.
- No accounts, no telemetry. Everything lives on your disk.

## ❓ FAQ

**Is this legal?** It's an unofficial client for YouTube that uses the same API as the official YT Music app and plays only what's available in your account. That said — it's not affiliated with YouTube or Google, use at your own discretion, respect YT's terms.

**Where are downloaded tracks stored?** Windows: `%APPDATA%\ecoda\offline\`. macOS: `~/Library/Application Support/ecoda/offline/`.

**Auto-updates?** Yes, eCoda checks GitHub Releases on launch + Settings → Updates has a "Check now" button.

**Safari on macOS asks for Full Disk Access** — Safari keeps its cookies in a sandbox; eCoda needs FDA to read them. System Settings → Privacy & Security → Full Disk Access → enable eCoda. Restart the app.

**Linux?** Not shipped yet. Code is cross-platform, but I haven't packaged `.deb`/`.AppImage`. Open an Issue if you want it.

## 🎨 Credits

Mascot + wordmark by **[╻٭𝕊˙𖣐˙ℝ˙𝔸˙𝕊٭╹](https://t.me/S_O_R_A_S)**. Powered by [yt-dlp](https://github.com/yt-dlp/yt-dlp), [youtubei.js](https://github.com/LuanRT/YouTube.js), [Electron](https://www.electronjs.org/), [Svelte](https://svelte.dev/), and [Deno](https://deno.com/).

## 📜 License + disclaimer

[MIT](LICENSE). eCoda is **unofficial** and not affiliated with YouTube or Google. For personal use. Bug reports + ideas welcome in [Issues](https://github.com/erneywhite/eCoda/issues).

<sub>Made with 🦝 by Erney White, 2026</sub>

</details>
