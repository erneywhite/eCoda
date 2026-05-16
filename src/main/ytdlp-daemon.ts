import { spawn, ChildProcess } from 'node:child_process'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'

// Pending-count tracking is exposed so a pool can pick the freest
// daemon. Used by YtdlpDaemonPool below.

// Persistent yt-dlp worker. One Python process is spawned at startup
// and reused for every resolve call. See resources/yt-dlp-daemon.py
// for the wire protocol.
//
// Why this exists: each new `python3 yt-dlp` spawn pays ~1.5-2s of
// Python interpreter + yt-dlp extractor (1864 of them) import overhead
// before any network call. Keeping a single worker alive amortises that
// cost over the lifetime of the app, dropping per-click resolve from
// ~7s to ~5s, and from ~5s to ~3s on second-and-later calls (the first
// resolve through a given (browser, deno) combo still pays a one-time
// YoutubeDL-instance build cost ~2s; subsequent resolves through the
// same combo are pure network).

export interface DaemonResolveResult {
  title: string
  ext: string
  url: string
}

interface PendingRequest {
  resolve: (value: DaemonResolveResult) => void
  reject: (err: Error) => void
}

interface DaemonResponse {
  id: number
  ok: boolean
  title?: string
  ext?: string
  url?: string
  error?: string
}

export class YtdlpDaemon {
  private proc: ChildProcess | null = null
  private stdoutReader: ReadlineInterface | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stopped = false

  constructor(
    private readonly pythonPath: string,
    private readonly daemonScriptPath: string,
    private readonly zipappPath: string,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  start(): void {
    if (this.proc) return
    this.stopped = false
    const proc = spawn(this.pythonPath, [this.daemonScriptPath, this.zipappPath], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc

    this.stdoutReader = createInterface({ input: proc.stdout! })
    this.stdoutReader.on('line', (line) => this.onLine(line))

    proc.stderr?.on('data', (chunk: Buffer) => {
      // Daemon writes diagnostic info to stderr. Forward to the main
      // log so it ends up in <userData>/main.log via logger.ts.
      const text = chunk.toString('utf8').trimEnd()
      if (text) console.warn(`[yt-dlp-daemon] ${text}`)
    })

    proc.on('exit', (code, signal) => {
      console.warn(`[yt-dlp-daemon] exited code=${code} signal=${signal}`)
      this.proc = null
      this.stdoutReader = null
      // Reject all pending requests so callers don't hang.
      for (const [id, req] of this.pending) {
        req.reject(new Error(`yt-dlp daemon exited before responding (id=${id})`))
      }
      this.pending.clear()
      // Auto-restart unless the app is shutting down. Crashed daemons
      // are typically recovery-by-restart (yt-dlp picks up new YT
      // extractor changes too).
      if (!this.stopped) {
        setTimeout(() => {
          if (!this.stopped) this.start()
        }, 500)
      }
    })
  }

  stop(): void {
    this.stopped = true
    if (!this.proc) return
    try {
      this.proc.stdin?.write(JSON.stringify({ id: this.nextId++, cmd: 'exit' }) + '\n')
      this.proc.stdin?.end()
    } catch {
      // Worker may already be dead — fall through to kill.
    }
    setTimeout(() => {
      try {
        this.proc?.kill()
      } catch {
        // already gone
      }
    }, 200)
  }

  // Issues a resolve request. Returns title/ext/url for the bestaudio
  // format. Rejects if the daemon errors out or if the process exits
  // before answering this request.
  pendingCount(): number {
    return this.pending.size
  }

  resolve(videoId: string, browser: string, denoPath: string): Promise<DaemonResolveResult> {
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed) {
      // Lazily start if first call lands before explicit start().
      this.start()
    }
    const id = this.nextId++
    return new Promise<DaemonResolveResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const payload = { id, cmd: 'resolve', videoId, browser, denoPath }
      try {
        this.proc!.stdin!.write(JSON.stringify(payload) + '\n')
      } catch (err) {
        this.pending.delete(id)
        reject(err as Error)
      }
    })
  }

  // Fire-and-forget warmup. Triggers YoutubeDL construction (extractor
  // load + cookies extraction + visitor_data fetch) for the given
  // (browser, denoPath) combo so the user's first real click pays only
  // the network cost (~3s) rather than the construction cost (~5-7s).
  // We do it by issuing a resolve against a known-public, lightweight
  // video; the result is discarded.
  warmup(browser: string, denoPath: string): void {
    // Rick Astley's "Never Gonna Give You Up" — stable, always available,
    // a sensible canary track.
    this.resolve('dQw4w9WgXcQ', browser, denoPath).catch((err) => {
      console.warn('[yt-dlp-daemon] warmup failed:', err.message)
    })
  }

  private onLine(line: string): void {
    if (!line) return
    let resp: DaemonResponse
    try {
      resp = JSON.parse(line) as DaemonResponse
    } catch (err) {
      console.warn('[yt-dlp-daemon] unparseable stdout line:', line.slice(0, 200))
      return
    }
    const req = this.pending.get(resp.id)
    if (!req) {
      console.warn(`[yt-dlp-daemon] response for unknown id=${resp.id}`)
      return
    }
    this.pending.delete(resp.id)
    if (resp.ok) {
      req.resolve({
        title: resp.title ?? '',
        ext: resp.ext ?? '',
        url: resp.url ?? ''
      })
    } else {
      req.reject(new Error(resp.error ?? 'yt-dlp daemon returned ok=false'))
    }
  }
}

// Pool of yt-dlp daemons so a foreground user click doesn't queue behind
// background prefetches. With pool size = 1 we observed 10s clicks when
// a prefetch was already running — the daemon processes requests
// sequentially. With size = 2, a user click can land on the idle
// daemon while a prefetch occupies the other.
//
// Trade-off: each daemon holds a separate yt-dlp YoutubeDL instance
// (~70 MB of resident Python + extractor state). Two daemons is enough
// for the music-app traffic pattern (one foreground stream + one
// prefetch lane); growing beyond that mostly burns memory.
export class YtdlpDaemonPool {
  private daemons: YtdlpDaemon[] = []

  constructor(
    private readonly size: number,
    private readonly factory: () => YtdlpDaemon
  ) {}

  start(): void {
    if (this.daemons.length > 0) return
    for (let i = 0; i < this.size; i++) {
      const d = this.factory()
      d.start()
      this.daemons.push(d)
    }
  }

  stop(): void {
    for (const d of this.daemons) d.stop()
    this.daemons = []
  }

  resolve(videoId: string, browser: string, denoPath: string): Promise<DaemonResolveResult> {
    if (this.daemons.length === 0) this.start()
    return this.pickFreest().resolve(videoId, browser, denoPath)
  }

  private pickFreest(): YtdlpDaemon {
    let best = this.daemons[0]
    for (const d of this.daemons) {
      if (d.pendingCount() < best.pendingCount()) best = d
    }
    return best
  }
}
