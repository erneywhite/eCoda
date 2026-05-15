// Dumps the full audio-format object to a file so we can inspect every
// field (.url, .signature_cipher, .cipher, .audio_track, etc.) without
// youtubei.js parser warnings drowning out stdout.
import { Innertube } from 'youtubei.js'
import { writeFileSync } from 'node:fs'

const VIDEO_ID = process.argv[2] || 'dQw4w9WgXcQ'
const yt = await Innertube.create()
const info = await yt.getInfo(VIDEO_ID)

const audioFmts = (info?.streaming_data?.adaptive_formats ?? [])
  .filter((f) => f.has_audio && !f.has_video)
  .map((f) => {
    const o = {}
    for (const k of Object.getOwnPropertyNames(f)) {
      const v = f[k]
      o[k] =
        typeof v === 'function'
          ? `[fn ${k}]`
          : typeof v === 'string' && v.length > 200
            ? v.slice(0, 200) + '…(' + v.length + ')'
            : v
    }
    return o
  })

const out = {
  client: 'WEB (default)',
  videoId: VIDEO_ID,
  player: {
    has: !!yt.session.player,
    keys: yt.session.player ? Object.getOwnPropertyNames(yt.session.player) : [],
    poToken: yt.session.player?.po_token ? '(present, len=' + String(yt.session.player.po_token).length + ')' : null,
    signatureTimestamp: yt.session.player?.signature_timestamp ?? null
  },
  nAudioFormats: audioFmts.length,
  audioFormats: audioFmts
}

writeFileSync('probe-format.json', JSON.stringify(out, null, 2))
console.log('wrote probe-format.json (' + audioFmts.length + ' audio formats)')
