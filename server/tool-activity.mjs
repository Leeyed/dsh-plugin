import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolKinds = new Set(['read', 'write', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
const executionText = {
  command: [8 * 1024, 'commandTruncated'],
  input: [8 * 1024, 'inputTruncated'],
  output: [16 * 1024, 'outputTruncated'],
  stdout: [16 * 1024, 'outputTruncated'],
  stderr: [16 * 1024, 'outputTruncated'],
}
const outputFields = ['output', 'stdout', 'stderr']

function textPrefix(text, length) {
  if (text.length <= length) return text
  const end = text.charCodeAt(length - 1)
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? length - 1 : length)
}

function textSuffix(text, length) {
  if (text.length <= length) return text
  const start = text.length - length
  const code = text.charCodeAt(start)
  return text.slice(code >= 0xdc00 && code <= 0xdfff ? start + 1 : start)
}

export function commandExecution(details) {
  if (!details || typeof details !== 'object') return undefined
  const snapshot = {}
  for (const [field, [limit, flag]] of Object.entries(executionText)) {
    const value = details[field]
    if (typeof value === 'string') {
      const tail = outputFields.includes(field) ? details[field + 'Tail'] : undefined
      const split = outputFields.includes(field) && (typeof tail === 'string' || value.length > limit)
      snapshot[field] = textPrefix(value, split ? limit / 2 : limit)
      if (split) snapshot[field + 'Tail'] = textSuffix(typeof tail === 'string' ? tail : value, limit / 2)
      if (split || value.length > limit) snapshot[flag] = true
    }
    if (details[flag] === true) snapshot[flag] = true
  }
  if (Number.isSafeInteger(details.exitCode)) snapshot.exitCode = details.exitCode
  return Object.keys(snapshot).length ? snapshot : undefined
}

export function appendExecutionText(previous, field, chunk) {
  if (typeof chunk !== 'string' || !chunk) return previous
  const [limit, flag] = executionText[field]
  const text = previous?.[field] ?? ''
  const available = limit - text.length
  const previousTail = previous?.[field + 'Tail']
  if (outputFields.includes(field) && (previousTail !== undefined || chunk.length > available)) {
    const half = limit / 2
    const head = previousTail !== undefined ? text
      : textPrefix(text + chunk.slice(0, Math.max(0, half - text.length + 1)), half)
    const before = previousTail ?? text
    const tail = chunk.length >= half ? textSuffix(chunk, half)
      : textSuffix(textSuffix(before, half) + chunk, half)
    if (head === text && tail === previousTail) return previous
    return { ...previous, [field]: head, [field + 'Tail']: tail, [flag]: true }
  }
  if (available <= 1 && previous?.[flag]) return previous
  const next = { ...previous, [field]: text + textPrefix(chunk, available) }
  if (chunk.length > available) next[flag] = true
  return next
}

// A result with separate streams supersedes the live combined preview.
export function completeExecution(previous, result) {
  if (!result) return previous
  const next = { ...previous, ...result }
  if (result.stdout !== undefined || result.stderr !== undefined) {
    delete next.output
    delete next.outputTail
  }
  if (result.output !== undefined) {
    for (const field of ['stdout', 'stderr']) {
      delete next[field]
      delete next[field + 'Tail']
    }
  }
  if (outputFields.some(field => result[field] !== undefined)) {
    for (const field of outputFields) {
      if (result[field] !== undefined && result[field + 'Tail'] === undefined) delete next[field + 'Tail']
    }
    if (!result.outputTruncated && !outputFields.some(field => next[field + 'Tail'] !== undefined)) delete next.outputTruncated
  }
  return next
}

const claudeShellTools = new Set(['Bash', 'PowerShell'])

function resultText(content) {
  if (typeof content === 'string') return content
  if (content?.type === 'text' && typeof content.text === 'string') return content.text
  if (!Array.isArray(content)) return undefined
  const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string')
  if (text.length) return text.map(block => block.text).join('')
}

export function claudeCommandResult(name, block, result) {
  if (!claudeShellTools.has(name)) return undefined
  const { stdout, stderr } = result ?? {}
  if (result?.isImage !== true && (typeof stdout === 'string' || typeof stderr === 'string')) {
    return commandExecution({ stdout, stderr, exitCode: result.exitCode ?? result.exit_code })
  }
  let output = resultText(block?.content)
  // Claude prefixes its failed shell results with the process status when available.
  const exit = block?.is_error && /^Exit code (-?\d+)\r?\n/.exec(output ?? '')
  if (exit) output = output.slice(exit[0].length)
  return commandExecution({ output, exitCode: result?.exitCode ?? result?.exit_code ?? (exit ? Number(exit[1]) : undefined) })
}

const agyShellTools = new Set(['run_command', 'command_status', 'send_command_input'])

export function agyCommandExecution(name, args) {
  if (!agyShellTools.has(name)) return undefined
  return commandExecution({
    command: args?.CommandLine ?? args?.command,
    input: name === 'send_command_input' ? args?.Input ?? args?.input : undefined,
  })
}

const agyTimestamp = '(?:Created|Completed) At: \\d{4}-\\d{2}-\\d{2}T[^\\r\\n]{8,32}\\r?\\n'
const agyResultHeader = new RegExp(
  `^(?:${agyTimestamp})*(?:(?:The tool's output was truncated[^\\r\\n]*\\r?\\n\\r?\\n[^\\r\\n]*\\r?\\n)(?:${agyTimestamp})*)?Command exited with code (-?\\d+)\\.(?:\\r?\\n\\r?\\n|$)`,
)
const agyBackgroundHeader = new RegExp(`^(?:${agyTimestamp})*Tool is running as a background task with task id: [^\\r\\n]+`)

export function agyTranscriptCommandResult(text) {
  if (typeof text !== 'string') return undefined
  const match = agyResultHeader.exec(text)
  if (match) return commandExecution({
    output: text.slice(match[0].length),
    exitCode: Number(match[1]),
    outputTruncated: match[0].includes('output was truncated'),
  })
  if (agyBackgroundHeader.test(text)) {
    const log = /\r?\nTask logs are available at: [^\r\n]+\r?\nLog output:(?:\r?\n|$)/.exec(text)
    return log ? commandExecution({ output: text.slice(log.index + log[0].length) }) : undefined
  }
}

export function agyCommandResult(raw, content) {
  const stdout = raw?.stdout ?? raw?.Stdout
  const stderr = raw?.stderr ?? raw?.Stderr
  const exitCode = raw?.exitCode ?? raw?.exit_code ?? raw?.ExitCode
  if (typeof stdout === 'string' || typeof stderr === 'string') {
    return commandExecution({ stdout, stderr, exitCode })
  }
  const output = resultText(raw?.output ?? raw?.Output ?? raw) ??
    resultText(Array.isArray(content) ? content.filter(item => item?.type === 'content').map(item => item.content) : content)
  const transcript = agyTranscriptCommandResult(output)
  if (transcript || agyBackgroundHeader.test(output ?? '')) return completeExecution(transcript, commandExecution({ exitCode }))
  return commandExecution({ output, exitCode })
}

export function codexExecution(item) {
  const raw = item?.command ?? item?.cmd
  const command = Array.isArray(raw) && raw.every(part => typeof part === 'string')
    ? raw.map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : "'" + part.replaceAll("'", "'\\''") + "'").join(' ')
    : raw
  const output = item?.aggregatedOutput ?? item?.aggregated_output
  const { stdout, stderr } = item ?? {}
  return commandExecution({
    command, input: item?.interaction_input,
    ...(typeof output === 'string' && (output.length || typeof stdout !== 'string' && typeof stderr !== 'string')
      ? { output } : { stdout, stderr }),
    exitCode: item?.exitCode ?? item?.exit_code,
  })
}

