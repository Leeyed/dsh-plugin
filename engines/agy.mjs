import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startAgy } from '../server/agy.mjs'
import { agyDataDirectory as dataDirectory, prepareAgySessionDirectory } from '../server/agy-session-history.mjs'
import { agyAccountUsage } from '../server/agy-usage.mjs'
import { agyCliAdmin } from './cli-admin.mjs'
import { nativeUuid, openNativeDatabase } from '../server/native-history.mjs'
import { metricCount, recentTranscript, summedUsage, totalInput, turnMetrics } from '../server/persisted-metrics.mjs'
import { agyCommandExecution, agyToolActivity, agyTranscriptCommandResult, completeExecution } from '../server/tool-activity.mjs'
import { agyAnnotations, writeAgyArchive, writeAgyTitle } from './agy-archive.mjs'

const usageFields = {
  inputTokens: usage => totalInput(usage.input_tokens, usage.cache_read_tokens, usage.cache_write_tokens ?? 0),
  outputTokens: 'output_tokens', reasoningTokens: 'thinking_output_tokens',
  cacheReadTokens: 'cache_read_tokens', cacheWriteTokens: 'cache_write_tokens',
}

function workspace(row) {
  try { return fileURLToPath(JSON.parse(row.workspace_uris)[0]) } catch { return undefined }
}

function status(row) {
  if (row.killed) return 'cancelled'
  if (row.not_fully_idle || /RUNNING|BUSY/.test(row.status)) return 'running'
  if (/FAIL|ERROR/.test(row.status)) return 'failed'
  if (/CANCEL|STOP/.test(row.status)) return 'cancelled'
  if (row.status === 'CASCADE_RUN_STATUS_IDLE') return 'idle'
}

function list({ home = homedir(), directory = dataDirectory(home) }) {
  const file = join(directory, 'conversation_summaries.db')
  const db = openNativeDatabase(file)
  if (!db) return []
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(conversation_summaries)').all().map(column => column.name))
    const fields = [
      'conversation_id', 'title', 'agent_name', 'created_at', 'last_modified_time', 'workspace_uris',
      'parent_conversation_id', 'nesting_depth', 'step_count', 'status', 'killed', 'not_fully_idle',
    ].filter(field => columns.has(field))
    if (!fields.length) return []
    const summaries = db.prepare('SELECT ' + fields.join(', ') + ' FROM conversation_summaries').all()
    const byId = new Map(summaries.map(row => [row.conversation_id, row]))
    const parents = new Map()
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_parents'").get()) {
      const links = db.prepare('SELECT conversation_id, parent_id FROM conversation_parents').all()
      for (const row of links) {
        if (!nativeUuid.test(row.parent_id)) continue
        if (!parents.has(row.conversation_id)) parents.set(row.conversation_id, new Set())
        parents.get(row.conversation_id).add(row.parent_id)
      }
    }
    const workspaces = new Map(summaries.map(row => [row.conversation_id, workspace(row)]))
    return summaries.flatMap(row => {
      const remoteId = row.conversation_id
      const nativeParents = [...(parents.get(remoteId) ?? [])]
      const linked = nativeParents.length === 1 ? nativeParents[0]
        : nativeParents.find(parentId => (byId.get(parentId)?.nesting_depth ?? NaN) === row.nesting_depth - 1)
      const nativeParent = nativeUuid.test(row.parent_conversation_id) ? row.parent_conversation_id : linked
      if (!nativeUuid.test(remoteId) || (row.step_count <= 0 && !nativeParent)) return []
      const { archived, title } = agyAnnotations(directory, remoteId)
      return [{
        remoteId, nativeParent, cwd: workspaces.get(remoteId) || workspaces.get(nativeParent),
        title: title || row.title || row.agent_name, createdAt: row.created_at, updatedAt: row.last_modified_time,
        status: status(row), archived, file,
      }]
    })
  } finally { db.close() }
}

function unwrapAgyUserText(text) {
  if (typeof text !== 'string') return ''
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text)
  if (match) return match[1].trim()
  return text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '').trim()
}

function markIntermediateCommentary(rows) {
  return rows.map((msg, i) => {
    if (msg.role === 'assistant' && rows[i + 1]?.role === 'assistant') {
      return { ...msg, phase: 'commentary' }
    }
    return msg
  })
}

