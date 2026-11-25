import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createClaudeFork, recoverClaudeFork } from '../server/claude-fork.mjs'

test('a Claude fork retains its boundary across restart and subsequent forks', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-fork-test-'))
  const original = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  t.after(async () => {
    if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = original
    await rm(dir, { recursive: true, force: true })
  })
  const cwd = '/project'
  const project = join(dir, 'projects', '-project')
  await mkdir(project, { recursive: true })
  const sourceId = randomUUID()
  async function write(sessionId, parentUuid = null) {
    const uuid = randomUUID()
    await appendFile(join(project, sessionId + '.jsonl'), JSON.stringify({ type:'user', uuid, parentUuid, sessionId })+'\n')
    return uuid
  }
  const first = await write(sourceId)
  const recipe = await createClaudeFork({ cwd, sourceId })
  await write(sourceId, first)
  assert.equal(recipe.messageId, first)
  assert.deepEqual(await recoverClaudeFork({cwd, resumeId:recipe.sessionId, forkRecipe:recipe}), recipe)
  const second = await createClaudeFork({cwd, sourceId:recipe.sessionId, sourceRecipe:recipe})
  assert.equal(second.messageId, first)
  assert.notEqual(second.sessionId, recipe.sessionId)
  await write(recipe.sessionId)
  assert.equal(await recoverClaudeFork({cwd, resumeId:recipe.sessionId, forkRecipe:recipe}), undefined)
})