export function codexCommandResult(content) {
  const text = resultText(content)
  if (text === undefined) return undefined
  const header = /^(?:Chunk ID: [^\r\n]+\r?\n)?(?:Exit code: (-?\d+)\r?\n)?Wall time: -?\d+(?:\.\d+)? seconds\r?\n(?:(?:Process exited with code (-?\d+)|Process running with session ID \d+)\r?\n)?(?:Original token count: \d+\r?\n)?(?:Total output lines: \d+\r?\n)?(?:Final )?Output:(?:\r?\n|$)/.exec(text)
  if (!header) return undefined
  const output = text.slice(header[0].length)
  const warning = /^Warning: truncated output \(original token count: \d+\)\r?\n(?:Total output lines: \d+\r?\n)?\r?\n?/.exec(output)
  const exit = header[1] ?? header[2]
  return commandExecution({
    output: warning ? output.slice(warning[0].length) : output,
    exitCode: exit === undefined ? undefined : Number(exit),
    outputTruncated: Boolean(warning) || header[0].includes('Total output lines: '),
  })
}

export function toolLocations(locations) {
  const seen = new Set()
  const result = []
  for (const location of Array.isArray(locations) ? locations : []) {
    const path = location?.path ?? location?.uri
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) continue
    const line = Number.isSafeInteger(location.line) && location.line > 0 ? location.line : undefined
    const key = JSON.stringify([path, line])
    if (seen.has(key)) continue
    seen.add(key)
    result.push(line === undefined ? { path } : { path, line })
  }
  return result
}

