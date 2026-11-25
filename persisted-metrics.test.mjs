import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { nativeCatalog } from './native-history.mjs'
import { createEngineRegistry } from './registry.mjs'

const timestamp = '2026-11-20T02:30:45.000Z'
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n'

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'direct-chat-metrics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('Codex uses validated per-turn differences, excluding duplicate snapshots, rollback and unfinished work', async t => {
  const directory = await scratch(t)
  const file = join(directory, 'rollout.jsonl.zst')
  const event = (type, fields) => ({ type: 'event_msg', timestamp, payload: { type, ...fields } })
  const start = turn_id => event('task_started', { turn_id })
  const complete = (turn_id, duration_ms) => event('task_complete', { turn_id, duration_ms })
  const usage = (input, output, cacheRead, cacheWrite) => ({
    input_tokens: input, output_tokens: output, cached_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite,
  })
  const update = (total, last_token_usage) => event('token_count', { info: {
    total_token_usage: { ...total, total_tokens: total.input_tokens + total.output_tokens }, last_token_usage,
  } })
  const baseline = usage(100, 20, 7, 1)
  const initial = update(baseline, baseline)
  const first = update(usage(160, 50, 15, 5), usage(60, 30, 8, 4))
  const second = update(usage(180, 60, 15, 7), usage(20, 10, 0, 2))
  second.payload.info.model_context_window = 300
  second.payload.info.last_token_usage.total_tokens = 30
  const third = update(usage(200, 88, 33, 7), usage(20, 28, 18, 0))
  await writeFile(file, zstdCompressSync(Buffer.from(jsonl([
    { type: 'session_meta', payload: { id: randomUUID() } }, start('first'), initial, complete('first', 4000),
    start('selected'), initial, first, first, second, complete('selected', 2000),
    start('discarded'), third, complete('discarded', 500), event('thread_rolled_back', { num_turns: 1 }),
    start('unfinished'), update(usage(205, 91, 40, 8), usage(5, 3, 7, 1)),
  ]))))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['codex'] }) })
  assert.deepEqual(await catalog.metrics({ engine: 'codex', file }), {
    contextUsed: 30, contextSize: 300, inputTokens: 80, outputTokens: 40, cacheReadTokens: 8, cacheWriteTokens: 6, turnMs: 2000, tps: 20,
    sessionTokens: { input: 205, output: 91, cacheRead: 40, total: 296 },
  })

  // A capped tail with no turn baseline can still supply the native cumulative counts.
  const plain = join(directory, 'rollout.jsonl')
  await writeFile(plain, jsonl([
    { type: 'session_meta', payload: { id: randomUUID() } },
    { type: 'response_item', payload: { content: 'a'.repeat(2 * 1024 * 1024) } },
    start('last'), first, complete('last', 3500),
  ]))
  assert.deepEqual(await catalog.metrics({ engine: 'codex', file: plain }), {
    turnMs: 3500, sessionTokens: { input: 160, output: 50, cacheRead: 15, total: 210 },
  })
})

test('Codex reads native session counts without a completed turn and omits synthetic window totals', async t => {
  const directory = await scratch(t)
  const file = join(directory, 'rollout.jsonl')
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['codex'] }) })
  const metrics = async total_token_usage => {
    await writeFile(file, jsonl([{ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage } } }]))
    return catalog.metrics({ engine: 'codex', file })
  }
  assert.deepEqual(await metrics({ input_tokens: 40, output_tokens: 10, cached_input_tokens: 25,
    reasoning_output_tokens: 7, total_tokens: 50 }), {
    sessionTokens: { input: 40, output: 10, cacheRead: 25, reasoning: 7, total: 50 },
  })
  assert.deepEqual(await metrics({ input_tokens: 40, output_tokens: 10, cached_input_tokens: -1 }), {
    sessionTokens: { input: 40, output: 10 },
  })
  assert.equal(await metrics({ input_tokens: 0, output_tokens: 0, total_tokens: 128000 }), undefined)
})

