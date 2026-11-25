import { metricCount } from './persisted-metrics.mjs'

const rateWindows = [
  ['five_hour', '5-hour window', 'subscription', 'Claude', '5h'],
  ['seven_day', '7-day window', 'subscription', 'Claude', '7d'],
  ['seven_day_oauth_apps', 'OAuth apps · 7 days', 'oauth-apps', 'OAuth apps', '7d'],
  ['seven_day_opus', 'Opus · 7 days', 'model:Opus', 'Opus', '7d'],
  ['seven_day_sonnet', 'Sonnet · 7 days', 'model:Sonnet', 'Sonnet', '7d'],
]

export function claudeAccountUsage(result) {
  const limits = []
  const rateLimits = result?.rate_limits
  if (result?.rate_limits_available !== true || !rateLimits) return { limits, status: 'unavailable' }
  function add(value, label, poolId, poolLabel, windowLabel) {
    if (!value || limits.some(item => item.poolId === poolId && item.windowLabel === windowLabel)) return
    const { utilization } = value
    const limit = { label, poolId, poolLabel, windowLabel }
    if (Number.isFinite(utilization) && utilization >= 0 && utilization <= 100) limit.usedPercent = utilization
    const resetsAt = typeof value.resets_at === 'string' ? Date.parse(value.resets_at) : NaN
    if (Number.isFinite(resetsAt) && resetsAt > 0) limit.resetsAt = resetsAt
    if (limit.usedPercent !== undefined || limit.resetsAt !== undefined) limits.push(limit)
  }
  for (const [key, ...labels] of rateWindows) add(rateLimits[key], ...labels)
  for (const model of Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : []) {
    const name = typeof model?.display_name === 'string' ? model.display_name.trim() : ''
    if (name) add(model, `${name} · 7 days`, `model:${name}`, name, '7d')
  }
  return { limits, status: limits.length ? 'available' : 'unavailable' }
}

export function claudeCachedAccountUsage(config, now = Date.now()) {
  const cached = config?.cachedUsageUtilization
  const accountUuid = config?.oauthAccount?.accountUuid
  const observedAt = cached?.fetchedAtMs
  // Claude Code accepts the saved observation for at most an hour, for its active account only.
  if (typeof accountUuid !== 'string' || !accountUuid || cached?.accountUuid !== accountUuid ||
      !Number.isSafeInteger(observedAt) || observedAt <= 0 || observedAt > now || now - observedAt > 60 * 60_000) return
  const report = claudeAccountUsage({ rate_limits_available: true, rate_limits: cached.utilization })
  const limits = report.limits.filter(limit => limit.resetsAt === undefined || limit.resetsAt > now)
  if (limits.length) return { status: 'available', limits, observedAt }
}

export function claudeContextSummary(result) {
  if (!result) return
  const categories = []
  for (const row of Array.isArray(result.categories) ? result.categories : []) {
    if (row?.kind === 'used' && typeof row.name === 'string' && row.name.trim() && metricCount(row.tokens)) {
      categories.push({ name: row.name, tokens: row.tokens })
    }
  }
  const used = result.totalTokens
  const size = result.rawMaxTokens ?? result.maxTokens
  if (!categories.length && !metricCount(used) && !(metricCount(size) && size > 0)) return
  return { source: 'native', categories, ...(typeof result.model === 'string' && result.model ? { model: result.model } : {}),
    ...(metricCount(used) ? { used } : {}), ...(metricCount(size) && size > 0 ? { size } : {}) }
}
