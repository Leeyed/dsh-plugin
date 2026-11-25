import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { engine } from '../engines/agy.mjs'

function varint(value) {
  const bytes = []
  while (value >= 128) {
    bytes.push((value % 128) + 128)
    value = Math.floor(value / 128)
  }
  return Buffer.from([...bytes, value])
}

function message(fields) {
  return Buffer.concat(Object.entries(fields).flatMap(([field, value]) => Buffer.isBuffer(value)
    ? [varint(Number(field) * 8 + 2), varint(value.length), value]
    : [varint(Number(field) * 8), varint(value)]))
}

test('AGY reads the matching native context estimate and each completed planner request breakdown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agy-metrics-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const remoteId = randomUUID()
  const file = join(directory, 'conversation_summaries.db')
  const transcript = join(directory, 'brain', remoteId, '.system_generated', 'logs', 'transcript.jsonl')
  const dbFile = join(directory, 'conversations', remoteId + '.db')
  await mkdir(dirname(transcript), { recursive: true })
  await mkdir(dirname(dbFile))
  const rows = [
    { step_index: 0, type: 'USER_INPUT', source: 'USER_EXPLICIT' },
    { step_index: 1, type: 'PLANNER_RESPONSE', source: 'MODEL', tool_calls: ['tool'], input_tokens: 12, cache_read_tokens: 1, output_tokens: 20 },
    { step_index: 2, type: 'GENERIC', source: 'MODEL' },
    { step_index: 3, type: 'PLANNER_RESPONSE', source: 'MODEL', content: 'Reply', input_tokens: 25, cache_read_tokens: 1, output_tokens: 35 },
  ]
  await writeFile(transcript, rows.map(row => JSON.stringify({ status: 'DONE', ...row })).join('\n') + '\n')

  const db = new DatabaseSync(dbFile)
  t.after(() => db.close())
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB); CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)')
  const addStep = db.prepare('INSERT INTO steps VALUES (?, ?)')
  addStep.run(1, message({ 9: message({ 2: 12, 3: 20, 4: 7, 5: 1, 9: 5, 10: 15 }) }))
  addStep.run(3, message({ 9: message({ 2: 25, 3: 35, 5: 1, 10: 35 }) }))
  const addContext = db.prepare('INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)')
  const stored = (steps, context) => message({ 1: message({ 9: message({ 10: message(context) }) }), 2: Buffer.from(steps) })
  addContext.run(0, stored([1, 2], { 1: 2000, 4: 100000 }))
  addContext.run(1, stored([3], { 1: 3500, 4: 100000 }))
  addContext.run(2, stored([4], { 1: 9000, 4: 200000 }))
  const metrics = () => engine.history.metrics({ file, remoteId })
  const counts = { inputTokens: 46, outputTokens: 55, cacheReadTokens: 2, cacheWriteTokens: 7, reasoningTokens: 5 }
  assert.deepEqual(await metrics(), { ...counts, contextUsed: 3500, contextSize: 100000, contextEstimated: true })
  addContext.run(1, stored([3], { 4: 100000 }))
  assert.deepEqual(await metrics(), { ...counts, contextSize: 100000 })
})