function activity(kind, locations = []) {
  const paths = toolLocations(locations)
  return { kind, ...(paths.length ? { locations: paths } : {}) }
}

const agyKinds = new Map(Object.entries({
  read_file: 'read', view_file: 'read', view_file_outline: 'read', view_code_item: 'read',
  edit_file: 'edit', write_file: 'write', write_to_file: 'write', replace_file_content: 'edit', multi_replace_file_content: 'edit',
  delete_file: 'delete', move_file: 'move',
  grep_search: 'search', find_by_name: 'search', list_dir: 'search', list_directory: 'search', search_web: 'search',
  run_command: 'execute', command_status: 'execute', send_command_input: 'execute',
  read_url_content: 'fetch', browser_subagent: 'fetch',
}))

export function agyToolActivity(name, args, nativeKind, nativeLocations) {
  const namedKind = agyKinds.get(name)
  const kind = namedKind === 'write' || !toolKinds.has(nativeKind) || nativeKind === 'other' ? namedKind ?? 'other' : nativeKind
  const locations = toolLocations(nativeLocations)
  if (locations.length) return { kind, locations }
  if (!['read', 'write', 'edit', 'delete', 'move', 'search'].includes(kind)) return { kind }
  const path = args?.Path ?? args?.AbsolutePath ?? args?.TargetFile ?? args?.SearchPath ?? args?.path
  const line = args?.StartLine ?? args?.StartLineNumber ?? args?.start_line
  const paths = [{ path, line }]
  if (kind === 'move') paths.push({ path: args?.DestinationPath })
  return activity(kind, paths)
}

const claudeKinds = new Map(Object.entries({
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Grep: 'search', Glob: 'search', Bash: 'execute', PowerShell: 'execute',
  WebSearch: 'search', WebFetch: 'fetch', EnterPlanMode: 'switch_mode', ExitPlanMode: 'switch_mode',
}))

export function claudeToolActivity(name, input) {
  const kind = claudeKinds.get(name) ?? 'other'
  if (kind === 'read') return activity(kind, [{ path: input?.file_path, line: input?.offset }])
  if (kind === 'edit' || kind === 'write') return activity(kind, [{ path: input?.file_path ?? input?.notebook_path }])
  if (name === 'Grep') return activity(kind, [{ path: input?.path }])
  if (claudeShellTools.has(name)) {
    const execution = commandExecution({ command: input?.command })
    return { kind, ...(execution ? { execution } : {}) }
  }
  return { kind }
}

function localPath(path) {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) return undefined
  if (!path.startsWith('file://')) return path
  try { return fileURLToPath(path) } catch { return undefined }
}

function shellPath(path, cwd) {
  const file = localPath(path)
  if (!file) return undefined
  if (isAbsolute(file)) return file
  const directory = localPath(cwd)
  if (directory && isAbsolute(directory)) return resolve(directory, file)
}

const commandKinds = new Map([
  ['read', 'read'], ['listFiles', 'search'], ['list_files', 'search'], ['search', 'search'],
])

export function codexCommandActivity(actions, cwd) {
  const entries = Array.isArray(actions) ? actions : []
  const kinds = new Set(entries.map(action => commandKinds.get(action?.type) ?? 'execute'))
  const kind = kinds.size === 1 ? kinds.values().next().value : 'execute'
  return activity(kind, entries.filter(action => action?.type === 'read' || action?.type === 'search')
    .map(action => ({ path: shellPath(action.path, cwd), line: action.line })))
}

export function codexFileActivity(changes) {
  const items = Array.isArray(changes) ? changes : Object.entries(changes ?? {}).map(([path, change]) => ({
    path,
    kind: { type: change?.type, move_path: change?.move_path },
  }))
  const locations = []
  const kinds = new Set()
  for (const change of items) {
    const type = change?.kind?.type
    const destination = change?.kind?.move_path ?? change?.kind?.movePath
    kinds.add(type === 'delete' ? 'delete' : type === 'add' ? 'write' : destination ? 'move' : 'edit')
    locations.push({ path: change?.path })
    if (destination) locations.push({ path: destination })
  }
  return activity(kinds.size === 1 ? kinds.values().next().value : 'edit', locations)
}

export function codexPatchActivity(patch) {
  if (typeof patch !== 'string') return { kind: 'edit' }
  const lines = patch.trim().split(/\r?\n/)
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return { kind: 'edit' }
  const changes = []
  for (const line of lines) {
    const file = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    if (file) changes.push({ path: file[2], kind: { type: file[1].toLowerCase() } })
    const move = /^\*\*\* Move to: (.+)$/.exec(line)
    if (move && changes.at(-1)?.kind.type === 'update') changes.at(-1).kind.move_path = move[1]
  }
  return codexFileActivity(changes)
}
