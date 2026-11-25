const tokenCount = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined
const measurement = value => Number.isFinite(value) && value >= 0 ? value : undefined
const positiveCount = value => tokenCount(value) > 0 ? value : undefined

export function sessionStatus(metrics, usage, engine, capabilities) {
  const input = tokenCount(metrics?.inputTokens)
  const output = tokenCount(metrics?.outputTokens)
  const cacheRead = tokenCount(metrics?.cacheReadTokens)
  const cacheWrite = tokenCount(metrics?.cacheWriteTokens)
  const reasoning = tokenCount(metrics?.reasoningTokens)
  const reportedUsed = tokenCount(usage?.used)
  const used = reportedUsed ?? tokenCount(metrics?.contextUsed)
  const size = positiveCount(usage?.size) ?? positiveCount(metrics?.contextSize)
  const percent = used !== undefined && size !== undefined ? Math.min(100, Math.round(used / size * 100)) : undefined
  const context = used !== undefined || size !== undefined
    ? { used, size, percent, estimated: used !== undefined && reportedUsed === undefined && metrics?.contextEstimated === true }
    : undefined
  const cacheHit = input > 0 && cacheRead <= input ? cacheRead / input : undefined
  const cacheWriteOptional = capabilities?.cacheWriteOptional ?? engine === 'codex'
  const cached = cacheRead + (cacheWrite ?? (cacheWriteOptional ? 0 : undefined))
  return {
    input, output, cacheRead, cacheWrite, context, cacheHit,
    reasoning: reasoning > output ? undefined : reasoning,
    uncachedInput: tokenCount(input - cached),
    turnMs: measurement(metrics?.turnMs),
    tps: measurement(metrics?.tps),
    total: tokenCount(input + output),
  }
}

export function turnTokenUsage(status) {
  if (status.uncachedInput === undefined || status.output === undefined || status.total === undefined) return
  return {
    uncachedInputTokens: status.uncachedInput,
    outputTokens: status.output,
    totalTokens: status.total,
    cacheReadTokens: status.cacheRead,
    cacheWriteTokens: status.cacheWrite,
    reasoningTokens: status.reasoning,
  }
}

export function accountLimitGroups(limits) {
  const groups = []
  const pools = new Map()
  for (const [index, limit] of limits.entries()) {
    let group = pools.get(limit.poolId)
    if (!group) {
      group = {
        key: limit.poolId ? `pool:${limit.poolId}` : `row:${index}`,
        name: limit.poolLabel || limit.label,
        windows: [],
      }
      if (limit.poolId) pools.set(limit.poolId, group)
      groups.push(group)
    }
    group.windows.push(limit)
  }
  return groups
}

export function accountRemainingPercent(used) {
  return Number.isFinite(used) && used >= 0 ? Math.round((100 - Math.min(100, used)) * 10) / 10 : undefined
}

function modelKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : ''
}

export function modelAccountWindows(engine, model, displayName, limits = []) {
  const id = modelKey(model)
  if (!id) return []
  const names = [id, modelKey(displayName)].filter(Boolean)
  const pools = accountLimitGroups(limits)
  const exact = pools.filter(pool => names.includes(modelKey(pool.name)) ||
    (engine === 'codex' && names.includes(modelKey(pool.windows[0]?.poolId))))
  let applicable = exact
  if (engine === 'agy' && !exact.length && !id.includes('orchestrator')) {
    const family = /^gemini /.test(id) ? 'gemini models' :
      /^(claude|gpt) /.test(id) ? 'claude and gpt models' : undefined
    applicable = pools.filter(pool => family && modelKey(pool.name) === family)
  } else if (engine === 'claude') {
    applicable = pools.filter(pool => {
      const poolId = pool.windows[0]?.poolId
      if (poolId === 'subscription') return true
      if (!poolId?.startsWith('model:')) return false
      const key = modelKey(pool.name)
      return exact.includes(pool) || (['opus','sonnet','haiku'].includes(key) && names.some(name => name.split(' ').includes(key)))
    })
  }
  if (engine !== 'claude' && applicable.length !== 1) return []
  const windows = []
  for (const pool of applicable) {
    for (const row of pool.windows) {
      const remaining = accountRemainingPercent(row.usedPercent)
      if (remaining !== undefined) {
        windows.push({ remaining, pool: pool.name, window: row.windowLabel })
      }
    }
  }
  return windows
}

export function modelAccountWindow(engine, model, displayName, limits = []) {
  let tightest
  for (const row of modelAccountWindows(engine, model, displayName, limits)) {
    if (!tightest || row.remaining < tightest.remaining) tightest = row
  }
  return tightest
}

export function transcriptCounts(messages = []) {
  const counts = { turns: 0, replies: 0, commentary: 0, tools: 0 }
  for (const message of messages ?? []) {
    if (message.role === 'user') counts.turns++
    if (message.role !== 'assistant') continue
    if (message.text?.trim()) {
      if (message.phase === 'commentary') counts.commentary++
      else counts.replies++
    }
    counts.tools += message.tools?.length ?? 0
  }
  return counts
}
