import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { inspectCodexThread, readCodexAccountUsage, renameCodexThread, setCodexArchived, startOther } from '../other.mjs'
import { parseCodexCommand } from '../codex-commands.mjs'
import { codexRequestContext } from '../codex-usage.mjs'
import { asMillis, lastModified, latestTimestamp, messageText, nativeUuid, openNativeDatabase, transcriptFiles, transcriptLines } from '../native-history.mjs'
import { codexSessionTokens, metricCount, recentTranscript, turnMetrics } from '../persisted-metrics.mjs'
import { appendExecutionText, codexCommandActivity, codexCommandResult, codexExecution, codexFileActivity, codexPatchActivity, completeExecution } from '../tool-activity.mjs'
import { deleteCodexSession, supportsCodexDelete } from './codex-delete.mjs'
import { codexCliAdmin } from './cli-admin.mjs'

const rootSources = new Set(['cli', 'vscode', 'exec', 'appServer', 'app_server'])
const usageFields = [
  ['reasoningTokens', 'reasoning_output_tokens'], ['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
  ['cacheReadTokens', 'cached_input_tokens'], ['cacheWriteTokens', 'cache_write_input_tokens'],
]
const emptyUsage = Object.fromEntries(usageFields.map(([, field]) => [field, 0]))

function persistedOptions(remoteId) {
  const directory = process.env.CODEX_HOME || join(homedir(), '.codex')
  let db
  try {
    db = openNativeDatabase(join(directory, 'state_5.sqlite'))
    return db?.prepare('SELECT model, reasoning_effort AS effort FROM threads WHERE id=?').get(remoteId) ?? {}
  } catch {
    return {}
  } finally { db?.close() }
}

function workspaceExists(cwd) {
  return typeof cwd === 'string' && statSync(cwd, { throwIfNoEntry: false })?.isDirectory() === true
}

function storedMetadata(directory) {
  const db = openNativeDatabase(join(directory, 'state_5.sqlite'))
  if (!db) return { metadata: new Map(), parents: new Map() }
  try {
    const fields = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name))
    const names = [
      'id', 'cwd', 'title', 'name', 'preview', 'history_mode', 'source', 'agent_nickname', 'archived', 'model', 'model_provider',
      'created_at', 'created_at_ms', 'updated_at', 'updated_at_ms', 'attached_thread_parent_id',
    ].filter(name => fields.has(name))
    const rows = names.length ? db.prepare('SELECT ' + names.join(', ') + ' FROM threads').all() : []
    const metadata = new Map(rows.map(row => [row.id, row]))
    const parents = new Map()
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='thread_spawn_edges'").get()) {
      for (const edge of db.prepare('SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges').all()) {
        parents.set(edge.child_thread_id, edge)
      }
    }
    return { metadata, parents }
  } finally { db.close() }
}

function nativeSource(value) {
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch {}
  }
  return value
}

async function readMetadata(file) {
  for await (const entry of transcriptLines(file)) {
    if (entry.type === 'session_meta' && entry.payload) {
      return { ...entry.payload, timestamp: entry.payload.timestamp || entry.timestamp }
    }
  }
}

