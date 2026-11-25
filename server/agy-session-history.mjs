import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { nativeUuid, openNativeDatabase } from './native-history.mjs'

export const agyDataDirectory = (home = homedir()) => join(home, '.gemini', 'antigravity-cli')

function linkItem(directory, name, source) {
  const path = join(directory, name)
  const target = join(source, name)
  const isDir = (() => { try { return statSync(target).isDirectory() } catch { return false } })()
  try {
    symlinkSync(target, path, process.platform === 'win32' && isDir ? 'junction' : undefined)
  } catch (error) {
    if (error.code === 'EEXIST') {
      if (!lstatSync(path).isSymbolicLink() || readlinkSync(path) !== target) {
        throw new Error('The Antigravity session directory has an unexpected entry')
      }
      return
    }
    if (process.platform === 'win32' && !isDir) {
      try { linkSync(target, path); return } catch {}
    }
    throw error
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

function mergeDirectoryMissing(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const src = join(fromDir, entry.name)
    const dst = join(toDir, entry.name)
    if (entry.isDirectory()) {
      mergeDirectoryMissing(src, dst)
    } else if (!existsSync(dst)) {
      try { renameSync(src, dst) } catch {
        try { copyFileSync(src, dst) } catch {}
      }
    }
  }
}

function mergeSummaryDatabase(srcDb, dstDb) {
  if (!existsSync(srcDb)) {
    try {
      renameSync(dstDb, srcDb)
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(dstDb + suffix)) renameSync(dstDb + suffix, srcDb + suffix)
      }
      return true
    } catch { return false }
  }
  const target = new DatabaseSync(srcDb)
  try {
    target.exec('ATTACH DATABASE ' + JSON.stringify(dstDb) + ' AS legacy')
    const hasLegacy = target.prepare("SELECT 1 FROM legacy.sqlite_master WHERE type='table' AND name='conversation_summaries'").get()
    const hasMain = target.prepare("SELECT 1 FROM main.sqlite_master WHERE type='table' AND name='conversation_summaries'").get()
    if (hasLegacy && hasMain) {
      const cols = target.prepare('PRAGMA main.table_info(conversation_summaries)').all().map(c => c.name)
      const legacyCols = new Set(target.prepare('PRAGMA legacy.table_info(conversation_summaries)').all().map(c => c.name))
      const shared = cols.filter(c => legacyCols.has(c))
      if (shared.length) {
        const list = shared.map(c => `"${c}"`).join(', ')
        target.exec(`INSERT OR IGNORE INTO main.conversation_summaries (${list}) SELECT ${list} FROM legacy.conversation_summaries`)
      }
    }
    target.exec('DETACH DATABASE legacy')
    return true
  } catch {
    return false
  } finally {
    target.close()
  }
}

export function migrateAgySharedHistory(nativeAgy, isolatedAgy, linkSharedItem) {
  mkdirSync(isolatedAgy, { recursive: true, mode: 0o700 })
  for (const name of ['conversations', 'brain', 'annotations']) {
    const src = join(nativeAgy, name)
    const dst = join(isolatedAgy, name)
    mkdirSync(src, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dst, { throwIfNoEntry: false })
    if (stat && !stat.isSymbolicLink()) {
      try {
        if (stat.isDirectory()) mergeDirectoryMissing(dst, src)
        rmSync(dst, { recursive: true, force: true })
      } catch {}
    }
    linkSharedItem(src, dst)
  }
  const srcDb = join(nativeAgy, 'conversation_summaries.db')
  const dstDb = join(isolatedAgy, 'conversation_summaries.db')
  const dstStat = lstatSync(dstDb, { throwIfNoEntry: false })
  const srcStat = lstatSync(srcDb, { throwIfNoEntry: false })
  const sameInode = Boolean(dstStat && srcStat && dstStat.ino && dstStat.ino === srcStat.ino)
  if (dstStat && !dstStat.isSymbolicLink() && !sameInode) {
    if (mergeSummaryDatabase(srcDb, dstDb)) {
      for (const suffix of ['', '-wal', '-shm']) {
        try { rmSync(dstDb + suffix, { force: true }) } catch {}
      }
    }
  }
  linkSharedItem(srcDb, dstDb)
}
