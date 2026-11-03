/**
 * Finding an external command without letting the working directory choose it.
 *
 * On Windows, CreateProcess — which is what `spawn`/`execFile` use for a bare
 * name — searches the current directory before `PATH`. So an `aws.exe` or
 * `session-manager-plugin.exe` dropped in the folder a portable build was
 * launched from would run instead of the real one. Resolving the name against
 * `PATH` ourselves, and handing on an absolute path, takes the current
 * directory out of the search.
 *
 * A name that is already a path (it has a separator) is the user's explicit
 * choice and is left alone. Every other platform resolves a bare name through
 * `execvp`, which does not look in the current directory, so nothing changes
 * there. When the name is not found on `PATH`, it is returned unchanged so the
 * caller fails the same way it always did — "the AWS CLI was not found" — rather
 * than from a surprise.
 */
import fs from 'node:fs'
import path from 'node:path'

export function resolveCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform !== 'win32') return command
  if (/[\\/]/.test(command)) return command

  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  // '' first, so a name given with its own extension is taken as it is.
  const candidates = ['', ...extensions]
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of candidates) {
      const full = path.join(dir, command + extension)
      try {
        if (fs.statSync(full).isFile()) return full
      } catch {
        /* not here; keep looking */
      }
    }
  }
  return command
}
