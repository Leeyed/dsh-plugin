import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const maxBuffer = 2 * 1024 * 1024
const gitPrefix = ['--no-pager', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
const selectors = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE', 'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
]

const fail = (status, message) => Object.assign(new Error(message), { status })

function gitEnv(extra = {}) {
  const env = { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...extra }
  for (const key of selectors) delete env[key]
  return env
}

async function git(cwd, args, { signal, allowedExitCodes = [], timeout = 10_000, envExtra } = {}) {
  try {
    const { stdout } = await run('git', [...gitPrefix, ...args], {
      cwd, signal, env: gitEnv(envExtra), timeout, maxBuffer, encoding: 'utf8',
    })
    return { stdout, code: 0 }
  } catch (error) {
    signal?.throwIfAborted()
    if (allowedExitCodes.includes(error.code)) return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code }
    if (/not a git repository|must be run in a work tree/i.test(error.stderr ?? '')) throw fail(422, 'Not a Git worktree')
    throw fail(409, (error.stderr || error.message || 'Git command failed').trim())
  }
}

async function resolveDirectory(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null
  const directory = await realpath(cwd).catch(() => null)
  if (!directory) return null
  const stat = await lstat(directory).catch(() => null)
  return stat?.isDirectory() ? directory : null
}

async function filterOverrides(cwd, signal) {
  const { stdout } = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
    signal, allowedExitCodes: [1],
  })
  const drivers = new Set(stdout.split('\0').filter(key => /\.(clean|process|required)$/.test(key))
    .map(key => key.slice(0, key.lastIndexOf('.'))))
  return [...drivers].flatMap(driver => ['-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`])
}

/**
 * Inspect Git repository branch state for a workspace directory.
 */
export async function gitBranchInfo(cwd, signal) {
  const directory = await resolveDirectory(cwd)
  if (!directory) return { isGit: false }
  const top = await git(directory, ['rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
    signal, allowedExitCodes: [128],
  })
  if (top.code !== 0) return { isGit: false }
  const lines = top.stdout.trim().split(/\r?\n/)
  if (lines[0] !== 'true' || !lines[1]) return { isGit: false }
  const root = await realpath(lines[1]).catch(() => lines[1])

  const [branchRes, commitRes, refsRes] = await Promise.all([
    git(directory, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { signal, allowedExitCodes: [1, 128] }),
    git(directory, ['rev-parse', '--short', 'HEAD'], { signal, allowedExitCodes: [128] }),
    git(directory, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { signal, allowedExitCodes: [128] }),
  ])
  const current = branchRes.code === 0 ? branchRes.stdout.trim() || null : null
  const commit = commitRes.code === 0 ? commitRes.stdout.trim() || null : null
  const branches = refsRes.code === 0
    ? refsRes.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
    : []
  return { isGit: true, root, current, commit, branches }
}

/**
 * Create a new Git worktree and branch from `from` (or HEAD) under `<repoRoot>/.agents/worktrees/`.
 */
export async function createWorkspaceWorktree(cwd, from, signal) {
  const directory = await resolveDirectory(cwd)
  if (!directory) throw fail(422, 'Workspace directory is unavailable')
  const top = await git(directory, ['rev-parse', '--is-inside-work-tree', '--show-toplevel'], {
    signal, allowedExitCodes: [128],
  })
  const lines = top.stdout.trim().split(/\r?\n/)
  if (top.code !== 0 || lines[0] !== 'true' || !lines[1]) throw fail(422, 'Not a Git repository')
  const repositoryRoot = await realpath(lines[1])

  const baseRef = typeof from === 'string' && from.trim() ? from.trim() : 'HEAD'
  if (baseRef.startsWith('-')) throw fail(400, 'Invalid base branch')
  const commitRes = await git(repositoryRoot, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
    signal, allowedExitCodes: [1, 128],
  })
  const baseCommit = commitRes.stdout.trim()
  if (commitRes.code !== 0 || !baseCommit) {
    throw fail(409, baseRef === 'HEAD' ? 'Repository has no commits yet' : `Unknown base branch: ${baseRef}`)
  }

  const poolDir = join(repositoryRoot, '.agents', 'worktrees')
  await mkdir(poolDir, { recursive: true })
  try {
    const handle = await open(join(poolDir, '.gitignore'), 'wx', 0o644)
    try { await handle.writeFile('*\n', 'utf8') } finally { await handle.close() }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }

  const branch = `dsh-${randomUUID().replace(/-/g, '').slice(0, 8)}-${randomBytes(2).toString('hex')}`
  const targetPath = join(poolDir, branch)
  const overrides = await filterOverrides(repositoryRoot, signal)
  await git(repositoryRoot, [...overrides, 'worktree', 'add', '-b', branch, targetPath, baseCommit], {
    signal,
    timeout: 120_000,
    envExtra: { GIT_NO_LAZY_FETCH: '0' },
  })
  return {
    path: await realpath(targetPath),
    branch,
    baseCommit,
    repositoryRoot,
  }
}
