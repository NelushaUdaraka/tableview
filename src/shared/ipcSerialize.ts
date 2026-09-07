/**
 * Makes renderer values safe to hand to `contextBridge`.
 *
 * Electron copies arguments across the isolated-world boundary with the
 * structured clone algorithm, and that algorithm refuses to clone a Proxy —
 * which is exactly what Vue's reactive state is. The failure happens inside
 * the bridge, before any preload code runs, so the conversion has to happen on
 * the renderer side. Reading through the proxy and rebuilding produces an
 * equivalent plain structure that clones fine.
 */

/** Rebuilds a value out of plain objects and arrays. */
export function toPlain<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value

  if (Array.isArray(value)) {
    return value.map((item) => toPlain(item)) as unknown as T
  }

  // Types that already clone correctly and would be destroyed by rebuilding.
  if (
    value instanceof Date ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Map ||
    value instanceof Set
  ) {
    return value
  }

  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = toPlain((value as Record<string, unknown>)[key])
  }
  return out as T
}
