import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountRemainingPercent, modelAccountWindow, accountLimitGroups, sessionStatus, transcriptCounts, turnTokenUsage } from './session-status.mjs'

test('derives turn and context readings from available CLI measurements', () => {
  const status = sessionStatus({ inputTokens: 75, outputTokens: 5, cacheReadTokens: 15, cacheWriteTokens: 10,
    turnMs: 500, tps: 10 }, { used: 120, size: 1000 }, 'claude')
  assert.equal(status.total, 80)
  assert.equal(status.uncachedInput, 50)
  assert.equal(status.cacheHit, 0.2)
  assert.equal(status.turnMs, 500)
  assert.equal(status.tps, 10)
  assert.equal(status.reasoning, undefined)
  assert.deepEqual(status.context, { used: 120, size: 1000, percent: 12, estimated: false })
})

test('keeps partial usage and rejects unsupported ratios or invalid values', () => {
  const legacy = sessionStatus({ outputTokens: 0, cacheReadTokens: 0, tps: 0 }, { used: 0, size: 512 })
  assert.equal(legacy.output, 0)
  assert.equal(legacy.tps, 0)
  assert.equal(legacy.total, undefined)
  assert.equal(legacy.cacheHit, undefined)
  assert.deepEqual(legacy.context, { used: 0, size: 512, percent: 0, estimated: false })
  const malformed = sessionStatus({ inputTokens: 10, cacheReadTokens: 11, outputTokens: -1, tps: Infinity }, { used: 0, size: 0 })
  assert.equal(malformed.cacheHit, undefined)
  assert.equal(malformed.output, undefined)
  assert.equal(malformed.tps, undefined)
  assert.equal(malformed.uncachedInput, undefined)
  assert.deepEqual(malformed.context, { used: 0, size: undefined, percent: undefined, estimated: false })
})

test('historical context keeps either metric, prefers independently reported live values, and clamps the ring', () => {
  assert.deepEqual(sessionStatus({ contextUsed: 123 }).context,
    { used: 123, size: undefined, percent: undefined, estimated: false })
  assert.deepEqual(sessionStatus({ contextSize: 512 }).context,
    { used: undefined, size: 512, percent: undefined, estimated: false })
  assert.deepEqual(sessionStatus({ contextUsed: 120, contextSize: 100, contextEstimated: true }, { size: 100 }).context,
    { used: 120, size: 100, percent: 100, estimated: true })
  assert.deepEqual(sessionStatus({ contextUsed: 120, contextSize: 100, contextEstimated: true }, { used: 81 }).context,
    { used: 81, size: 100, percent: 81, estimated: false })
  assert.equal(sessionStatus({ contextUsed: -1, contextSize: 0 }).context, undefined)
})

test('reasoning is an output subset and Codex cache reads can resolve uncached input', () => {
  const metrics = { inputTokens: 100, cacheReadTokens: 80, outputTokens: 30, reasoningTokens: 19 }
  assert.equal(sessionStatus(metrics, undefined, 'codex').uncachedInput, 20)
  assert.equal(sessionStatus(metrics, undefined, 'codex').reasoning, 19)
  assert.equal(sessionStatus(metrics, undefined, 'codex').total, 130)
  assert.equal(sessionStatus(metrics, undefined, 'agy').reasoning, 19)
  assert.equal(sessionStatus(metrics, undefined, 'agy').uncachedInput, undefined)
  assert.equal(sessionStatus({ ...metrics, reasoningTokens: 31 }).reasoning, undefined)
})

test('maps reported CLI buckets to the native turn panel without adding reasoning to the total', () => {
  const metrics = { inputTokens: 100, outputTokens: 30, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5 }
  assert.deepEqual(turnTokenUsage(sessionStatus(metrics, undefined, 'claude')), {
    uncachedInputTokens: 30,
    outputTokens: 30,
    totalTokens: 130,
    cacheReadTokens: 60,
    cacheWriteTokens: 10,
    reasoningTokens: 5,
  })
  const { cacheWriteTokens, ...noCacheWrite } = metrics
  assert.deepEqual(turnTokenUsage(sessionStatus(noCacheWrite, undefined, 'codex')), {
    uncachedInputTokens: 40,
    outputTokens: 30,
    totalTokens: 130,
    cacheReadTokens: 60,
    cacheWriteTokens: undefined,
    reasoningTokens: 5,
  })
  assert.equal(turnTokenUsage(sessionStatus(noCacheWrite, undefined, 'agy')), undefined)
  assert.equal(turnTokenUsage(sessionStatus({ inputTokens: 100, outputTokens: 30 }, undefined, 'claude')), undefined)
  assert.equal(turnTokenUsage(sessionStatus({ outputTokens: 30 }, undefined, 'codex')), undefined)
})

