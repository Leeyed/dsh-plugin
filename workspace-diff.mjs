import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const maxBuffer = 2 * 1024 * 1024
const maxUntrackedFiles = 100
const maxContextLines = 20_000
const scopes = new Set(['uncommitted', 'unstaged', 'staged'])
const statusFor = { A: 'added', D: 'deleted', R: 'renamed' }
const layers = new Set(['interface', 'implementation', 'test'])
const gitPrefix = ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const selectors = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
]
const hunkStart = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const gitEscapes = { '\\': '\\\\', '"': '\\"', '\x07': '\\a', '\b': '\\b', '\t': '\\t', '\n': '\\n', '\v': '\\v', '\f': '\\f', '\r': '\\r' }

const fail = (status, message) => Object.assign(new Error(message), { status })
const digest = content => createHash('sha256').update(content).digest('hex').slice(0, 32)

async function git(cwd, args, signal, allowedExitCodes = []) {
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }
  for (const key of selectors) delete env[key]
  try {
    const { stdout } = await run('git', [...gitPrefix, ...args], {
      cwd, signal, env, timeout: 10_000, maxBuffer, encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    signal?.throwIfAborted()
    if (/not a git repository|must be run in a work tree/i.test(error.stderr)) throw fail(422, 'Not a Git worktree')
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw fail(413, 'Git changes exceed the diff limit')
    if (allowedExitCodes.includes(error.code)) return error.stdout ?? ''
    throw fail(409, 'Could not read Git worktree changes')
  }
}

async function comparison(cwd, scope, signal) {
  if (scope === 'unstaged') return []
  if (scope === 'staged') return ['--cached']
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal, [1])
  if (head.trim()) return ['HEAD']
  const format = (await git(cwd, ['rev-parse', '--show-object-format'], signal)).trim()
  if (format !== 'sha1' && format !== 'sha256') throw fail(409, 'Unsupported Git object format')
  return [createHash(format).update('tree 0\0').digest('hex')]
}

async function filterOverrides(cwd, signal) {
  const names = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], signal, [1])
  const drivers = new Set(names.split('\0').filter(key => /\.(clean|process|required)$/.test(key))
    .map(key => key.slice(0, key.lastIndexOf('.'))))
  return [...drivers].flatMap(driver => ['-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`])
}

// Git leaves spaces and UTF-8 in these headers and C-quotes control characters.
function patchPath(path) {
  const quoted = path.replace(/["\\\x00-\x1f\x7f]/g, char => gitEscapes[char] ?? '\\' + char.charCodeAt(0).toString(8).padStart(3, '0'))
  return quoted === path ? path : `"${quoted}"`
}

function patchHunks(text) {
  const hunks = []
  let active
  for (const line of text.split('\n')) {
    const match = hunkStart.exec(line)
    if (match) {
      const oldLines = Number(match[2] ?? 1)
      const newLines = Number(match[4] ?? 1)
      active = { oldStart: Number(match[1]) + (oldLines === 0 ? 1 : 0), oldLines,
        newStart: Number(match[3]) + (newLines === 0 ? 1 : 0), newLines, lines: [] }
      hunks.push(active)
    } else if (active && /^[ +\-\\]/.test(line)) {
      active.lines.push(line)
    }
  }
  return hunks
}

function trackedFiles(output) {
  if (!output) return []
  const boundary = output.indexOf('\0\0')
  if (boundary < 0) throw fail(409, 'Could not read Git diff records')
  const paths = output.slice(0, boundary).split('\0')
  const patches = new Map()
  for (const section of output.slice(boundary + 2).split(/^(?=diff --(?:git|cc|combined) )/m)) {
    if (!section.startsWith('diff --git ')) continue
    const header = section.split('\n', 1)[0]
    if (!patches.has(header)) patches.set(header, [])
    patches.get(header).push(section)
  }
  const files = new Map()
  for (let i = 0; i < paths.length;) {
    const metadata = paths[i++]
    const code = / ([A-Z])\d*$/.exec(metadata)?.[1]
    const before = paths[i++]
    const path = ['R', 'C'].includes(code) ? paths[i++] : before
    if (!code || !path || !before) throw fail(409, 'Could not read Git diff paths')
    // Combined conflict patches have no two-sided hunks. Keep the file in the list.
    const sections = patches.get(`diff --git ${patchPath('a/' + before)} ${patchPath('b/' + path)}`) ?? []
    if (files.has(path) && code === 'U') continue
    const binary = sections.some(section => /^(?:Binary files .* differ|GIT binary patch)/m.test(section))
    const hunks = binary ? [] : sections.flatMap(patchHunks)
    let additions = 0
    let deletions = 0
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith('+')) additions++
        if (line.startsWith('-')) deletions++
      }
    }
    files.set(path, { path, previousPath: code === 'R' ? before : null, status: statusFor[code] ?? 'modified',
      binary, oversized: false, untracked: false, additions, deletions, hunks,
      digest: digest(JSON.stringify([path, metadata, sections])) })
  }
  return [...files.values()]
}

