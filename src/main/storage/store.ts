/**
 * A tiny JSON document store with atomic writes.
 *
 * Beekeeper's own app data is small and read whole on startup, so a file per
 * collection keeps the app free of native dependencies — which matters because
 * a native module would have to be rebuilt for every target platform.
 */
import fs from 'node:fs'
import path from 'node:path'

export class JsonStore<T> {
  private cache: T | null = null

  constructor(
    private readonly filePath: string,
    private readonly defaults: () => T
  ) {}

  read(): T {
    if (this.cache !== null) return this.cache
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      this.cache = JSON.parse(raw) as T
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
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
    this.cache = value
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.tmp-${process.pid}`
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temp, this.filePath)
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
