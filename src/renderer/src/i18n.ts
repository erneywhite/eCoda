// Minimal i18n for the renderer. Two locales (ru, en); a flat string map
// per locale keyed by dotted identifiers. The translate() helper returns
// the key itself if a string is missing so a brand-new label still shows
// something readable instead of `undefined`.
export type Lang = 'ru' | 'en'

export const LANG_LABELS: Record<Lang, string> = {
  ru: 'Русский',
  en: 'English'
}

type Strings = Record<string, string>

const RU: Strings = {
  // Sidebar nav
  'nav.home': 'Главная',
  'nav.search': 'Поиск',
  'nav.library': 'Библиотека',
  'nav.downloaded': 'Скачанные',
  'nav.settings': 'Настройки',
  'downloaded.title': 'Скачанные',
  'downloaded.subtitle': 'Доступны оффлайн',
  'downloaded.empty': 'Ничего ещё не скачано. Используй ↓ на треке или 📥 на плейлисте.',
  'downloaded.summary': '{n} треков · {size}',
  'nav.back': 'Назад',
  'nav.forward': 'Вперёд',
  'window.minimize': 'Свернуть',
  'window.maximize': 'Развернуть',
  'window.restore': 'Восстановить',
  'window.close': 'Закрыть',
  'mini.enter': 'Мини-плеер',
  'mini.exit': 'Развернуть в полный',
  'mini.switchToSquare': 'Квадратный вид',
  'mini.switchToCompact': 'Компактный вид',

  // Connect screen
  'connect.title': 'Подключить аккаунт YouTube',
  'connect.hint':
    'eCoda берёт твою сессию YouTube из браузера, где ты уже залогинен — вводить ничего не нужно. Браузер можно держать закрытым, вкладка с YouTube не нужна. Выбери браузер:',
  'connect.checking': 'Проверяю {browser}…',
  'connect.error': 'В {browser} не найден вход в YouTube. Войди в YouTube в этом браузере и попробуй снова.',
  'connect.openYouTube': 'Войти в YouTube в браузере',
  'connect.noBrowsers': 'Поддерживаемые браузеры на этом компьютере не найдены.',
  'connect.safariFda':
    'Для Safari нужен доступ к диску: Системные настройки → Конфиденциальность и безопасность → Полный доступ к диску → включи eCoda. Иначе чтение cookies не сработает.',

  // Search
  'search.placeholder': 'Поиск трека, артиста, альбома',
  'search.button.idle': 'Найти',
  'search.button.busy': 'Ищу…',
  'search.empty': 'Ничего не нашлось по запросу.',
  'search.error': 'Поиск не получился: {error}',

  // Home / Library generic
  'home.loading': 'Загружаю главную…',
  'home.error': 'Не получилось: {error}',
  'home.retry': 'Попробовать ещё раз',
  'home.empty': 'Главная пуста.',
  'library.loading': 'Загружаю библиотеку…',
  'library.empty': 'В библиотеке пока пусто.',
  'library.myPlaylists': 'Мои плейлисты',
  // Liked Music is an auto-playlist — name comes from YT in YT's locale,
  // but we override for the sidebar pin so it follows the UI language.
  'liked.music': 'Понравившаяся музыка',
  'liked.music.subtitle': 'Авто-плейлист',

  // Playlist view
  'playlist.untitled': 'Без названия',
  'playlist.loading': 'Загружаю плейлист…',
  'playlist.count': '{n} треков',
  'playlist.subtitle.playlist': 'Playlist',
  'playlist.download.bulk': '📥 Скачать ({n})',
  'playlist.download.allSaved': '✓ Все треки сохранены',
  'playlist.download.progress': 'Скачиваю {done} / {total}',
  'playlist.pin': 'Закрепить',
  'playlist.pinned': 'Закреплено',
  'playlist.pinTitle.add': 'Закрепить в сайдбаре',
  'playlist.pinTitle.remove': 'Открепить из сайдбара',

  // Player
  'player.resolving': 'Достаю поток…',
  'player.error': 'Не получилось: {error}',
  'player.prev': 'Предыдущий',
  'player.next': 'Следующий',
  'player.play': 'Играть',
  'player.pause': 'Пауза',
  'player.mute': 'Выключить звук',
  'player.unmute': 'Включить звук',
  'player.shuffle': 'Перемешать (вкл/выкл)',
  'player.repeat.off': 'Повтор выключен',
  'player.repeat.all': 'Повтор плейлиста',
  'player.repeat.one': 'Повтор трека',

  // Track-row download badges
  'track.dl.idle': 'Скачать',
  'track.dl.busy': 'Скачиваю…',
  'track.dl.cancel': 'Отменить скачивание',
  'track.dl.done': 'Удалить с устройства',
  'track.unavailable': 'Трек недоступен',
  'downloads.cancelBulk': 'Отменить скачивание плейлиста',

  // Context menu (right-click on a track row)
  'ctx.playNext': 'Играть следующим',
  'ctx.addToQueue': 'Добавить в очередь',
  'ctx.startRadio': 'Радио по треку',
  'ctx.pinPosition': 'Закрепить позицию',
  'ctx.unpinPosition': 'Открепить позицию',
  'ctx.pinnedHint': 'Закреплён — остаётся на месте при перемешке',

  // Inline heart toggle on each row
  'like.add': 'В понравившиеся',
  'like.remove': 'Убрать из понравившихся',

  // Playlist header
  'playlist.reshuffle': 'Перемешать сейчас',
  'playlist.resetOrder': 'Сбросить порядок к исходному',
  'playlist.resetConfirm':
    'Сбросить порядок треков к исходному с YouTube? Все закрепления и пользовательский порядок будут утеряны.',

  // Radio (auto-generated playlist view)
  'radio.title': 'Радиостанция · {title}',
  'radio.subtitle': 'Авто-радио по треку',

  // Album / artist
  'album.label': 'Альбом',
  'artist.untitled': 'Исполнитель',
  'artist.topSongs': 'Популярные песни',
  'artist.shufflePlay': 'Перемешать и играть',
  'artist.subscribers': 'подписчиков',

  // Toast messages
  'toast.playNextAdded': '«{title}» — следующим',
  'toast.queueAdded': '«{title}» — в очереди',
  'toast.likeFailed': 'Не получилось обновить лайк',

  // Confirm dialog (in-app replacement for native confirm)
  'confirm.ok': 'Подтвердить',
  'confirm.cancel': 'Отмена',

  // Settings page
  'settings.title': 'Настройки',
  'settings.account.title': 'Аккаунт',
  'settings.account.connected': 'Подключён браузер:',
  'settings.account.hint':
    'eCoda берёт твою сессию YouTube из этого браузера. Если ты сменишь аккаунт там — переподключи здесь.',
  'settings.account.disconnect': 'Отключить',
  'settings.theme.title': 'Цветовая палитра',
  'settings.theme.hint':
    'Переключает акцентный цвет, фоновое свечение и кнопки плеера. Применяется мгновенно.',
  'theme.purple': 'Фиолетовая',
  'theme.cyan': 'Кибер-циан',
  'theme.sunset': 'Закат',
  'theme.forest': 'Лесная',
  'theme.crimson': 'Кровавая',
  'theme.mono': 'Монохром',
  'theme.ocean': 'Океан',
  'theme.neon': 'Розовый неон',
  'settings.behaviour.title': 'Поведение',
  'settings.behaviour.defaultTab': 'Открывать при запуске:',
  'settings.behaviour.hint':
    'Эта вкладка откроется сразу после подключения аккаунта при следующем запуске.',
  'settings.closeAction.label': 'При закрытии окна (✕):',
  'settings.closeAction.tray': 'Свернуть в трей',
  'settings.closeAction.quit': 'Выйти из приложения',
  'settings.closeAction.hint':
    '«Свернуть в трей» оставляет музыку играть в фоне — окно появится снова из иконки в трее. «Выйти» закрывает приложение полностью.',
  'settings.lang.title': 'Язык интерфейса',
  'settings.lang.hint': 'Меняется мгновенно. Списки и плейлисты с YouTube используют локаль YT.',
  'settings.cache.title': 'Оффлайн-кеш',
  'settings.cache.stats': '{tracks} треков · {size}',
  'settings.cache.loading': 'Загружаю…',
  'settings.cache.hint':
    'Скачанные треки играют мгновенно с диска, даже без интернета. Управлять отдельными треками можно из плейлистов.',
  'settings.cache.clear': 'Очистить весь кеш',
  'settings.cache.clearing': 'Чищу…',
  'settings.cache.clearConfirm':
    'Очистить весь оффлайн-кеш? Все скачанные треки будут удалены с диска. Действие нельзя отменить.',
  'settings.quality.title': 'Качество скачивания',
  'settings.quality.hint':
    'Применяется к новым загрузкам. Уже скачанные треки не перекодируются.',
  'settings.quality.best': 'Лучшее',
  'settings.quality.bestSub': '~160 kbps · 5 MB/4 мин',
  'settings.quality.medium': 'Среднее',
  'settings.quality.mediumSub': '~128 kbps · 3.8 MB/4 мин',
  'settings.quality.low': 'Экономия',
  'settings.quality.lowSub': '~70 kbps · 2 MB/4 мин',
  'settings.crossfade.title': 'Кросс-фейд между треками',
  'settings.crossfade.off': 'Выключено',
  'settings.crossfade.seconds': '{n} сек',
  'settings.crossfade.hint':
    'Плавное затухание конца одного трека и нарастание следующего. Работает только при автопереходе — ручное переключение прыгает мгновенно. 0 = выключено.',
  'settings.updates.title': 'Обновления',
  'settings.updates.current': 'Текущая версия:',
  'settings.updates.idleHint':
    'Нажми «Проверить обновления», чтобы узнать, не появилась ли новая версия в GitHub Releases.',
  'settings.updates.checking': 'Проверяю наличие обновлений…',
  'settings.updates.available': 'Доступна новая версия {version}.',
  'settings.updates.downloading': 'Скачиваю обновление: {percent}%',
  'settings.updates.downloaded': 'Версия {version} скачана. Перезапусти eCoda, чтобы установить.',
  'settings.updates.upToDate': 'Установлена последняя версия.',
  'settings.updates.checkBtn': 'Проверить обновления',
  'settings.updates.checkingBtn': 'Проверяю…',
  'settings.updates.downloadBtn': 'Скачать обновление',
  'settings.updates.installBtn': 'Перезапустить и установить',
  'settings.about.title': 'О приложении',
  'settings.about.hint': 'Личный десктоп-клиент YouTube Music. Открытый код.',
  'settings.about.openGitHub': 'Открыть на GitHub',
  'settings.donate.title': 'Понравилась программа?',
  'settings.donate.hint':
    'eCoda полностью бесплатна и open-source. Если хочешь поддержать разработку — можно угостить кофе.',
  'settings.donate.button': '☕ Купить мне кофе',

  // Diagnostics (Settings)
  'settings.diag.title': 'Диагностика',
  'settings.diag.hint':
    'Если кеш «исчезает» между запусками или ты хочешь посмотреть логи — здесь основные пути и кнопки.',
  'settings.diag.userData': 'Папка данных',
  'settings.diag.cache': 'Папка кеша',
  'settings.diag.logFile': 'Файл логов',
  'settings.diag.open': 'Открыть',
  'settings.diag.verify': 'Проверить кеш',
  'settings.diag.verifying': 'Проверяю…',
  'settings.diag.verifyResult':
    'Проверено. Записей в манифесте: {entries}. Файлов на диске: {files}. Удалено битых: {dead}. Восстановлено: {orphans}.',

  // Download summary (after bulk download)
  'downloads.summary.ok': 'Скачано {ok} из {total}',
  'downloads.summary.failed': '{n} не удалось скачать',
  'downloads.summary.retry': 'Повторить неудачные',
  'downloads.summary.dismiss': 'OK'
}

