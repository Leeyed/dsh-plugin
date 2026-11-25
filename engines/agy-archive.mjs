import { randomUUID } from 'node:crypto'
import { chmodSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const protobufToken = /#[^\r\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[A-Za-z_]\w*|\d+|[^\s]/g
const closingToken = new Map([['{', '}'], ['<', '>'], ['[', ']']])
const boolValue = new Map([['true', true], ['True', true], ['t', true], ['1', true],
  ['false', false], ['False', false], ['f', false], ['0', false]])

function annotationFields(text) {
  // Go prototext can serialize every field on one line. Ignore quoted contents,
  // comments and nested fields before locating the two top-level annotations.
  const tokens = [...text.matchAll(protobufToken)].filter(([token]) => !token.startsWith('#'))
  const nesting = []
  let archived = false
  let flag, stamp, stampStart, title, titleRange
  for (const [i, token] of tokens.entries()) {
    const [value] = token
    if (!nesting.length) {
      const next = tokens[i + 1]
      const fieldValue = next?.[0] === ':' ? tokens[i + 2] : next
      if (value === 'archived' && next?.[0] === ':') {
        if (flag || !boolValue.has(fieldValue?.[0])) throw new Error('Invalid AGY archive annotation')
        archived = boolValue.get(fieldValue[0])
        flag = [fieldValue.index, fieldValue.index + fieldValue[0].length]
      } else if (value === 'archival_status_timestamp' && (next?.[0] === ':' || closingToken.has(next?.[0]))) {
        if (stamp || !['{', '<'].includes(fieldValue?.[0])) throw new Error('Invalid AGY archival timestamp')
        stampStart = fieldValue.index
      } else if (value === 'title' && next?.[0] === ':') {
        if (titleRange || !/^["']/.test(fieldValue?.[0] ?? '')) throw new Error('Invalid AGY title annotation')
        let end = i + 2
        while (/^["']/.test(tokens[end + 1]?.[0] ?? '')) end++
        titleRange = [fieldValue.index, tokens[end].index + tokens[end][0].length]
        // Go normally emits JSON-compatible strings here. Preserve other valid
        // prototext spellings even when the SQLite title is the safer display value.
        try { title = tokens.slice(i + 2, end + 1).map(token => JSON.parse(token[0])).join('') } catch {}
      }
    }
    if (closingToken.has(value)) nesting.push(closingToken.get(value))
    else if (['}', '>', ']'].includes(value)) {
      if (nesting.pop() !== value) throw new Error('Invalid AGY annotations')
      if (!nesting.length && stampStart !== undefined) {
        stamp = [stampStart, token.index + 1]
        stampStart = undefined
      }
    } else if (value === '"' || value === "'") throw new Error('Invalid AGY annotation string')
  }
  if (nesting.length || stampStart !== undefined) throw new Error('Invalid AGY annotations')
  return { archived, flag, stamp, title, titleRange }
}

function annotationPath(directory, remoteId) {
  return join(directory, 'annotations', remoteId + '.pbtxt')
}

export function agyAnnotations(directory, remoteId) {
  try { return annotationFields(readFileSync(annotationPath(directory, remoteId), 'utf8')) }
  catch (error) { return error.code === 'ENOENT' ? { archived: false } : {} }
}

function sameFile(left, right) {
  if (!left || !right) return left === right
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function updateAnnotations(directory, remoteId, operation, signal, update) {
  signal?.throwIfAborted()
  const file = annotationPath(directory, remoteId)
  const stat = () => lstatSync(file, { bigint: true, throwIfNoEntry: false })
  const before = stat()
  if (before && !before.isFile()) throw new Error('AGY annotations must be a regular file')
  const text = before ? readFileSync(file, 'utf8') : ''
  const fields = annotationFields(text)
  const checkUnchanged = () => {
    if (!sameFile(before, stat())) throw new Error(`AGY annotations changed during ${operation}. Retry the operation.`)
  }
  checkUnchanged()
  const changes = update(fields)
  if (!changes?.length) return

  const replacements = []
  const additions = []
  for (const [range, name, value] of changes) {
    if (range) replacements.push([...range, value])
    else additions.push(`${name}:${value}`)
  }
  let next = text
  for (const [start, end, value] of replacements.sort((a, b) => b[0] - a[0])) {
    next = next.slice(0, start) + value + next.slice(end)
  }
  if (additions.length) {
    if (next && !next.endsWith('\n')) next += '\n'
    next += additions.join('\n') + '\n'
  }

  const folder = dirname(file)
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const temporary = join(folder, '.' + randomUUID() + '.tmp')
  try {
    writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 })
    if (before) chmodSync(temporary, Number(before.mode & 0o777n))
    signal?.throwIfAborted()
    checkUnchanged()
    if (before) renameSync(temporary, file)
    else linkSync(temporary, file)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export function writeAgyArchive(directory, remoteId, archived, signal) {
  updateAnnotations(directory, remoteId, 'archiving', signal, fields => {
    if (fields.archived === archived) return
    const now = Date.now()
    const stamp = `{seconds:${Math.floor(now / 1000)} nanos:${(now % 1000) * 1_000_000}}`
    return [[fields.flag, 'archived', String(archived)], [fields.stamp, 'archival_status_timestamp', stamp]]
  })
}

export function writeAgyTitle(directory, remoteId, title, signal) {
  updateAnnotations(directory, remoteId, 'renaming', signal, fields => {
    if (fields.title !== title) return [[fields.titleRange, 'title', JSON.stringify(title)]]
  })
}
