import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { nativeUuid, openNativeDatabase } from './native-history.mjs'

export const agyDataDirectory = (home = homedir()) => join(home, '.gemini', 'antigravity-cli')

function linkItem(directory, name, source) {
  const path = join(directory, name)
  const target = join(source, name)
  try {
    symlinkSync(target, path)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target) {
      throw new Error('The Antigravity session directory has an unexpected entry')
    }
  }
}

export function prepareAgySessionDirectory({ historyDirectory, runtimeDirectory, env, resumeId }) {
  const missing = () => Object.assign(new Error('The original Antigravity conversation is unavailable'), { status: 409 })
  if (!nativeUuid.test(resumeId) || !statSync(join(historyDirectory, 'conversations', resumeId + '.db'), {
    throwIfNoEntry: false,
  })?.isFile()) throw missing()

  const history = realpathSync(historyDirectory)
  const index = openNativeDatabase(join(history, 'conversation_summaries.db'))
  if (!index) throw missing()
  try {
    if (!index.prepare('SELECT 1 FROM conversation_summaries WHERE conversation_id = ?').get(resumeId)) throw missing()
  } finally { index.close() }

  const account = agyDataDirectory(env?.HOME)
  mkdirSync(join(account, 'cache'), { recursive: true, mode: 0o700 })
  const credentials = realpathSync(account)
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })

  // AGY writes new native subagents using their own IDs under these directories.
  for (const name of ['conversations', 'brain', 'annotations']) {
    mkdirSync(join(history, name), { mode: 0o700, recursive: true })
    linkItem(runtimeDirectory, name, history)
  }
  // SQLite resolves the link before opening its WAL and shared-memory files.
  linkItem(runtimeDirectory, 'conversation_summaries.db', history)
  // AGY uses the selected account's keyring or refreshes its private file in place.
  linkItem(runtimeDirectory, 'antigravity-oauth-token', credentials)
  linkItem(runtimeDirectory, 'cache', credentials)
  for (const name of ['settings.json', 'mcp']) {
    if (statSync(join(credentials, name), { throwIfNoEntry: false })) linkItem(runtimeDirectory, name, credentials)
  }
  return runtimeDirectory
}