const EN: Strings = {
  'nav.home': 'Home',
  'nav.search': 'Search',
  'nav.library': 'Library',
  'nav.downloaded': 'Downloaded',
  'nav.settings': 'Settings',
  'downloaded.title': 'Downloaded',
  'downloaded.subtitle': 'Available offline',
  'downloaded.empty': 'Nothing downloaded yet. Use ↓ on a track or 📥 on a playlist.',
  'downloaded.summary': '{n} tracks · {size}',
  'nav.back': 'Back',
  'nav.forward': 'Forward',
  'window.minimize': 'Minimize',
  'window.maximize': 'Maximize',
  'window.restore': 'Restore',
  'window.close': 'Close',
  'mini.enter': 'Mini-player',
  'mini.exit': 'Restore full window',
  'mini.switchToSquare': 'Square layout',
  'mini.switchToCompact': 'Compact layout',

  'connect.title': 'Connect your YouTube account',
  'connect.hint':
    'eCoda picks up your YouTube session from a browser where you’re already signed in — no password to type. The browser can be closed; you don’t need a YouTube tab open. Pick a browser:',
  'connect.checking': 'Checking {browser}…',
  'connect.error': 'No YouTube login found in {browser}. Sign into YouTube in that browser and try again.',
  'connect.openYouTube': 'Open YouTube in browser',
  'connect.noBrowsers': 'No supported browsers found on this machine.',
  'connect.safariFda':
    'Safari needs Full Disk Access: System Settings → Privacy & Security → Full Disk Access → enable eCoda. Otherwise reading cookies will fail.',

  'search.placeholder': 'Search for a track, artist, album',
  'search.button.idle': 'Search',
  'search.button.busy': 'Searching…',
  'search.empty': 'Nothing matched your query.',
  'search.error': 'Search failed: {error}',

  'home.loading': 'Loading home…',
  'home.error': 'Failed: {error}',
  'home.retry': 'Try again',
  'home.empty': 'Home is empty.',
  'library.loading': 'Loading library…',
  'library.empty': 'Library is empty.',
  'library.myPlaylists': 'My playlists',
  'liked.music': 'Liked Music',
  'liked.music.subtitle': 'Auto playlist',

  'playlist.untitled': 'Untitled',
  'playlist.loading': 'Loading playlist…',
  'playlist.count': '{n} tracks',
  'playlist.subtitle.playlist': 'Playlist',
  'playlist.download.bulk': '📥 Download ({n})',
  'playlist.download.allSaved': '✓ All tracks saved',
  'playlist.download.progress': 'Downloading {done} / {total}',
  'playlist.pin': 'Pin',
  'playlist.pinned': 'Pinned',
  'playlist.pinTitle.add': 'Pin to sidebar',
  'playlist.pinTitle.remove': 'Unpin from sidebar',

  'player.resolving': 'Fetching stream…',
  'player.error': 'Playback failed: {error}',
  'player.prev': 'Previous',
  'player.next': 'Next',
  'player.play': 'Play',
  'player.pause': 'Pause',
  'player.mute': 'Mute',
  'player.unmute': 'Unmute',
  'player.shuffle': 'Shuffle (toggle)',
  'player.repeat.off': 'Repeat off',
  'player.repeat.all': 'Repeat playlist',
  'player.repeat.one': 'Repeat track',

  'track.dl.idle': 'Download',
  'track.dl.busy': 'Downloading…',
  'track.dl.cancel': 'Cancel download',
  'track.dl.done': 'Remove from device',
  'track.unavailable': 'Track unavailable',
  'downloads.cancelBulk': 'Cancel playlist download',

  'ctx.playNext': 'Play next',
  'ctx.addToQueue': 'Add to queue',
  'ctx.startRadio': 'Start radio',
  'ctx.pinPosition': 'Pin position',
  'ctx.unpinPosition': 'Unpin position',
  'ctx.pinnedHint': 'Pinned — stays put on reshuffle',

  'like.add': 'Add to Liked Music',
  'like.remove': 'Remove from Liked Music',

  'playlist.reshuffle': 'Reshuffle now',
  'playlist.resetOrder': 'Reset to default order',
  'playlist.resetConfirm':
    'Reset track order to YouTube’s default? All pins and custom ordering will be lost.',

  'radio.title': 'Radio · {title}',
  'radio.subtitle': 'Auto-generated radio',

  'album.label': 'Album',
  'artist.untitled': 'Artist',
  'artist.topSongs': 'Top songs',
  'artist.shufflePlay': 'Shuffle play',
  'artist.subscribers': 'subscribers',

  'toast.playNextAdded': '"{title}" — playing next',
  'toast.queueAdded': '"{title}" — added to queue',
  'toast.likeFailed': 'Couldn’t update like',

  'confirm.ok': 'Confirm',
  'confirm.cancel': 'Cancel',

  'settings.title': 'Settings',
  'settings.account.title': 'Account',
  'settings.account.connected': 'Connected browser:',
  'settings.account.hint':
    'eCoda reads your YouTube session from this browser. If you switch accounts there, reconnect here.',
  'settings.account.disconnect': 'Disconnect',
  'settings.theme.title': 'Colour theme',
  'settings.theme.hint':
    'Switches the accent colour, background glow and player buttons. Applies instantly.',
  'theme.purple': 'Purple',
  'theme.cyan': 'Cyber Cyan',
  'theme.sunset': 'Sunset',
  'theme.forest': 'Forest',
  'theme.crimson': 'Crimson',
  'theme.mono': 'Mono',
  'theme.ocean': 'Ocean',
  'theme.neon': 'Neon Pink',
  'settings.behaviour.title': 'Behaviour',
  'settings.behaviour.defaultTab': 'Open on startup:',
  'settings.behaviour.hint':
    'This tab opens automatically after the account connects on the next launch.',
  'settings.closeAction.label': 'When the window is closed (✕):',
  'settings.closeAction.tray': 'Minimize to tray',
  'settings.closeAction.quit': 'Quit app',
  'settings.closeAction.hint':
    'Minimize keeps music playing in the background — bring the window back from the tray icon. Quit exits the app entirely.',
  'settings.lang.title': 'Interface language',
  'settings.lang.hint':
    'Applies instantly. YouTube’s own playlist and section titles still use YT’s locale.',
  'settings.cache.title': 'Offline cache',
  'settings.cache.stats': '{tracks} tracks · {size}',
  'settings.cache.loading': 'Loading…',
  'settings.cache.hint':
    'Downloaded tracks play instantly from disk, even offline. Manage individual tracks from playlists.',
  'settings.cache.clear': 'Clear all cache',
  'settings.cache.clearing': 'Clearing…',
  'settings.cache.clearConfirm':
    'Clear the entire offline cache? All downloaded tracks will be deleted from disk. This can’t be undone.',
  'settings.quality.title': 'Download quality',
  'settings.quality.hint':
    'Applies to new downloads. Already-downloaded tracks aren’t re-encoded.',
  'settings.quality.best': 'Best',
  'settings.quality.bestSub': '~160 kbps · 5 MB/4 min',
  'settings.quality.medium': 'Medium',
  'settings.quality.mediumSub': '~128 kbps · 3.8 MB/4 min',
  'settings.quality.low': 'Saver',
  'settings.quality.lowSub': '~70 kbps · 2 MB/4 min',
  'settings.crossfade.title': 'Track-to-track crossfade',
  'settings.crossfade.off': 'Off',
  'settings.crossfade.seconds': '{n} s',
  'settings.crossfade.hint':
    'Smooth fade-out of the ending track + fade-in of the next one. Only applies to auto-progression — manual prev/next switches instantly. 0 disables.',
  'settings.updates.title': 'Updates',
  'settings.updates.current': 'Current version:',
  'settings.updates.idleHint':
    'Press “Check for updates” to see whether a newer version is on GitHub Releases.',
  'settings.updates.checking': 'Checking for updates…',
  'settings.updates.available': 'A new version {version} is available.',
  'settings.updates.downloading': 'Downloading update: {percent}%',
  'settings.updates.downloaded': 'Version {version} downloaded. Restart eCoda to install.',
  'settings.updates.upToDate': 'You are on the latest version.',
  'settings.updates.checkBtn': 'Check for updates',
  'settings.updates.checkingBtn': 'Checking…',
  'settings.updates.downloadBtn': 'Download update',
  'settings.updates.installBtn': 'Restart and install',
  'settings.about.title': 'About',
  'settings.about.hint': 'A personal desktop YouTube Music client. Open source.',
  'settings.about.openGitHub': 'Open on GitHub',
  'settings.donate.title': 'Like the app?',
  'settings.donate.hint':
    'eCoda is fully free and open-source. If you want to support development, you can buy me a coffee.',
  'settings.donate.button': '☕ Buy me a coffee',

  'settings.diag.title': 'Diagnostics',
  'settings.diag.hint':
    'If the cache “disappears” between launches or you want to look at the logs — here are the main paths and buttons.',
  'settings.diag.userData': 'User data folder',
  'settings.diag.cache': 'Cache folder',
  'settings.diag.logFile': 'Log file',
  'settings.diag.open': 'Open',
  'settings.diag.verify': 'Verify cache',
  'settings.diag.verifying': 'Verifying…',
  'settings.diag.verifyResult':
    'Verified. Manifest entries: {entries}. Files on disk: {files}. Dead entries removed: {dead}. Orphans recovered: {orphans}.',

  'downloads.summary.ok': 'Downloaded {ok} of {total}',
  'downloads.summary.failed': '{n} failed to download',
  'downloads.summary.retry': 'Retry failed',
  'downloads.summary.dismiss': 'OK'
}

const TABLES: Record<Lang, Strings> = { ru: RU, en: EN }

// Translate with optional {placeholder} interpolation. Falls back to the
// Russian table if a key is missing in the chosen language, and finally
// to the key itself so a fresh label still shows something readable.
export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  const raw = TABLES[lang][key] ?? TABLES.ru[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}
