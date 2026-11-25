import { metricCount, totalInput } from './persisted-metrics.mjs'

export function claudeInput(usage) {
  return totalInput(usage?.input_tokens, usage?.cache_read_input_tokens ?? 0, usage?.cache_creation_input_tokens ?? 0)
}

export function claudeContextUsed(usage) {
  const used = totalInput(claudeInput(usage), usage?.output_tokens)
  return metricCount(used) ? used : undefined
}

export function claudeRequestContext(message, size) {
  const usage = message?.usage
  const used = claudeContextUsed(usage)
  const requestTokens = Object.fromEntries(Object.entries({
    input: claudeInput(usage), output: usage?.output_tokens,
    cacheRead: usage?.cache_read_input_tokens, cacheWrite: usage?.cache_creation_input_tokens,
    reasoning: usage?.output_tokens_details?.thinking_tokens,
  }).filter(([, tokens]) => metricCount(tokens)))
  if (used === undefined && !Object.keys(requestTokens).length && size === undefined) return
  return { source: 'lastRequest', model: message?.model, used, size, requestTokens }
}

export function claudeContextSize(modelUsage, model) {
  const entries = Object.entries(modelUsage ?? {})
  const byModel = entries.find(([id]) => id === model)?.[1]
  const canonical = model && entries.filter(([, usage]) => usage?.canonicalModel === model)
  const matched = byModel ?? (canonical?.length === 1 ? canonical[0][1] : undefined)
  const size = (matched ?? (!model && entries.length === 1 ? entries[0][1] : undefined))?.contextWindow
  return metricCount(size) && size > 0 ? size : undefined
}
