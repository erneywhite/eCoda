import { resolveAudio, type ResolvedAudio } from './ytdlp'
import { extractStreamUrlViaPage } from './metadata'

// Resolves audio stream URLs with a three-layer strategy:
//   1. Per-track cache so a re-click is instant.
//   2. Fast path: page-proxy /player call (~200-400ms, returns direct
//      URL for logged-in Premium accounts).
//   3. yt-dlp fallback (~4-5s) when the fast path doesn't return a URL
//      we can use as-is (only signatureCipher, no streamingData, etc.).
//
// URLs expire after ~6h; we use a conservative TTL of a few minutes so
// the cache can never go stale within a session.

interface CacheEntry {
  result: ResolvedAudio
  resolvedAt: number
}

const CACHE_TTL_MS = 4 * 60 * 1000
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ResolvedAudio>>()

let prefetchQueue: { videoId: string; browser: string }[] = []
let prefetchWorking = false

function fresh(entry: CacheEntry | undefined): boolean {
  return !!entry && Date.now() - entry.resolvedAt < CACHE_TTL_MS
}

// Resolves a track, hitting the cache when fresh and deduplicating
// concurrent calls for the same id so a double-click doesn't fork yt-dlp.
export async function resolveCached(videoId: string, browser: string): Promise<ResolvedAudio> {
  const hit = cache.get(videoId)
  if (fresh(hit)) {
    console.log(`[resolver] cache hit ${videoId}`)
    return hit!.result
  }
  const inFlight = inflight.get(videoId)
  if (inFlight) {
    console.log(`[resolver] join inflight ${videoId}`)
    return inFlight
  }

  const t0 = Date.now()
  const promise = (async () => {
    // Try the page-proxy fast path first.
    try {
      const fast = await extractStreamUrlViaPage(videoId)
      if (fast) {
        cache.set(videoId, { result: fast, resolvedAt: Date.now() })
        console.log(
          `[resolver] FAST ${videoId} in ${Date.now() - t0}ms (${fast.format})`
        )
        return fast
      }
      console.log(`[resolver] fast path returned null for ${videoId}, falling back to yt-dlp`)
    } catch (err) {
      console.warn(`[resolver] fast path threw for ${videoId}:`, err)
    }
    // Fallback: yt-dlp.
    const result = await resolveAudio(videoId, browser)
    cache.set(videoId, { result, resolvedAt: Date.now() })
    console.log(`[resolver] yt-dlp ${videoId} in ${Date.now() - t0}ms`)
    return result
  })().finally(() => {
    inflight.delete(videoId)
  })
  inflight.set(videoId, promise)
  return promise
}

// Schedules background resolution of upcoming tracks. Idempotent: ids
// already cached, already in flight, or already queued are skipped.
export function queuePrefetch(videoIds: string[], browser: string): void {
  for (const id of videoIds) {
    if (!id || !/^[\w-]{11}$/.test(id)) continue
    if (fresh(cache.get(id))) continue
    if (inflight.has(id)) continue
    if (prefetchQueue.some((q) => q.videoId === id)) continue
    prefetchQueue.push({ videoId: id, browser })
  }
  void drainPrefetch()
}

// Serialised background worker — one yt-dlp child at a time so prefetch
// can't pile CPU/network pressure on the foreground click.
async function drainPrefetch(): Promise<void> {
  if (prefetchWorking) return
  prefetchWorking = true
  try {
    while (prefetchQueue.length > 0) {
      const next = prefetchQueue.shift()!
      if (fresh(cache.get(next.videoId)) || inflight.has(next.videoId)) continue
      try {
        console.log(`[resolver] prefetching ${next.videoId}`)
        await resolveCached(next.videoId, next.browser)
      } catch (err) {
        console.warn(`[resolver] prefetch ${next.videoId} failed:`, err)
      }
    }
  } finally {
    prefetchWorking = false
  }
}

// Drops the cache (used when the user disconnects so a different account
// can't accidentally play back a previous account's resolved URLs).
export function clearResolverCache(): void {
  cache.clear()
  inflight.clear()
  prefetchQueue = []
}