function transcriptFileMessages(logFile) {
  if (!existsSync(logFile)) return null
  try {
    const lines = readFileSync(logFile, 'utf8').split('\n')
    const rows = []
    let pendingThought = ''
    let pendingTools = []
    let pendingSteps = []
    let nextToolId = 0
    let toolBatch
    const flushToolResults = () => {
      const batch = toolBatch
      toolBatch = undefined
      if (!batch || batch.tools.length !== batch.results.length ||
          batch.results.some((step, index) => step.step_index !== batch.stepIndex + index + 1)) return
      for (const [index, tool] of batch.tools.entries()) {
        if (tool.kind !== 'execute') continue
        const result = batch.results[index]
        const execution = agyTranscriptCommandResult(result.content)
        if (execution) tool.execution = completeExecution(tool.execution, execution)
        if (result.status === 'ERROR' || execution?.exitCode) tool.status = 'failed'
        else if (result.status === 'RUNNING') tool.status = 'in_progress'
      }
    }
    const flushTo = target => {
      if (!pendingThought && !pendingTools.length && !pendingSteps.length) return
      if (!target) {
        target = { role: 'assistant', text: '' }
        rows.push(target)
      }
      if (pendingThought) {
        target.thought = target.thought ? `${target.thought}\n\n${pendingThought}` : pendingThought
        pendingThought = ''
      }
      if (pendingTools.length) {
        target.tools = [...(target.tools || []), ...pendingTools]
        pendingTools = []
      }
      if (pendingSteps.length) {
        target.steps = [...(target.steps || []), ...pendingSteps]
        pendingSteps = []
      }
    }
    for (const line of lines) {
      if (!line.trim()) continue
      let step
      try { step = JSON.parse(line) } catch { continue }
      if (step?.type === 'GENERIC' && step.source === 'MODEL' && toolBatch) {
        if (toolBatch.results.length <= toolBatch.tools.length) toolBatch.results.push(step)
        continue
      }
      flushToolResults()
      if (step?.type === 'USER_INPUT') {
        flushTo()
        const text = unwrapAgyUserText(step.content)
        if (text) rows.push({ role: 'user', text })
      } else if (step?.type === 'PLANNER_RESPONSE') {
        const thinking = typeof step.thinking === 'string' ? step.thinking.trim() : ''
        if (thinking) {
          pendingThought = pendingThought ? `${pendingThought}\n\n${thinking}` : thinking
          const lastStep = pendingSteps.at(-1)
          if (lastStep?.kind === 'thought') lastStep.text = `${lastStep.text}\n\n${thinking}`
          else pendingSteps.push({ kind: 'thought', text: thinking })
        }
        const text = typeof step.content === 'string' ? step.content.trim() : ''
        if (text) {
          const assistant = { role: 'assistant', text }
          flushTo(assistant)
          rows.push(assistant)
        }
        if (Array.isArray(step.tool_calls) && step.tool_calls.length) {
          toolBatch = { stepIndex: step.step_index, tools: [], results: [] }
          for (const tc of step.tool_calls) {
            const args = typeof tc?.args === 'string' ? (() => { try { return JSON.parse(tc.args) } catch { return { input: tc.args } } })() : (tc?.args ?? {})
            const title = args?.toolSummary || tc?.name || 'Tool'
            const execution = agyCommandExecution(tc?.name, args)
            const tool = {
              toolCallId: tc?.id || `tool-${nextToolId++}`,
              title,
              status: 'completed',
              ...agyToolActivity(tc?.name, args),
              ...(execution ? { execution } : {}),
            }
            toolBatch.tools.push(tool)
            pendingTools.push(tool)
            pendingSteps.push({ kind: 'tool', tool })
          }
        }
      }
    }
    flushToolResults()
    flushTo()
    return rows.length ? markIntermediateCommentary(rows) : null
  } catch {
    return null
  }
}

function messages({ file, remoteId }) {
  if (file) {
    const logs = join(dirname(file), 'brain', remoteId, '.system_generated', 'logs')
    const fromLog = transcriptFileMessages(join(logs, 'transcript_full.jsonl')) ??
      transcriptFileMessages(join(logs, 'transcript.jsonl'))
    if (fromLog) return fromLog
  }
  const db = openNativeDatabase(file)
  if (!db) return []
  try {
    const chunks = db.prepare(`
      SELECT user_step_byte_offsets, agent_step_byte_offsets, user_body, agent_body
      FROM conversations_fts WHERE conversation_id = ? ORDER BY CAST(chunk_index AS INTEGER)
    `).all(remoteId)
    const all = chunks.flatMap(chunk => {
      const steps = []
      for (const [role, prefix] of [['user', 'user'], ['assistant', 'agent']]) {
        const text = Buffer.from(chunk[prefix + '_body'] || '')
        const offsets = JSON.parse(Buffer.from(chunk[prefix + '_step_byte_offsets'] || '[]').toString() || '[]')
        if (!offsets.length && text.length) {
          const part = (role === 'user' ? unwrapAgyUserText(text.toString()) : text.toString()).trim()
          if (part) steps.push({ step: role === 'user' ? 0 : 1, role, text: part })
          continue
        }
        for (const [i, [step, start]] of offsets.entries()) {
          const raw = text.subarray(start, offsets[i + 1]?.[1] ?? text.length).toString()
          const part = (role === 'user' ? unwrapAgyUserText(raw) : raw).trim()
          if (part) steps.push({ step, role, text: part })
        }
      }
      steps.sort((a, b) => a.step - b.step)
      return steps.map(({ role, text }) => ({ role, text }))
    })
    return markIntermediateCommentary(all)
  } finally { db.close() }
}

