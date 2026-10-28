/**
 * Limits on what a window can ask of the main process.
 *
 * The preload hands every page in a window the same API, so a page that got
 * there other than as the app — a file dropped on the window, a stray link —
 * would have all of it. These keep the window on the app, send only web pages
 * to the browser, and let a window read only the files its own dialogs picked.
 *
 * No Electron here, so the rules can be tested on their own.
 */

/**
 * Whether `target` is the app itself: the page it was loaded from, with any
 * route or query. Everything else, a page next to it included, is not.
 */
export function isAppUrl(target: string, appUrl: string): boolean {
  let next: URL
  let app: URL
  try {
    next = new URL(target)
    app = new URL(appUrl)
  } catch {
    return false
  }
  // A file: URL has no origin to compare, so the protocol and host stand in.
  return (
    next.protocol === app.protocol &&
    next.host === app.host &&
    next.pathname === app.pathname
  )
}

/**
 * Whether a link may go to the browser. Only https: the OS runs a program
 * for a file:, an smb: or a scheme some app registered as readily as it opens
 * a page, and nothing the app links to is anything but a web page.
 */
export function isWebPage(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Files a window has picked in an open dialog and not yet read.
 *
 * Reading a file is something the user asked for by picking it, so a path
 * that did not come out of the window's own dialog is not one it may read —
 * the path is the renderer's to send, and could be anything.
 */
export class GrantedFiles {
  private readonly byOwner = new Map<number, Set<string>>()

  grant(owner: number, filePath: string): void {
    const paths = this.byOwner.get(owner) ?? new Set<string>()
    paths.add(filePath)
    this.byOwner.set(owner, paths)
  }

  /** True once for each grant: a file is read the once it was picked for. */
  take(owner: number, filePath: string): boolean {
    const paths = this.byOwner.get(owner)
    if (!paths?.delete(filePath)) return false
    if (paths.size === 0) this.byOwner.delete(owner)
    return true
  }

  forget(owner: number): void {
    this.byOwner.delete(owner)
  }
}
