import { resolveAudio, type ResolvedAudio } from './ytdlp'

// Resolves audio stream URLs via yt-dlp, with two layers of optimisation:
//   1. Per-track cache so a re-click is instant.
//   2. Background prefetch queue — the renderer hands off "next N tracks"
//      after canplay fires; this module quietly resolves them so the next
//      click is also instant.
//
// yt-dlp returns URLs with a short ~6h expiry; we use a conservative TTL
// of a few minutes so the cache can never go stale within a session.

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
  const promise = resolveAudio(videoId, browser)
    .then((result) => {
      cache.set(videoId, { result, resolvedAt: Date.now() })
      console.log(`[resolver] resolved ${videoId} in ${Date.now() - t0}ms`)
      return result
    })
    .finally(() => {
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
