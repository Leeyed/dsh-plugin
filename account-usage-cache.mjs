export function excludesSubscriptionQuota(engine, provider, env) {
  if (engine === 'codex') return Boolean((provider && provider !== 'openai') || env.OPENAI_API_KEY || env.CODEX_API_KEY || env.CODEX_ACCESS_TOKEN)
  if (engine !== 'claude') return false
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY_FILE_DESCRIPTOR || env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR) ||
    ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(key => /^(?:true|1)$/i.test(env[key]))
}

const freshFor = 30_000
const retryAfter = 30_000

function sanitizeLimits(value) {
  const label = text => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 120) || undefined : undefined
  if (!Array.isArray(value?.limits)) return []
  return value.limits.flatMap(row => {
    const name = label(row?.label)
    const usedPercent = Number.isFinite(row?.usedPercent) && row.usedPercent >= 0 ? row.usedPercent : undefined
    const resetsAt = Number.isSafeInteger(row?.resetsAt) && row.resetsAt > 0 ? row.resetsAt : undefined
    if (!name || (usedPercent === undefined && resetsAt === undefined)) return []
    return [{ label: name, poolId: label(row.poolId), poolLabel: label(row.poolLabel), windowLabel: label(row.windowLabel), usedPercent, resetsAt }]
  })
}

export function createAccountUsageCache(now = Date.now) {
  const entries = new Map()
  return async function read(engine, { cachedOnly, force, readLocal, query }) {
    let entry = entries.get(engine)
    if (!entry) {
      entry = { limits: [], observedAt: null, failedAt: null, checkedLocalAt: null }
      entries.set(engine, entry)
    }
    const store = (value, fromDisk) => {
      const limits = sanitizeLimits(value)
      const time = value?.observedAt
      const stamped = Number.isSafeInteger(time) && time > 0 && time <= now()
      if (!limits.length || (fromDisk && !stamped)) return false
      const observedAt = stamped ? time : now()
      if (fromDisk && entry.observedAt !== null && observedAt <= entry.observedAt) return false
      if (entry.observedAt === null || observedAt >= entry.observedAt) {
        Object.assign(entry, { limits, observedAt, failedAt: null })
      }
      return true
    }
    const snapshot = () => {
      const available = entry.observedAt !== null
      const expiredWindow = entry.limits.some(row => row.resetsAt > entry.observedAt && row.resetsAt <= now())
      return { limits: entry.limits, status: available ? 'available' : 'unavailable',
        observedAt: entry.observedAt, stale: available && (entry.failedAt !== null || now() - entry.observedAt >= freshFor || expiredWindow),
        refreshing: Boolean(entry.pending), refreshFailed: entry.failedAt !== null }
    }
    if (readLocal && !entry.pending && (!entry.limits.length || snapshot().stale)) {
      if (!entry.local && (entry.checkedLocalAt === null || now() - entry.checkedLocalAt >= retryAfter)) {
        entry.checkedLocalAt = now()
        entry.local = Promise.resolve().then(readLocal).then(value => store(value, true)).catch(() => {}).finally(() => { entry.local = null })
      }
      if (entry.local) await entry.local
    }
    const current = snapshot()
    if (cachedOnly) return current
    if (!force && ((current.status === 'available' && !current.stale) ||
        (entry.failedAt !== null && now() - entry.failedAt < retryAfter))) return current
    if (!entry.pending) {
      entry.pending = Promise.resolve().then(query).then(value => {
        entry.failedAt = store(value, false) ? null : now()
      }).catch(() => { entry.failedAt = now() }).finally(() => { entry.pending = null })
    }
    if (force || !entry.limits.length) await entry.pending
    return snapshot()
  }
}
