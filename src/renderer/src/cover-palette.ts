// Accent colours derived from a track's cover art — the heart of the 1.6.0
// "cover colour" look (the blurred cover itself is drawn by App.svelte).
//
// Runs entirely in the renderer: every thumbnail host YouTube Music uses
// (i.ytimg.com, yt3.ggpht.com, yt3/lh3.googleusercontent.com) answers with
// `Access-Control-Allow-Origin: *`, and our media:// handler adds the same
// header to offline thumbs, so fetch() → createImageBitmap() reads the pixels
// without tainting anything. A failed fetch/decode returns null and the
// caller falls back to the brand violet; it isn't cached, so the next play
// of that track tries again.

export interface CoverPalette {
  accent: string // '#rrggbb', light enough for text on the dark UI
  accent2: string // second hue for gradients
  accentRgb: string // 'r, g, b' — for the rgba(var(--accent-rgb), a) uses
}

export const BRAND_PALETTE: CoverPalette = {
  accent: '#c97df6',
  accent2: '#ff6dc8',
  accentRgb: '201, 125, 246'
}

export interface CoverAnalysis {
  palette: CoverPalette | null // null = greyscale cover → brand violet
  luminance: number // mean relative luminance 0..1, for dimming the backdrop
}

const SAMPLE = 32 // the cover is downscaled to SAMPLE×SAMPLE before analysis
const FETCH_TIMEOUT_MS = 8000
const CACHE_MAX = 300
const cache = new Map<string, CoverAnalysis>()
const inflight = new Map<string, Promise<CoverAnalysis | null>>()

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h * 60, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function hex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

interface HueBin {
  weight: number
  r: number
  g: number
  b: number
  sat: number
  count: number
}

// Picks the cover's most prominent *vivid* hue (weighted by saturation and
// by how close to mid-lightness a pixel is, so a big white or black area
// doesn't win) and lifts it to a readable light tint. A near-greyscale cover
// has no hue worth showing → null, and the UI keeps the brand violet.
export function paletteFromPixels(data: Uint8ClampedArray): CoverPalette | null {
  const bins: HueBin[] = Array.from({ length: 12 }, () => ({ weight: 0, r: 0, g: 0, b: 0, sat: 0, count: 0 }))
  let opaque = 0
  let chromatic = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    opaque++
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const [h, s, l] = rgbToHsl(r, g, b)
    if (s < 0.18 || l < 0.1 || l > 0.92) continue
    chromatic++
    const w = s * (1 - Math.min(1, Math.abs(l - 0.5) * 1.6))
    const bin = bins[Math.floor(h / 30) % 12]
    bin.weight += w
    bin.r += r * w
    bin.g += g * w
    bin.b += b * w
    bin.sat += s * w
    bin.count++
  }
  if (opaque === 0 || chromatic / opaque < 0.06) return null

  const ranked = bins
    .map((bin) => {
      if (bin.weight === 0) return null
      const [h] = rgbToHsl(bin.r / bin.weight, bin.g / bin.weight, bin.b / bin.weight)
      return { hue: h, sat: bin.sat / bin.weight, weight: bin.weight }
    })
    .filter((x): x is { hue: number; sat: number; weight: number } => x !== null)
    .sort((a, b) => b.weight - a.weight)
  const main = ranked[0]
  if (!main) return null

  // Light, readable accent: lightness fixed high so it passes 4.5:1 on the
  // dark background for any hue; saturation follows the cover but stays in
  // a band where muted covers still read as tinted and loud ones don't glare.
  const sat = Math.min(0.85, Math.max(0.42, main.sat * 1.1))
  const accentRgb = hslToRgb(main.hue, sat, 0.74)

  const second = ranked.find((x) => hueDistance(x.hue, main.hue) >= 30 && x.weight >= main.weight * 0.15)
  const hue2 = second ? second.hue : main.hue + 35
  const accent2 = hslToRgb(hue2, Math.min(0.9, sat + 0.05), 0.66)

  return {
    accent: hex(accentRgb),
    accent2: hex(accent2),
    accentRgb: accentRgb.join(', ')
  }
}

// Mean relative luminance (sRGB → linear, Rec. 709 weights) of the opaque
// pixels. A near-white cover blurred behind the UI would wash out the text,
// so App.svelte dims the backdrop harder the brighter the cover is.
export function meanLuminance(data: Uint8ClampedArray): number {
  const lin = (v: number): number => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  let sum = 0
  let n = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue
    sum += 0.2126 * lin(data[i]) + 0.7152 * lin(data[i + 1]) + 0.0722 * lin(data[i + 2])
    n++
  }
  return n ? sum / n : 0
}

// null = transient failure (network, timeout, decode): not cached.
async function compute(url: string): Promise<CoverAnalysis | null> {
  let bitmap: ImageBitmap | null = null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    const blob = await res.blob()
    bitmap = await createImageBitmap(blob, {
      resizeWidth: SAMPLE,
      resizeHeight: SAMPLE,
      resizeQuality: 'medium'
    })
    const canvas = new OffscreenCanvas(SAMPLE, SAMPLE)
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data
    return { palette: paletteFromPixels(data), luminance: meanLuminance(data) }
  } catch (err) {
    console.warn('[cover-palette] failed for', url, err)
    return null
  } finally {
    bitmap?.close()
  }
}

// Cached per URL; concurrent calls share one request.
export function analyzeCover(url: string): Promise<CoverAnalysis | null> {
  if (!url) return Promise.resolve(null)
  const hit = cache.get(url)
  if (hit) return Promise.resolve(hit)
  const pending = inflight.get(url)
  if (pending) return pending
  const p = compute(url).then((result) => {
    inflight.delete(url)
    if (result) {
      cache.set(url, result)
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    }
    return result
  })
  inflight.set(url, p)
  return p
}