async function list({ home = homedir(), directory = process.env.CODEX_HOME || join(home, '.codex'), remoteId: onlyId }) {
  const { metadata, parents } = storedMetadata(directory)
  const titles = new Map()
  const index = join(directory, 'session_index.jsonl')
  if (existsSync(index)) {
    for await (const row of transcriptLines(index)) {
      if (row.id && row.thread_name) titles.set(row.id, row.thread_name)
    }
  }
  const entries = []
  const files = [
    ...transcriptFiles(join(directory, 'sessions'), 3).map(file => ({ file, archived: false })),
    ...transcriptFiles(join(directory, 'archived_sessions')).map(file => ({ file, archived: true })),
  ]
  for (const { file, archived } of files) {
    const remoteId = basename(file).replace(/\.jsonl(?:\.zst)?$/, '').slice(-36)
    if (onlyId ? remoteId !== onlyId : !nativeUuid.test(remoteId)) continue
    const row = metadata.get(remoteId) ?? await readMetadata(file)
    if (!row) continue
    const source = nativeSource(row.source)
    const spawn = source?.subagent?.thread_spawn ?? source?.subAgent?.thread_spawn
    const edge = parents.get(remoteId)
    const nativeParent = [edge?.parent_thread_id, spawn?.parent_thread_id, row.attached_thread_parent_id]
      .find(candidate => nativeUuid.test(candidate))
    if (!rootSources.has(source) && !nativeParent) continue
    const indexTitle = titles.get(remoteId)
    const rootTitle = (row.history_mode === 'paginated' && row.name) || indexTitle || row.name || row.title || row.preview
    entries.push({
      remoteId, cwd: row.cwd, file, nativeParent, model: row.model, modelProvider:row.model_provider,
      title: nativeParent ? indexTitle || row.name || row.agent_nickname || spawn?.agent_nickname || row.title : rootTitle,
      createdAt: row.created_at_ms ?? row.created_at ?? row.timestamp,
      updatedAt: row.updated_at_ms ?? row.updated_at ?? (await latestTimestamp(file)) ?? lastModified(file),
      status: edge?.status === 'closed' ? 'idle' : undefined,
      archived: Boolean(row.archived ?? archived),
    })
  }
  return entries
}

const isInternalCodexUser = text =>
  /^(# AGENTS\.md instructions\b|<INSTRUCTIONS>|<user_instructions>|<environment_context>|<permissions instructions>|<turn_aborted>|<subagent_notification>)/.test(text.trim())

function markTurnCommentary(rows) {
  return rows.map((msg, i) =>
    msg.role === 'assistant' && !msg.phase && rows[i + 1]?.role === 'assistant'
      ? { ...msg, phase: 'commentary' }
      : msg
  )
}

const assistantPhase = phase => phase === 'commentary' || phase === 'final_answer' ? { phase } : {}

function parseToolArgs(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return { command: raw } }
  }
  return {}
}

function codexToolTitle(name, args) {
  const cmd = Array.isArray(args?.command) ? args.command.join(' ') : (args?.cmd || args?.command || args?.path || '')
  return cmd ? `${name}: ${String(cmd).slice(0, 80)}` : (name || 'Tool')
}

const codexShellTools = new Set(['exec', 'exec_command', 'shell', 'shell_command', 'write_stdin'])

function nativeToolActivity(item) {
  if (['CommandExecution', 'commandExecution', 'exec_command_end', 'exec_command_begin'].includes(item.type)) {
    const execution = codexExecution(item)
    return {
      title: codexToolTitle('Shell', item),
      ...codexCommandActivity(item.parsed_cmd ?? item.parsedCmd ?? item.commandActions, item.cwd),
      ...(execution ? { execution } : {}),
    }
  }
  if (item.type === 'FileChange' || item.type === 'patch_apply_end' || item.type === 'patch_apply_begin') {
    return { title: 'File changes', ...codexFileActivity(item.changes) }
  }
  if (item.type === 'McpToolCall') return { title: item.tool || 'MCP tool', kind: 'other' }
  if (item.type === 'ImageView') return { title: 'View image', kind: 'read', locations: [{ path: item.path }] }
  if (item.type === 'WebSearch' || item.type === 'web_search_end') return { title: 'Web search', kind: 'search' }
}

