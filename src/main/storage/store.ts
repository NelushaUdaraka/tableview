/**
 * A tiny JSON document store with atomic writes.
 *
 * TableView's own app data is small and read whole on startup, so a file per
 * collection keeps the app free of native dependencies — which matters because
 * a native module would have to be rebuilt for every target platform.
 *
 * Writing is "new file, then rename", so a crash mid-write leaves the previous
 * copy intact rather than half of the new one. On Windows that rename is not
 * guaranteed to succeed first time: a virus scanner or the search indexer can
 * hold either file open for a moment, and the rename comes back EPERM. Those
 * locks are transient, so a write retries before it gives up.
 */
import fs from 'node:fs'
import path from 'node:path'

/** Windows reports "someone else has this file open" as one of these. */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** Attempts at the rename, and how long to wait between them. */
const COMMIT_ATTEMPTS = 4
const COMMIT_BACKOFF_MS = 15

/**
 * Distinguishes one write's temp file from another's.
 *
 * A single name per process is not enough: several windows share this process
 * and write the same file, and a temp file left behind by a write that failed
 * would be handed to the next one.
 */
let writeCounter = 0

export class JsonStore<T> {
  private cache: T | null = null
  /**
   * Set while the file is there but held by someone else: what the app is
   * looking at are the defaults, not what the file holds, so nothing may be
   * written over it until a read gets through.
   */
  private unread = false

  constructor(
    private readonly filePath: string,
    private readonly defaults: () => T
  ) {}

  read(): T {
    if (this.cache !== null) return this.cache
    try {
      const raw = readWithRetries(this.filePath)
      this.cache = JSON.parse(raw) as T
      this.unread = false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code && TRANSIENT_CODES.has(code)) {
        // A lock that outlasted the retries is still not a corrupt file. The
        // defaults stand in for now, uncached, so the next read tries again.
        // eslint-disable-next-line no-console
        console.error(`[store] could not read ${this.filePath} for now:`, error)
        this.unread = true
        return this.defaults()
      }
      // Gone, or unreadable for good: either way there is nothing left to keep.
      this.unread = false
      if (code !== 'ENOENT') {
        // Keep a corrupt file rather than silently discarding the user's data.
        try {
          fs.renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`)
        } catch {
          /* nothing more we can do */
        }
        // eslint-disable-next-line no-console
        console.error(`[store] could not read ${this.filePath}:`, error)
      }
      this.cache = this.defaults()
    }
    return this.cache
  }

  write(value: T): void {
    // Writing now would put the defaults, and whatever was added to them, in
    // place of everything the file holds.
    if (this.unread) {
      throw new Error(
        `${path.basename(this.filePath)} could not be read, so it was not written over. Try again in a moment.`
      )
    }
    this.cache = value
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const json = JSON.stringify(value, null, 2)
    writeCounter += 1
    const temp = `${this.filePath}.tmp-${process.pid}-${writeCounter.toString(36)}`
    try {
      fs.writeFileSync(temp, json, { mode: 0o600 })
      this.commit(temp, json)
    } finally {
      // A rename that went through has taken the temp file with it; one that
      // did not must not leave it lying next to the real file.
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        /* nothing more we can do */
      }
    }
  }

  /**
   * Puts a written temp file in place of the real one.
   *
   * Retries while the failure looks like a lock someone else is about to let
   * go of, then falls back to writing over the file directly — which is not
   * atomic, but is the way through when it is the temp file that is held open
   * rather than the destination. Only a rename that fails for a reason no
   * retry can fix, with the direct write failing too, is raised to the caller.
   */
  private commit(temp: string, json: string): void {
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.renameSync(temp, this.filePath)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ''
        if (attempt < COMMIT_ATTEMPTS && TRANSIENT_CODES.has(code)) {
          sleep(COMMIT_BACKOFF_MS * attempt)
          continue
        }
        try {
          fs.writeFileSync(this.filePath, json, { mode: 0o600 })
          return
        } catch {
          // The rename says more about what went wrong than a second failure
          // against a file that was already refusing to be replaced.
          throw error
        }
      }
    }
  }

  update(mutate: (current: T) => T): T {
    const next = mutate(this.read())
    this.write(next)
    return next
  }

  /** Drops the in-memory copy so the next read hits disk. */
  invalidate(): void {
    this.cache = null
  }
}

/** Reads the file, waiting out a lock the way a write's rename does. */
function readWithRetries(filePath: string): string {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return fs.readFileSync(filePath, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (attempt >= COMMIT_ATTEMPTS || !TRANSIENT_CODES.has(code)) throw error
      sleep(COMMIT_BACKOFF_MS * attempt)
    }
  }
}

/**
 * Blocks for a moment.
 *
 * Everything here is synchronous — callers read app data as a value, not as a
 * promise — so waiting out a file lock has to block too. The waits are a few
 * milliseconds and only happen on the retry path.
 */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
