/**
 * Stopping an AWS CLI child together with whatever it started.
 *
 * The CLI starts children of its own — `session-manager-plugin` under
 * `ssm start-session`, and on Windows the bundled Python under `aws.exe`. On
 * POSIX a SIGTERM to the CLI is relayed and its children go with it; on
 * Windows there is no such relay, so the whole tree has to be taken down or a
 * grandchild keeps running (and, for a session, keeps holding the local port).
 */
import { ChildProcess, spawn } from 'node:child_process'

export async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.once('exit', () => resolve())
      killer.once('error', () => {
        child.kill('SIGKILL')
        resolve()
      })
    })
    return
  }

  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 3000)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