async function messages({ file }) {
  const rows = []
  const legacy = []
  const toolsById = new Map()
  const wrappedCalls = new Set()
  const pendingExec = new Set()
  const commandCalls = new Set()
  const messagesById = new Map()
  let lastMessage
  let lastThought
  let steps = []

  const attachActivity = message => {
    const thoughts = steps.filter(step => step.kind === 'thought').map(step => step.text)
    const tools = steps.filter(step => step.kind === 'tool').map(step => step.tool)
    if (thoughts.length) message.thought = thoughts.join('\n\n')
    if (tools.length) message.tools = tools
    if (steps.length) message.steps = steps
    steps = []
  }
  const finishActivity = () => {
    const message = { role: 'assistant', text: '' }
    attachActivity(message)
    if (message.steps) rows.push(message)
  }
  const addMessage = (role, text, source, id, phase) => {
    if (typeof text !== 'string' || !text.trim() || (role === 'user' && isInternalCodexUser(text))) return
    const previous = id && messagesById.get(id)
    const adjacentCopy = lastMessage?.message.role === role && lastMessage.message.text === text &&
      !lastMessage.sources.has(source) && (!phase || !lastMessage.message.phase || lastMessage.message.phase === phase)
      ? lastMessage : undefined
    const duplicate = previous?.message.role === role ? previous : adjacentCopy
    if (duplicate) {
      duplicate.sources.add(source)
      if (id) messagesById.set(id, duplicate)
      if (role === 'assistant') Object.assign(duplicate.message, assistantPhase(phase))
      return
    }

    const message = { role, text, ...(role === 'assistant' ? assistantPhase(phase) : {}) }
    if (role === 'user') finishActivity()
    else attachActivity(message)
    rows.push(message)
    lastMessage = { message, sources: new Set([source]) }
    lastThought = undefined
    if (id) messagesById.set(id, lastMessage)
  }
  const addThought = (value, source) => {
    if (typeof value !== 'string' || !value.trim()) return
    const text = value.trim()
    if (lastThought?.text === text && lastThought.source !== source) return
    const last = steps.at(-1)
    if (last?.kind === 'thought') last.text = `${last.text}\n\n${text}`
    else steps.push({ kind: 'thought', text })
    lastThought = { text, source }
    lastMessage = undefined
  }
  const addTool = (id, metadata, preferred = false) => {
    const existing = toolsById.get(id)
    if (existing) {
      const merged = preferred ? { ...existing, ...metadata } : { ...metadata, ...existing }
      if (metadata.execution && existing.execution) {
        merged.execution = preferred ? completeExecution(existing.execution, metadata.execution)
          : completeExecution(metadata.execution, existing.execution)
      }
      Object.assign(existing, merged)
      return
    }
    const tool = { toolCallId: id ?? `tool-${toolsById.size}`, ...metadata }
    toolsById.set(tool.toolCallId, tool)
    steps.push({ kind: 'tool', tool })
    lastMessage = lastThought = undefined
  }

  for await (const entry of transcriptLines(file)) {
    const item = entry.payload
    if (entry.type === 'message' && ['user', 'assistant'].includes(entry.role)) {
      const text = messageText(entry.content)
      if (text.trim() && !(entry.role === 'user' && isInternalCodexUser(text))) {
        legacy.push({ role: entry.role, text, ...(entry.role === 'assistant' ? assistantPhase(entry.phase) : {}) })
      }
      continue
    }
    if (!item) continue
    if (entry.type === 'event_msg') {
      const nativeItem = ['item_started', 'item_completed'].includes(item.type) ? item.item : item
      const metadata = nativeItem && nativeToolActivity(nativeItem)
      const id = nativeItem?.call_id ?? nativeItem?.id
      if (metadata && id) {
        const status = item.type === 'item_started' || item.type.endsWith('_begin') ? 'in_progress'
          : ['failed', 'declined', 'interrupted'].includes(nativeItem.status) || nativeItem.success === false ? 'failed' : 'completed'
        // The bundled exec wrapper has a different ID from its nested shell notifications.
        if (nativeItem.type === 'CommandExecution' && nativeItem.source === 'unified_exec_startup' && pendingExec.size === 1) {
          const wrapper = pendingExec.values().next().value
          if (wrapper !== id) wrappedCalls.add(wrapper)
        }
        addTool(id, { status, ...metadata }, true)
      }
      if (item.type === 'terminal_interaction' && id && toolsById.get(id)?.execution) {
        const tool = toolsById.get(id)
        tool.execution = appendExecutionText(tool.execution, 'input', item.stdin)
      }
      if (['agent_reasoning', 'reasoning'].includes(item.type)) addThought(item.text, 'event')
      if (['user_message', 'agent_message'].includes(item.type)) {
        addMessage(item.type === 'user_message' ? 'user' : 'assistant', item.message ?? messageText(item.content), 'event', item.id, item.phase)
      }
      if (item.type === 'item_completed' && ['UserMessage', 'AgentMessage'].includes(nativeItem?.type)) {
        const content = Array.isArray(nativeItem.content)
          ? nativeItem.content.map(block => block?.type === 'Text' ? { ...block, type: 'text' } : block)
          : nativeItem.content
        addMessage(nativeItem.type === 'UserMessage' ? 'user' : 'assistant', messageText(content), 'item', id, nativeItem.phase)
      }
      if (['task_started', 'turn_started'].includes(item.type)) {
        lastMessage = lastThought = undefined
        messagesById.clear()
        pendingExec.clear()
      }
      if (item.type === 'thread_rolled_back' && Number.isSafeInteger(item.num_turns)) {
        lastMessage = lastThought = undefined
        messagesById.clear()
        pendingExec.clear()
        steps = []
        for (let i = 0; i < item.num_turns; i++) {
          const user = rows.findLastIndex(message => message.role === 'user')
          if (user < 0) break
          rows.splice(user)
        }
      }
    } else if (entry.type === 'response_item') {
      if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        addThought(item.summary.map(s => s?.text).filter(Boolean).join('\n'), 'response')
      } else if (['function_call', 'custom_tool_call', 'local_shell_call'].includes(item.type)) {
        const rawInput = item.arguments ?? item.input ?? item.action
        const args = parseToolArgs(rawInput)
        const name = item.name || (item.type === 'local_shell_call' ? 'shell' : 'tool')
        const metadata = name === 'apply_patch' ? codexPatchActivity(args?.patch ?? item.input)
          : codexShellTools.has(name) ? codexCommandActivity(args?.parsed_cmd ?? args?.parsedCmd, args?.workdir ?? args?.cwd)
            : { kind: 'other' }
        const title = item.type === 'custom_tool_call' && !codexShellTools.has(name) ? name : codexToolTitle(name, args)
        const id = item.call_id ?? item.id
        if (id && item.type === 'custom_tool_call' && name === 'exec') pendingExec.add(id)
        const shell = name !== 'exec' && codexShellTools.has(name)
        const execution = shell ? codexExecution(name === 'write_stdin' ? { interaction_input: args.chars } : args) : undefined
        if (id && shell) commandCalls.add(id)
        addTool(id, { title, status: 'completed', ...metadata, ...(execution ? { execution } : {}) })
      } else if (item.type === 'custom_tool_call_output' || item.type === 'function_call_output') {
        pendingExec.delete(item.call_id)
        if (commandCalls.delete(item.call_id)) {
          const execution = codexCommandResult(item.output)
          const tool = toolsById.get(item.call_id)
          if (execution && tool) {
            if (tool.execution?.exitCode === undefined && execution.exitCode !== undefined) {
              tool.status = execution.exitCode === 0 ? 'completed' : 'failed'
            }
            tool.execution = completeExecution(execution, tool.execution)
          }
        }
      } else if (['message', 'user_message'].includes(item.type) && item.channel !== 'analysis') {
        const role = item.role || (item.type === 'user_message' ? 'user' : undefined)
        if (['user', 'assistant'].includes(role)) addMessage(role, messageText(item.content), 'response', item.id, item.phase)
      }
    }
  }
  finishActivity()
  if (rows.every(message => !message.text) && legacy.length) return markTurnCommentary(legacy)
  const visibleRows = rows.filter(message => {
    if (message.tools?.some(tool => wrappedCalls.has(tool.toolCallId))) {
      message.tools = message.tools.filter(tool => !wrappedCalls.has(tool.toolCallId))
      message.steps = message.steps.filter(step => step.kind !== 'tool' || !wrappedCalls.has(step.tool.toolCallId))
      if (!message.tools.length) delete message.tools
      if (!message.steps.length) delete message.steps
    }
    return message.text || message.steps?.length
  })
  return markTurnCommentary(visibleRows)
}

