import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { nativeUuid, transcriptFiles, transcriptLines } from './native-history.mjs'

const chainTypes = new Set(['user', 'assistant', 'system', 'attachment'])

function sessionTranscript(cwd, id, env) {
  const effectiveEnv={...process.env,...env}
  const projects = join(effectiveEnv.CLAUDE_CONFIG_DIR || join(effectiveEnv.HOME || homedir(), '.claude'), 'projects')
  const name = id + '.jsonl'
  const workspaceFolder = cwd.replace(/[^A-Za-z0-9-]/g, '-')
  const local = join(projects, workspaceFolder, name)
  if (existsSync(local)) return local
  const matches = transcriptFiles(projects, 1).filter(file => basename(file) === name)
  if (matches.length === 1) return matches[0]
}

function isChainRow(row, sessionId) {
  return !row.isSidechain && (!row.sessionId || row.sessionId === sessionId) &&
    nativeUuid.test(row.uuid) && Object.hasOwn(row, 'parentUuid') && chainTypes.has(row.type)
}

function assertRecipe(recipe, sessionId) {
  if (!recipe || recipe.sessionId !== sessionId || recipe.sourceId === recipe.sessionId ||
      ![sessionId, recipe.sourceId, recipe.messageId].every(id => typeof id === 'string' && nativeUuid.test(id))) {
    throw new Error('Invalid Claude fork recipe')
  }
}

async function hasMessages(file, sessionId) {
  if (!file) return false
  for await (const row of transcriptLines(file)) {
    if (isChainRow(row, sessionId) && (row.type === 'user' || row.type === 'assistant')) return true
  }
  return false
}

export async function createClaudeFork({ cwd, sourceId, sourceRecipe, env }) {
  if (typeof sourceId !== 'string' || !nativeUuid.test(sourceId)) {
    throw new Error('A native Claude session ID is required')
  }
  if (sourceRecipe !== undefined) assertRecipe(sourceRecipe, sourceId)
  const file = sessionTranscript(cwd,sourceId,env)
  const known = new Set()
  let boundary
  let hasConversation = false
  if (file) {
    for await (const row of transcriptLines(file)) {
      if (isChainRow(row, sourceId)) {
        known.add(row.uuid)
        boundary = row.uuid
        if (row.type === 'user' || row.type === 'assistant') hasConversation = true
      } else if (!row.isSidechain && (!row.sessionId || row.sessionId === sourceId) &&
          row.type === 'last-prompt' && known.has(row.leafUuid)) {
        boundary = row.leafUuid
      }
    }
  }
  // An unstarted native fork has no transcript of its own until its first turn.
  if (!hasConversation) {
    if (!sourceRecipe) throw new Error('Claude could not find a forkable transcript for this session')
    return { sourceId: sourceRecipe.sourceId, sessionId: randomUUID(), messageId: sourceRecipe.messageId }
  }
  return { sourceId, sessionId: randomUUID(), messageId: boundary }
}

export async function recoverClaudeFork({ cwd, resumeId, forkRecipe, env }) {
  assertRecipe(forkRecipe, resumeId)
  const file = sessionTranscript(cwd,resumeId,env)
  return await hasMessages(file, resumeId) ? undefined : forkRecipe
}