test('account quota keeps all time windows together by pool ID and separates same-name pools', () => {
  const pool = { poolId: 'main', poolLabel: 'Provider' }
  const limits = [
    { ...pool, label: 'Provider 5h', windowLabel: '5h', usedPercent: 0 },
    { ...pool, label: 'Provider 7d', windowLabel: '7d', usedPercent: 85 },
    { ...pool, label: 'Provider 30d', windowLabel: '30d', usedPercent: 95 },
    { poolId: 'separate', poolLabel: 'Provider', label: 'Provider 7d', windowLabel: '7d', usedPercent: 70 },
    { poolId: 'model', poolLabel: 'Model quota', label: 'Model quota 7d', windowLabel: '7d', usedPercent: 25 },
    { label: 'Legacy quota', usedPercent: 40 },
  ]
  assert.deepEqual(accountLimitGroups(limits), [
    { key: 'pool:main', name: 'Provider', windows: limits.slice(0, 3) },
    { key: 'pool:separate', name: 'Provider', windows: [limits[3]] },
    { key: 'pool:model', name: 'Model quota', windows: [limits[4]] },
    { key: 'row:5', name: 'Legacy quota', windows: [limits[5]] },
  ])
})

test('counts transcript activity separately from replies without counting tool-only messages as answers', () => {
  assert.deepEqual(transcriptCounts([
    {role:'user',text:'Question'}, {role:'assistant',text:'Checking',phase:'commentary',tools:[{}]},
    {role:'assistant',text:'',tools:[{},{}]}, {role:'assistant',text:'Answer'},
  ]), {turns:1,replies:1,commentary:1,tools:3})
})

test('status bar selects quota for the chosen model and leaves unrelated pools in the panel', () => {
  const row=(id,name,used,windowLabel='weekly')=>({poolId:id,poolLabel:name,usedPercent:used,windowLabel})
  const limits=[row('0','Gemini Models',8.4),row('0','Gemini Models',0,'5h'),
    row('1','Claude and GPT models',0),row('2','Gemini 4 Argon',49.1)]
  const remaining=model=>modelAccountWindow('agy',model,undefined,limits)?.remaining
  assert.equal(remaining('gemini-4-hydrogen'),91.6)
  assert.equal(remaining('gemini-4-argon'),50.9)
  assert.equal(remaining('claude-opus-5-5'),100)
  assert.equal(remaining('gemini-pro-orchestrator-g1-pro'),undefined)
  assert.equal(remaining('auto'),undefined)
  assert.equal(remaining(undefined),undefined)
  const cc=[row('subscription','Claude',13),row('model:Opus','Opus',95),row('model:Sonnet','Sonnet',21)]
  assert.equal(modelAccountWindow('claude','claude-sonnet-5-5',undefined,cc).remaining,79)
  assert.equal(modelAccountWindow('claude','haiku',undefined,cc).remaining,87)
  assert.equal(modelAccountWindow('codex','gpt-x',undefined,[row('codex','Codex',80)]),undefined)
  assert.equal(modelAccountWindow('codex','gpt-x',undefined,[row('gpt-x','Model quota',5)]).remaining,95)
})

test('remaining quota preserves unknown values and handles full and exhausted windows', () => {
  assert.equal(accountRemainingPercent(8.4),91.6)
  assert.equal(accountRemainingPercent(0),100)
  assert.equal(accountRemainingPercent(100),0)
  assert.equal(accountRemainingPercent(105),0)
  assert.equal(accountRemainingPercent(undefined),undefined)
})