function recordUsage(turn, previous, current, last) {
  for (const [field, key] of usageFields) {
    if (turn.counts[field] === null) continue
    const delta = current[key] - previous?.[key]
    if (!metricCount(previous?.[key]) || !metricCount(current[key]) || !metricCount(delta) ||
        (delta !== 0 && delta !== last?.[key])) {
      turn.counts[field] = null
      continue
    }
    turn.counts[field] = (turn.counts[field] ?? 0) + delta
    turn.changed ||= delta > 0
  }
}

async function metrics({ file }) {
  const rows = await recentTranscript(file)
  const header = rows[0]
  let usage = header?.type === 'session_meta' && !header.payload?.forked_from_id ? emptyUsage : undefined
  let turn
  const completed = []
  for (const row of rows) {
    const event = row.type === 'event_msg' && row.payload
    if (!event) continue
    if (event.type === 'task_started' || event.type === 'turn_started') {
      if (turn && turn.id !== event.turn_id) completed.push(null)
      if (!turn || turn.id !== event.turn_id) turn = { id: event.turn_id, started: asMillis(row.timestamp), counts: {} }
    } else if (event.type === 'token_count' && event.info?.total_token_usage) {
      const current = event.info.total_token_usage
      if (turn) {
        recordUsage(turn, usage, current, event.info.last_token_usage)
        const used = event.info.last_token_usage?.total_tokens
        const size = event.info.model_context_window
        turn.window = {}
        if (metricCount(used)) turn.window.contextUsed = used
        if (metricCount(size) && size > 0) turn.window.contextSize = size
      }
      usage = current
    } else if (['task_complete', 'turn_complete', 'turn_aborted'].includes(event.type) && (!turn || turn.id === event.turn_id)) {
      if (event.error || event.type === 'turn_aborted') completed.push(null)
      else {
        const duration = event.duration_ms ?? (asMillis(row.timestamp) - turn?.started)
        const counts = turn?.changed ? Object.fromEntries(Object.entries(turn.counts).filter(([, count]) => metricCount(count))) : {}
        completed.push({ metrics: turnMetrics({ ...counts, ...turn?.window }, duration) })
      }
      turn = undefined
    } else if (event.type === 'thread_rolled_back' && metricCount(event.num_turns) && event.num_turns > 0) {
      completed.length = Math.max(0, completed.length - event.num_turns)
    }
  }
  const latest = completed.findLast(Boolean)?.metrics
  const sessionTokens = usage !== emptyUsage ? codexSessionTokens(usage) : undefined
  return sessionTokens ? { ...latest, sessionTokens } : latest
}