function packedVarint(bytes, offset) {
  let number = 0
  for (let shift = 0; offset < bytes.length && shift < 70; shift += 7) {
    const byte = bytes[offset++]
    number += (byte & 127) * 2 ** shift
    if (byte < 128) return [number, offset]
  }
  throw new Error('Invalid AGY protobuf varint')
}

function protoFields(bytes, field) {
  if (!(bytes instanceof Uint8Array)) return []
  const values = []
  let offset = 0
  while (offset < bytes.length) {
    const [tag, dataOffset] = packedVarint(bytes, offset)
    offset = dataOffset
    let value
    switch (tag % 8) {
      case 0: [value, offset] = packedVarint(bytes, offset); break
      case 1: offset += 8; break
      case 2: {
        const [length, start] = packedVarint(bytes, offset)
        offset = start + length
        if (Math.floor(tag / 8) === field && offset <= bytes.length) value = bytes.subarray(start, offset)
        break
      }
      case 5:
        if (Math.floor(tag / 8) === field && offset + 4 <= bytes.length) {
          value = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true)
        }
        offset += 4
        break
      default: throw new Error('Invalid AGY protobuf wire type')
    }
    if (offset > bytes.length || tag < 8) throw new Error('Invalid AGY protobuf field')
    if (value !== undefined && Math.floor(tag / 8) === field) values.push(value)
  }
  return values
}

const protoField = (bytes, field) => protoFields(bytes, field).at(-1)

function includesStep(value, index) {
  if (!(value instanceof Uint8Array)) return value === index
  let offset = 0
  while (offset < value.length) {
    const [step, next] = packedVarint(value, offset)
    if (step === index) return true
    offset = next
  }
  return false
}

function contextMetadata(db, step) {
  // CortexStepGeneratorMetadata.step_indices locates the model request for this planner step.
  // ContextWindowMetadata stores the native pre-request context estimate.
  const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 64').iterate()
  for (const { data } of rows) {
    if (step !== undefined && !protoFields(data, 2).some(indices => includesStep(indices, step))) continue
    const metadata = protoField(data, 1)
    const context = protoField(protoField(metadata, 9), 10)
    if (context instanceof Uint8Array) return { context, model: protoField(metadata, 19) }
    if (step !== undefined) return
  }
}

function contextMetrics(db, step) {
  const context = contextMetadata(db, step)?.context
  const contextUsed = protoField(context, 1)
  const contextSize = protoField(context, 4)
  return {
    ...(metricCount(contextUsed) ? { contextUsed, contextEstimated: true } : {}),
    ...(metricCount(contextSize) && contextSize > 0 ? { contextSize } : {}),
  }
}

function sessionContext({ file, remoteId, home = homedir() }) {
  let db
  try {
    if (!nativeUuid.test(remoteId)) return
    const directory = file ? dirname(file) : dataDirectory(home)
    db = openNativeDatabase(join(directory, 'conversations', remoteId + '.db'))
    if (!db) return
    const reading = contextMetadata(db)
    if (!reading) return
    const { context, model } = reading
    const used = protoField(context, 1)
    const size = protoField(context, 4)
    const categories = protoFields(protoField(context, 3), 1).flatMap(group => {
      const label = protoField(group, 1)
      const tokens = Math.round(protoField(group, 4))
      if (!(label instanceof Uint8Array) || !metricCount(tokens)) return []
      const name = Buffer.from(label).toString('utf8').trim()
      return name ? [{ name, tokens }] : []
    })
    return { source: 'native', categories,
      ...(model instanceof Uint8Array ? { model: Buffer.from(model).toString('utf8') } : {}),
      ...(metricCount(used) ? { used, estimated: true } : {}), ...(metricCount(size) && size > 0 ? { size } : {}) }
  } catch { return undefined } finally { db?.close() }
}

