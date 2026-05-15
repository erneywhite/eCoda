// Diagnostic — checks whether yt.session.player is actually initialized
// after Innertube.create(). If not, decipher will fail unconditionally.
import { Innertube } from 'youtubei.js'

const yt = await Innertube.create()
console.log('session:', !!yt.session)
console.log('session.player:', !!yt.session.player)
console.log('session.player type:', typeof yt.session.player)
if (yt.session.player) {
  console.log('player props:', Object.getOwnPropertyNames(yt.session.player).slice(0, 20))
  console.log('player proto:', Object.getOwnPropertyNames(Object.getPrototypeOf(yt.session.player)).slice(0, 20))
}

// Inspect a format closely so we know what fields it actually has
const info = await yt.getInfo('dQw4w9WgXcQ')
const fmt = info.chooseFormat({ type: 'audio', quality: 'best' })
console.log('\nformat:')
console.log('  has .url            :', typeof fmt.url, fmt.url ? `len=${fmt.url.length}` : '')
console.log('  has .signature_cipher:', typeof fmt.signature_cipher)
console.log('  has .cipher          :', typeof fmt.cipher)
console.log('  itag                 :', fmt.itag)
console.log('  mime_type            :', fmt.mime_type)
console.log('  bitrate              :', fmt.bitrate)
console.log('  is_drc / audio_quality:', fmt.is_drc, '/', fmt.audio_quality)
console.log('  own props :', Object.getOwnPropertyNames(fmt).slice(0, 30))