function inside(root, path) {
  const name = relative(root, path)
  return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name)
}

async function inspectWorktreeFile(root, path, budget, signal) {
  signal?.throwIfAborted()
  const full = resolve(root, path)
  if (!inside(root, full)) return
  const stat = await lstat(full)
  if (stat.isSymbolicLink()) {
    // Git diffs the target string itself without following the link.
    if (!inside(root, await realpath(dirname(full)))) return
    const target = await readlink(full, { encoding: 'buffer' })
    return target.length <= budget ? { bytes: target } : { oversized: true }
  }
  if (!stat.isFile()) return
  const canonical = await realpath(full)
  if (!inside(root, canonical)) return
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const actual = await realpath(process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : canonical)
    if (!inside(root, actual)) return
    const current = await handle.stat()
    if (!current.isFile()) return
    if (current.size > budget) return { oversized: true }
    const bytes = Buffer.alloc(current.size + 1)
    let length = 0
    while (length < bytes.length) {
      signal?.throwIfAborted()
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    return length > current.size ? { oversized: true } : { bytes: bytes.subarray(0, length) }
  } finally { await handle.close() }
}

function diffText(bytes) {
  if (bytes && !bytes.subarray(0, 8000).includes(0)) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {}
  }
}

function addedFile(path, { bytes, oversized = false }) {
  const text = diffText(bytes)
  const binary = bytes !== undefined && text === undefined
  const lines = text ? text.split('\n') : []
  const ended = lines.at(-1) === ''
  if (ended) lines.pop()
  const additions = lines.length
  const hunks = additions ? [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: additions,
    lines: [...lines.map(line => '+' + line), ...(ended ? [] : ['\\ No newline at end of file'])] }] : []
  return { path, previousPath: null, status: 'added', binary, oversized, untracked: true, additions, deletions: 0, hunks,
    digest: digest(JSON.stringify([path, oversized, bytes ? digest(bytes) : ''])) }
}