function storedRequestUsage(db, requests) {
  const find = db.prepare('SELECT metadata FROM steps WHERE idx = ?')
  return requests.map(request => {
    // CortexStepMetadata.model_usage is a ModelUsageStats protobuf.
    const usage = protoField(find.get(request.step_index)?.metadata, 9)
    if (!(usage instanceof Uint8Array) || (protoField(usage, 2) ?? 0) !== request.input_tokens ||
        (protoField(usage, 3) ?? 0) !== request.output_tokens || (protoField(usage, 5) ?? 0) !== request.cache_read_tokens) return request
    const thought = protoField(usage, 9)
    const response = protoField(usage, 10)
    const reasoning = thought === undefined && response === request.output_tokens ? 0 : thought
    return { ...request, cache_write_tokens: protoField(usage, 4) ?? 0,
      thinking_output_tokens: metricCount(reasoning) && reasoning <= request.output_tokens ? reasoning : undefined }
  })
}

function persistedTurnMetrics(file, remoteId, requests) {
  let counts = summedUsage(requests, usageFields)
  let context
  let db
  try {
    db = openNativeDatabase(join(dirname(file), 'conversations', remoteId + '.db'))
    if (db) {
      try { counts = summedUsage(storedRequestUsage(db, requests), usageFields) } catch {}
      try { context = contextMetrics(db, requests.at(-1).step_index) } catch {}
    }
  } catch {} finally { db?.close() }
  return turnMetrics({ ...counts, ...context })
}

async function metrics({ file, remoteId }) {
  if (!nativeUuid.test(remoteId)) return
  const transcript = join(dirname(file), 'brain', remoteId, '.system_generated', 'logs', 'transcript.jsonl')
  let turn, latest
  for (const row of await recentTranscript(transcript)) {
    if (row.type === 'USER_INPUT') {
      turn = row.status === 'DONE' && row.source === 'USER_EXPLICIT' && metricCount(row.step_index)
        ? { next: row.step_index + 1, requests: [] } : undefined
    } else if (turn && row.step_index !== turn.next++) {
      turn = undefined
    } else if (turn && row.type === 'PLANNER_RESPONSE') {
      if (row.status !== 'DONE' || row.source !== 'MODEL') {
        turn = undefined
        continue
      }
      turn.requests.push(row)
      const hasNoTools = row.tool_calls == null || (Array.isArray(row.tool_calls) && row.tool_calls.length === 0)
      if (hasNoTools && typeof row.content === 'string' && row.content.trim()) {
        // The planner's created_at precedes generation. The log has no turn finish time.
        latest = turn.requests
        turn = undefined
      }
    }
  }
  if (latest) return persistedTurnMetrics(file, remoteId, latest)
}

function conversationDirectory(remoteId, home = homedir()) {
  if (typeof remoteId !== 'string' || !nativeUuid.test(remoteId)) throw new Error('A native AGY session ID is required')
  const directory = dataDirectory(home)
  const db = openNativeDatabase(join(directory, 'conversation_summaries.db'))
  if (!db) throw new Error('AGY conversation index was not found')
  try {
    if (!db.prepare('SELECT 1 FROM conversation_summaries WHERE conversation_id = ?').get(remoteId)) {
      throw new Error('AGY conversation was not found')
    }
  } finally { db.close() }
  return directory
}

export const engine = {
  id: 'agy',
  label: 'Antigravity',
  composerVersion: 2,
  meta: { accentColor: '#7396ec' },
  capabilities: { fileUriLinks: true },
  ...agyCliAdmin,
  readableRoots: ({ home = homedir() } = {}) => [dataDirectory(home)],
  async start(options) {
    options.signal?.throwIfAborted()
    const appDataDirectory = options.runtimeDirectory && prepareAgySessionDirectory(options)
    const adapter = await startAgy({ ...options, appDataDirectory })
    adapter.context = async () => sessionContext({ remoteId: adapter.id, home: options.env?.HOME,
      ...(options.historyDirectory ? { file: join(options.historyDirectory, 'conversation_summaries.db') } : {}) })
    return adapter
  },
  replayHistory: true,
  resumeEmpty: true,
  accountUsage: agyAccountUsage,
  async rename({ remoteId, title, signal, env }) {
    signal?.throwIfAborted()
    if (typeof title !== 'string' || !title.trim() || title.length > 256 || !title.isWellFormed()) throw new Error('Invalid AGY session title')
    writeAgyTitle(conversationDirectory(remoteId,env?.HOME), remoteId, title, signal)
  },
  async setArchived({ remoteId, archived, signal, env }) {
    signal?.throwIfAborted()
    if (typeof archived !== 'boolean') throw new Error('An AGY archive state is required')
    writeAgyArchive(conversationDirectory(remoteId,env?.HOME), remoteId, archived, signal)
  },
  history: { list, messages, metrics, context: sessionContext },
}

export default engine
