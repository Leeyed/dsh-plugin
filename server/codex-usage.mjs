import { metricCount } from './persisted-metrics.mjs'

function period(minutes, fallback) {
  if (!Number.isSafeInteger(minutes) || minutes < 1) return fallback
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes} min`
}

export function codexRateLimits(reply) {
  const buckets = Object.entries(reply?.rateLimitsByLimitId ?? {})
  const defaultId = reply?.rateLimits?.limitId ?? 'codex'
  const limits = (buckets.length ? buckets : [[defaultId, reply?.rateLimits]]).flatMap(([id, item]) => {
    const name = typeof item?.limitName === 'string' ? item.limitName.trim().slice(0, 100) : ''
    const poolId = typeof id === 'string' && id ? id : 'codex'
    const poolLabel = name || (poolId === 'codex' ? 'Codex' : poolId.slice(0, 100))
    return [['Primary', item?.primary], ['Secondary', item?.secondary]].flatMap(([window, data]) => {
      if (!data || typeof data !== 'object') return []
      const usedPercent = Number.isFinite(data.usedPercent) && data.usedPercent >= 0 ? data.usedPercent : undefined
      const resetsAt = datasetReset(data.resetsAt)
      if (usedPercent === undefined && resetsAt === undefined) return []
      const windowLabel = period(data.windowDurationMins, window)
      return [{ label: `${poolLabel} ${windowLabel}`, poolId, poolLabel, windowLabel, usedPercent, resetsAt }]
    })
  })
  return { limits, status: limits.length ? 'available' : 'unavailable' }
}

function datasetReset(seconds) {
  const time = seconds * 1000
  return typeof seconds === 'number' && Number.isSafeInteger(time) && time > 0 ? time : undefined
}
export function codexRequestContext(info, model) {
  if (!info) return
  const last = info.last ?? info.last_token_usage
  const used = last?.totalTokens ?? last?.total_tokens
  const size = info.modelContextWindow ?? info.model_context_window
  const total = info.total ?? info.total_token_usage
  if (metricCount(size) && size > 0 && (total?.totalTokens ?? total?.total_tokens) === size &&
      (total?.inputTokens ?? total?.input_tokens) === 0 && (total?.outputTokens ?? total?.output_tokens) === 0) {
    // The CLI fills the context window synthetically on overflow.
    return { model, used: size, size }
  }
  const requestTokens = Object.fromEntries(Object.entries({
    input: last?.inputTokens ?? last?.input_tokens,
    output: last?.outputTokens ?? last?.output_tokens,
    cacheRead: last?.cachedInputTokens ?? last?.cached_input_tokens,
    cacheWrite: last?.cacheWriteInputTokens ?? last?.cache_write_input_tokens,
    reasoning: last?.reasoningOutputTokens ?? last?.reasoning_output_tokens,
  }).filter(([, tokens]) => metricCount(tokens)))
  if (!metricCount(used) && !(metricCount(size) && size > 0) && !Object.keys(requestTokens).length) return
  return { source: 'lastRequest', model, used: metricCount(used) ? used : undefined,
    size: metricCount(size) && size > 0 ? size : undefined, requestTokens }
}

