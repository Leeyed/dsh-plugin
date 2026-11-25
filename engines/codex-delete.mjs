import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { nativeUuid } from '../server/native-history.mjs'

const run = promisify(execFile)
const options = { cwd: homedir(), windowsHide: true, maxBuffer: 64 * 1024 }
let probe

export function supportsCodexDelete() {
  probe ??= run('codex', ['delete', '--help'], { ...options, timeout: 5_000 })
    .then(({ stdout }) => /\bdelete\b/i.test(stdout) && /--force\b/.test(stdout), () => false)
  return probe
}

export async function deleteCodexSession({ remoteId, signal }) {
  if (typeof remoteId !== 'string' || !nativeUuid.test(remoteId)) throw new Error('A native Codex session ID is required')
  signal?.throwIfAborted()
  try {
    // A configuration override selects a dedicated app-server and preserves cross-process writer locks.
    await run('codex', ['-c', 'analytics.enabled=false', 'delete', '--force', remoteId], { ...options, signal, timeout: 30_000 })
  } catch (error) {
    signal?.throwIfAborted()
    if (error.killed) throw new Error('Codex session deletion timed out')
    throw new Error('Codex refused to delete this session')
  }
}