async function untrackedFiles(cwd, output, budget, signal) {
  const paths = output.split('\0').filter(path => path && !path.endsWith('/'))
  const files = []
  for (const path of paths.slice(0, maxUntrackedFiles)) {
    const content = await inspectWorktreeFile(cwd, path, budget, signal).catch(error => {
      signal?.throwIfAborted()
      if (!['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(error.code)) throw error
    })
    if (!content) continue
    budget -= content.bytes?.length ?? 0
    files.push(addedFile(path, content))
  }
  return { files, omitted: Math.max(0, paths.length - maxUntrackedFiles) }
}

function defaultLayer(path) {
  if (/(?:^|\/)(?:tests?|__tests__|spec|e2e|testdata|__snapshots__|locales)\/|\.(?:test|spec)\.|_test\.go$|(?:^|\/)test_[^/]+\.py$|(?:lock\.ya?ml|\.lock|\.snap|package-lock\.json)$/.test(path)) return 'test'
  if (/(?:^|\/)(?:package\.json|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml)$|\.(?:d\.[cm]?ts|pyi|h|hpp|proto|graphql|thrift)$/.test(path)) return 'interface'
  return 'implementation'
}

async function classify(cwd, files, scope, signal) {
  const attributes = new Map()
  for (let i = 0; i < files.length; i += 64) {
    const paths = files.slice(i, i + 64).map(file => file.path)
    const args = ['check-attr', '-z', ...(scope === 'staged' ? ['--cached'] : []), 'dsh-review-layer', 'linguist-generated', '--', ...paths]
    const fields = (await git(cwd, args, signal)).split('\0')
    for (let j = 0; j + 2 < fields.length; j += 3) {
      const [path, attribute, value] = fields.slice(j, j + 3)
      if (!attributes.has(path)) attributes.set(path, {})
      attributes.get(path)[attribute] = value
    }
  }
  return files.map(file => {
    const attribute = attributes.get(file.path)
    const explicit = attribute?.['dsh-review-layer']
    const generated = ['set', 'true'].includes(attribute?.['linguist-generated'])
    return { ...file, layer: layers.has(explicit) ? explicit : generated ? 'test' : defaultLayer(file.path) }
  })
}

async function diffDirectory(cwd, scope, signal) {
  if (!scopes.has(scope)) throw fail(400, 'Unknown Git diff scope')
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw fail(422, 'No workspace directory selected')
  signal?.throwIfAborted()
  const directory = await realpath(cwd).catch(() => { throw fail(422, 'Workspace directory is unavailable') })
  if (!(await lstat(directory)).isDirectory()) throw fail(422, 'Workspace directory is unavailable')
  const inWorktree = await git(directory, ['rev-parse', '--is-inside-work-tree'], signal)
  if (inWorktree.trim() !== 'true') throw fail(422, 'Not a Git worktree')
  return directory
}

async function readDiff(directory, scope, signal) {
  const [range, overrides] = await Promise.all([comparison(directory, scope, signal), filterOverrides(directory, signal)])
  const diffArgs = [...overrides, '-c', 'core.quotePath=false', 'diff', '--raw', '-z', '--patch', '--no-ext-diff', '--no-textconv',
    '--no-color', '--relative', '-M', '--src-prefix=a/', '--dst-prefix=b/', '--submodule=short', '--ignore-submodules=dirty']
  const [patch, listed] = await Promise.all([
    git(directory, [...diffArgs, ...range, '--', '.'], signal),
    scope === 'staged' ? '' : git(directory, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], signal),
  ])
  const tracked = trackedFiles(patch)
  const untracked = await untrackedFiles(directory, listed, maxBuffer - Buffer.byteLength(patch), signal)
  return { base: null, files: await classify(directory, [...tracked, ...untracked.files], scope, signal), omitted: untracked.omitted }
}

export async function workspaceDiff(cwd, signal, scope = 'uncommitted') {
  return readDiff(await diffDirectory(cwd, scope, signal), scope, signal)
}

export async function workspaceDiffText(cwd, signal, scope, path, expectedDigest) {
  if (typeof path !== 'string' || isAbsolute(path) || path.split('/').some(part =>
    part === '' || part === '.' || part === '..' || part.includes('\0')) || !/^[a-f0-9]{32}$/.test(expectedDigest ?? '')) {
    throw fail(400, 'Invalid changed file reference')
  }
  const directory = await diffDirectory(cwd, scope, signal)
  const { files } = await readDiff(directory, scope, signal)
  const file = files.find(file => file.path === path)
  if (!file || file.digest !== expectedDigest) throw fail(409, 'The file diff changed. Refresh changes to read its context.')
  if (file.oversized) throw fail(413, 'The file exceeds the diff context limit')
  if (file.binary || file.status === 'deleted') throw fail(415, 'No text on the new side of this diff')
  // The relative index expression respects sessions rooted below the checkout root.
  let text
  if (scope === 'staged') {
    text = await git(directory, ['cat-file', 'blob', `:0:./${path}`], signal)
  } else {
    const content = await inspectWorktreeFile(directory, path, maxBuffer, signal).catch(error => {
      signal?.throwIfAborted()
      if (!['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code)) throw error
    })
    if (content?.oversized) throw fail(413, 'The file exceeds the diff context limit')
    text = diffText(content?.bytes)
  }
  if (text === undefined || text.includes('\0')) throw fail(415, 'No text on the new side of this diff')
  if (text.split('\n', maxContextLines + 2).length > maxContextLines + 1) throw fail(413, 'The file exceeds the diff context limit')
  return { text }
}