test('Claude follows the active branch and counts each model response once', async t => {
  const directory = await scratch(t)
  const remoteId = randomUUID()
  const file = join(directory, remoteId + '.jsonl')
  const row = (type, uuid, parentUuid, fields = {}) => ({ type, uuid, parentUuid, sessionId: remoteId, ...fields })
  const usage = (input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens) => ({
    input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
  })
  const assistant = (uuid, parentUuid, id, counts, stop_reason) =>
    row('assistant', uuid, parentUuid, { message: { id, usage: counts, stop_reason } })
  const user = (uuid, parentUuid) => row('user', uuid, parentUuid, { message: { content: 'New prompt' } })
  const first = usage(9, 20, 11, 4)
  await writeFile(file, jsonl([
    user('start', null), assistant('tool-text', 'start', 'request-1', first, 'tool_use'),
    assistant('tool-block', 'tool-text', 'request-1', first, 'tool_use'),
    row('user', 'tool-result', 'tool-block', { message: { content: [{ type: 'tool_result' }] } }),
    assistant('final', 'tool-result', 'request-2', usage(41, 15, 19, 1), 'end_turn'),
    row('system', 'duration', 'final', { subtype: 'turn_duration', durationMs: 5000 }),
    assistant('discarded-branch', 'tool-block', 'request-3', usage(200, 200, 200, 200), 'end_turn'),
    user('unfinished-input', 'duration'), assistant('unfinished-tool', 'unfinished-input', 'request-4', usage(50, 60, 0, 2), 'tool_use'),
    row('assistant', 'agent-finish', 'unfinished-tool', { isSidechain: true, message: { id: 'agent', stop_reason: 'end_turn' } }),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['claude'] }) })
  assert.deepEqual(await catalog.metrics({ engine: 'claude', remoteId, file }), {
    contextUsed: 76, inputTokens: 85, outputTokens: 35, cacheReadTokens: 30, cacheWriteTokens: 5, turnMs: 5000, tps: 7,
  })
})

test('AGY sums planner calls within a completed user turn and omits unrecorded latency', async t => {
  const directory = await scratch(t)
  const remoteId = randomUUID()
  const file = join(directory, 'brain', remoteId, '.system_generated', 'logs', 'transcript.jsonl')
  await mkdir(dirname(file), { recursive: true })
  const row = (type, step_index, source, fields = {}) => ({ type, step_index, source, created_at: timestamp, status: 'DONE', ...fields })
  const user = index => row('USER_INPUT', index, 'USER_EXPLICIT')
  const planner = (index, input_tokens, output_tokens, tool_calls) => row('PLANNER_RESPONSE', index, 'MODEL', {
    input_tokens, output_tokens, cache_read_tokens: 1, ...(tool_calls ? { tool_calls } : { content: 'Terminal answer' }),
  })
  await writeFile(file, jsonl([
    user(0), planner(1, 12, 20, ['tool']), row('GENERIC', 2, 'MODEL'), planner(3, 25, 35),
    row('SYSTEM_MESSAGE', 4, 'SYSTEM'), planner(5, 300, 500), user(6), planner(7, 900, 410, ['another tool']),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['agy'] }) })
  const index = join(directory, 'conversation_summaries.db')
  assert.deepEqual(await catalog.metrics({ engine: 'agy', file: index, remoteId }), {
    inputTokens: 39, outputTokens: 55, cacheReadTokens: 2,
  })
  assert.equal(await catalog.metrics({ engine: 'agy', file: index, remoteId: randomUUID() }), undefined)
})

test('catalog listing does not read usage until a session is opened', async () => {
  let reads = 0
  const registry = createEngineRegistry({ engines: [] })
  registry.register({
    id: 'fixture', label: 'Fixture', start() {},
    history: {
      list: () => [{ remoteId: 'session', cwd: tmpdir() }], messages: () => [],
      metrics: () => { reads++; return { outputTokens: 20 } },
    },
  })
  const catalog = nativeCatalog({ registry })
  const [entry] = (await catalog.list()).values()
  assert.equal(reads, 0)
  assert.deepEqual(await catalog.metrics(entry), { outputTokens: 20 })
  assert.equal(reads, 1)
})
