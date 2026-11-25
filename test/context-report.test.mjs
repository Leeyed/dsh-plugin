import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createEngineRegistry } from '../registry.mjs'
import { nativeCatalog } from '../server/native-history.mjs'

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'direct-chat-context-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
const catalog = nativeCatalog({ registry: createEngineRegistry() })

test('Codex reads context from the last recorded request and discards rolled-back readings', async t => {
  const directory = await scratch(t)
  const file = join(directory, 'rollout.jsonl')
  const event = (type, fields) => ({ type: 'event_msg', payload: { type, ...fields } })
  const turn = (turn_id, model, input) => [
    event('task_started', { turn_id }), { type: 'turn_context', payload: { turn_id, model } },
    event('token_count', { info: {
      last_token_usage: { total_tokens: input + 20, input_tokens: input, output_tokens: 20, cached_input_tokens: 75,
        cache_write_input_tokens: 4, reasoning_output_tokens: 7 },
      total_token_usage: { total_tokens: 450 }, model_context_window: 2048,
    } }),
    event('task_complete', { turn_id }),
  ]
  await writeFile(file, jsonl([
    ...turn('kept', 'selected-model', 110), ...turn('reverted', 'other-model', 180),
    event('thread_rolled_back', { num_turns: 1 }), event('token_count', { info: null }),
  ]))
  assert.deepEqual(await catalog.context({ engine: 'codex', file }), {
    source: 'lastRequest', model: 'selected-model', used: 130, size: 2048,
    requestTokens: { input: 110, output: 20, cacheRead: 75, cacheWrite: 4, reasoning: 7 },
  })
})

test('Claude includes cached and thinking tokens from the active branch only', async t => {
  const directory = await scratch(t)
  const remoteId = randomUUID()
  const file = join(directory, remoteId + '.jsonl')
  const row = (type, uuid, parentUuid, fields = {}) => ({ type, uuid, parentUuid, sessionId: remoteId, ...fields })
  await writeFile(file, jsonl([
    row('user', 'prompt', null),
    row('assistant', 'unrelated-branch', 'prompt', { message: { model: 'other-model', usage: { input_tokens: 2000 } } }),
    row('assistant', 'active', 'prompt', { message: { model: 'selected-model', usage: {
      input_tokens: 7, output_tokens: 11, cache_creation_input_tokens: 2, cache_read_input_tokens: 30,
      output_tokens_details: { thinking_tokens: 8 },
    } } }),
    row('assistant', 'sidechain', 'active', { isSidechain: true, message: { model: 'agent-model', usage: { input_tokens: 500 } } }),
  ]))
  assert.deepEqual(await catalog.context({ engine: 'claude', remoteId, file }), {
    source: 'lastRequest', model: 'selected-model', used: 50, size: undefined,
    requestTokens: { input: 39, output: 11, cacheRead: 30, cacheWrite: 2, reasoning: 8 },
  })
})

const varint = value => value < 128 ? [value] : [(value & 127) | 128, ...varint(value >>> 7)]
const number = (field, value) => Buffer.from([...varint(field * 8), ...varint(value)])
const bytes = (field, value) => Buffer.concat([Buffer.from([...varint(field * 8 + 2), ...varint(value.length)]), Buffer.from(value)])

test('Antigravity reads model, window and native classification from the indexed conversation database', async t => {
  const directory = await scratch(t)
  const remoteId = randomUUID()
  await mkdir(join(directory, 'conversations'))
  const db = new DatabaseSync(join(directory, 'conversations', remoteId + '.db'))
  db.exec('CREATE TABLE gen_metadata (idx INTEGER, data BLOB)')
  const classification = Buffer.concat([bytes(1, 'System Prompt'), number(4, 30)])
  const context = Buffer.concat([number(1, 90), bytes(3, bytes(1, classification)), number(4, 4096)])
  const generation = bytes(1, Buffer.concat([bytes(9, bytes(10, context)), bytes(19, 'native-model')]))
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, generation)
  db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(2, bytes(1, bytes(19, 'no-reading-model')))
  db.close()
  const entry = { engine: 'agy', remoteId, file: join(directory, 'conversation_summaries.db') }
  assert.deepEqual(await catalog.context(entry), {
    source: 'native', model: 'native-model', used: 90, size: 4096, estimated: true,
    categories: [{ name: 'System Prompt', tokens: 30 }],
  })
  assert.equal(await catalog.context({ ...entry, remoteId: randomUUID() }), undefined)
})
