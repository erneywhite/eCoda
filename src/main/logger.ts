import { app } from 'electron'
import { join } from 'node:path'
import { appendFileSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs'

// Tiny file-based logger for the main process. We mirror every
// console.log / warn / error to <userData>/main.log so a packaged
// install — where DevTools are off and the stdout goes nowhere — still
// leaves a paper trail we can read when investigating bugs.
//
// Why home-grown over electron-log: we only need append + rotate, the
// dependency would only land in the main bundle but it still costs a few
// hundred KB and a maintenance touchpoint. The file is small.

const MAX_BYTES = 2 * 1024 * 1024 // 2 MB → rotate
const KEEP_OLD = 1 // main.log + main.log.1

let logPath = ''
let installed = false

function nowIso(): string {
  return new Date().toISOString()
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(logPath)) return
    const size = statSync(logPath).size
    if (size < MAX_BYTES) return
    const oldPath = `${logPath}.1`
    if (existsSync(oldPath)) {
      if (KEEP_OLD <= 1) unlinkSync(oldPath)
    }
    renameSync(logPath, oldPath)
  } catch {
    // Best-effort; never let logging itself crash the app.
  }
}

function format(level: string, args: unknown[]): string {
  const parts: string[] = []
  for (const a of args) {
    if (a instanceof Error) {
      parts.push(a.stack ?? `${a.name}: ${a.message}`)
      continue
    }
    if (typeof a === 'object' && a !== null) {
      try {
        parts.push(JSON.stringify(a))
      } catch {
        parts.push(String(a))
      }
      continue
    }
    parts.push(String(a))
  }
  return `${nowIso()} [${level}] ${parts.join(' ')}\n`
}

function writeLine(level: string, args: unknown[]): void {
  if (!installed) return
  try {
    rotateIfNeeded()
    appendFileSync(logPath, format(level, args), 'utf8')
  } catch {
    // Swallow — logging must not affect the running app.
  }
}

// Wraps console.log / warn / error so existing call sites keep working
// AND end up in the file. We call this once from app.whenReady so
// `app.getPath('userData')` is resolvable.
export function installLogger(): string {
  if (installed) return logPath
  logPath = join(app.getPath('userData'), 'main.log')
  installed = true

  const origLog = console.log
  const origWarn = console.warn
  const origErr = console.error
  console.log = (...args: unknown[]): void => {
    origLog(...args)
    writeLine('LOG', args)
  }
  console.warn = (...args: unknown[]): void => {
    origWarn(...args)
    writeLine('WARN', args)
  }
  console.error = (...args: unknown[]): void => {
    origErr(...args)
    writeLine('ERROR', args)
  }

  // Surface unhandled stuff that would otherwise vanish in packaged mode.
  process.on('uncaughtException', (err) => {
    writeLine('UNCAUGHT', [err])
  })
  process.on('unhandledRejection', (reason) => {
    writeLine('UNHANDLED-REJECTION', [reason])
  })

  console.log(
    `[logger] installed at ${logPath} · electron=${process.versions.electron} node=${process.versions.node} packaged=${app.isPackaged}`
  )
  return logPath
}

export function getLogPath(): string {
  return logPath
}