async function context({ file, model }) {
  const completed = []
  let active, unscoped
  for (const row of await recentTranscript(file)) {
    const event = row.payload
    if (row.type === 'turn_context' && typeof event?.model === 'string') model = event.model
    if (row.type !== 'event_msg' || !event) continue
    if (['task_started', 'turn_started'].includes(event.type)) {
      if (!active || active.id !== event.turn_id) active = { id: event.turn_id }
    } else if (event.type === 'token_count') {
      const reading = codexRequestContext(event.info, model)
      if (reading && active) active.reading = reading
      else if (reading) unscoped = reading
    } else if (['task_complete', 'turn_complete', 'turn_aborted'].includes(event.type) && (!active || active.id === event.turn_id)) {
      completed.push(active ? active.reading : unscoped)
      active = unscoped = undefined
    } else if (event.type === 'thread_rolled_back' && metricCount(event.num_turns) && event.num_turns > 0) {
      completed.length = Math.max(0, completed.length - event.num_turns)
      active = unscoped = undefined
    }
  }
  return active?.reading ?? unscoped ?? completed.findLast(Boolean)
}

export const engine = {
  id: 'codex',
  label: 'Codex',
  composerVersion: 3,
  meta: { accentColor: '#8a74f4' },
  ...codexCliAdmin,
  capabilities: {
    cacheWriteOptional: true,
    structuredUserReply: true,
    commandDialogs: ['review', 'compact'],
  },
  resolvePrompt({ text, attachmentCount, adapter }) {
    let command
    try { command = parseCodexCommand(text, attachmentCount) }
    catch (error) { throw Object.assign(new Error(error.message), { status: 400 }) }
    if (command?.name === 'goal' && adapter && !adapter.capabilities?.goal) {
      throw Object.assign(new Error('Codex goals are disabled for this conversation'), { status: 409 })
    }
    return command
  },
  supportsDelete: supportsCodexDelete,
  deleteSession: deleteCodexSession,
  async rename({ remoteId, title, signal }) {
    if (typeof remoteId !== 'string' || !nativeUuid.test(remoteId)) throw new Error('A native Codex session ID is required')
    if (typeof title !== 'string' || !title.trim()) throw new Error('A Codex session title is required')
    await renameCodexThread({ remoteId, title: title.trim(), cwd: homedir(), signal })
  },
  accountUsage: ({ signal, env, extraArgs }) => readCodexAccountUsage({ cwd: homedir(), signal, env, extraArgs }),
  async inspect({ remoteId, cwd, savedOptions, signal, env, extraArgs }) {
    if (typeof remoteId !== 'string' || !nativeUuid.test(remoteId)) throw new Error('A native Codex session ID is required')
    return inspectCodexThread({ remoteId, cwd: workspaceExists(cwd) ? cwd : homedir(), savedOptions, signal, env, extraArgs, ...persistedOptions(remoteId) })
  },
  async start(options) {
    if (options.resumeId && (typeof options.resumeId !== 'string' || !nativeUuid.test(options.resumeId))) {
      throw Object.assign(new Error('The Codex conversation ID is invalid.'), { code: 'codex_session_invalid', status: 400 })
    }
    if (options.resumeId && !workspaceExists(options.cwd)) {
      throw Object.assign(new Error('The workspace for this Codex conversation no longer exists.'), { code: 'codex_workspace_missing', status: 409 })
    }
    return startOther({ ...options, engine: 'codex' })
  },
  async fork({ sourceId, ...options }) {
    if (typeof sourceId !== 'string' || !sourceId) throw new Error('A native Codex session ID is required')
    return startOther({ ...options, engine: 'codex', forkFrom: sourceId })
  },
  async setArchived({ remoteId, archived, signal }) {
    if (typeof remoteId !== 'string' || !nativeUuid.test(remoteId)) throw new Error('A native Codex session ID is required')
    if (typeof archived !== 'boolean') throw new Error('A Codex archive state is required')
    try {
      // Archive addresses a thread by ID even when its former workspace no longer exists.
      await setCodexArchived({ remoteId, cwd: homedir(), archived, signal })
    } catch (error) {
      signal?.throwIfAborted()
      // Codex rejects repeated mutations. A lost reply can also follow a successful mutation.
      const current = await list({ remoteId }).catch(() => [])
      signal?.throwIfAborted()
      if (!current.length || current.some(thread => thread.archived !== archived)) throw error
    }
  },
  history: { list, messages, metrics, context },
}

export default engine
