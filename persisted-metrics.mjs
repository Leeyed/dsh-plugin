import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createZstdDecompress } from 'node:zlib'

const tailLimit = 2 * 1024 * 1024

async function recentBytes(file) {
  if (!file.endsWith('.zst')) {
    const handle = await open(file, 'r')
    try {
      const { size } = await handle.stat()
      const bytes = Buffer.alloc(Math.min(size, tailLimit))
      const start = size - bytes.length
      const result = await handle.read(bytes, 0, bytes.length, start)
      return { bytes: bytes.subarray(0, result.bytesRead), truncated: start > 0 }
    } finally { await handle.close() }
  }

  const source = createReadStream(file)
  const stream = source.pipe(createZstdDecompress())
  source.on('error', error => stream.destroy(error))
  const chunks = []
  let size = 0
  let truncated = false
  try {
    for await (const chunk of stream) {
      chunks.push(chunk)
      size += chunk.length
      while (size - chunks[0].length >= tailLimit) {
        size -= chunks.shift().length
        truncated = true
      }
    }
    return { bytes: Buffer.concat(chunks, size).subarray(Math.max(0, size - tailLimit)), truncated: truncated || size > tailLimit }
  } finally { source.destroy(); stream.destroy() }
}

export async function recentTranscript(file) {
  const { bytes, truncated } = await recentBytes(file)
  const lines = bytes.toString('utf8').split('\n')
  if (truncated) lines.shift()
  return lines.flatMap(line => {
    try {
      const row = JSON.parse(line)
      return row && typeof row === 'object' ? [row] : []
    } catch { return [] }
  })
}

export function metricCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

export function codexSessionTokens(usage) {
  if (!usage) return
  const { input, output, cacheRead, reasoning, total } = Object.fromEntries(Object.entries({
    input: usage.inputTokens ?? usage.input_tokens,
    output: usage.outputTokens ?? usage.output_tokens,
    cacheRead: usage.cachedInputTokens ?? usage.cached_input_tokens,
    reasoning: usage.reasoningOutputTokens ?? usage.reasoning_output_tokens,
    total: usage.totalTokens ?? usage.total_tokens,
  }).filter(([, count]) => metricCount(count)))
  // Codex can replace its counters with a synthetic full-window total after a context overflow.
  if (input !== undefined && output !== undefined && total !== undefined && total !== input + output) return
  const tokens = Object.fromEntries(Object.entries({
    input, output, total,
    cacheRead: input !== undefined && cacheRead > input ? undefined : cacheRead,
    reasoning: output !== undefined && reasoning > output ? undefined : reasoning,
  }).filter(([, count]) => count !== undefined))
  if (Object.keys(tokens).length) return tokens
}

export function summedUsage(requests, fields) {
  const counts = {}
  if (!requests.length) return counts
  for (const [field, source] of Object.entries(fields)) {
    const values = requests.map(request => typeof source === 'function' ? source(request) : request?.[source])
    if (!values.every(metricCount)) continue
    const sum = values.reduce((total, value) => total + value, 0)
    if (metricCount(sum)) counts[field] = sum
  }
  return counts
}

export function totalInput(...counts) {
  if (counts.every(metricCount)) return counts.reduce((sum, count) => sum + count, 0)
}

export function turnMetrics(counts, turnMs) {
  const metrics = { ...counts }
  if (metricCount(turnMs)) metrics.turnMs = turnMs
  if (metrics.turnMs > 0 && metricCount(metrics.outputTokens)) {
    metrics.tps = Math.round(metrics.outputTokens * 10_000 / metrics.turnMs) / 10
  }
  return Object.keys(metrics).length ? metrics : undefined
}
