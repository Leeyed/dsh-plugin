import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createWorkspaceWorktree, gitBranchInfo } from '../server/workspace-worktree.mjs'

const run = promisify(execFile)

test('gitBranchInfo reports non-git and unborn repositories safely', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-info-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  assert.deepEqual(await gitBranchInfo(dir), { isGit: false })
  assert.deepEqual(await gitBranchInfo('relative/path'), { isGit: false })

  await run('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  const unborn = await gitBranchInfo(dir)
  assert.equal(unborn.isGit, true)
  assert.equal(unborn.current, 'main')
  assert.equal(unborn.commit, null)
  assert.deepEqual(unborn.branches, [])

  await assert.rejects(createWorkspaceWorktree(dir, 'main'), error => error.status === 409)
})

test('createWorkspaceWorktree creates an isolated worktree and branch from the chosen base', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wt-create-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const git = (...args) => run('git', args, { cwd: dir })

  await git('init', '-q', '-b', 'main')
  await git('config', 'user.name', 'Test User')
  await git('config', 'user.email', 'test@example.com')
  await writeFile(join(dir, 'README.md'), 'main\n')
  await git('add', 'README.md')
  await git('commit', '-qm', 'init')

  await git('checkout', '-qb', 'feature')
  await writeFile(join(dir, 'feature.txt'), 'feat\n')
  await git('add', 'feature.txt')
  await git('commit', '-qm', 'feature commit')
  await git('checkout', '-q', 'main')

  const info = await gitBranchInfo(dir)
  assert.equal(info.isGit, true)
  assert.equal(info.current, 'main')
  assert.ok(info.commit)
  assert.deepEqual(info.branches, ['feature', 'main'])

  const created = await createWorkspaceWorktree(dir, 'feature')
  assert.equal(created.repositoryRoot, await realpath(dir))
  assert.match(created.branch, /^dsh-[a-f0-9]{8}-[a-f0-9]{4}$/)
  assert.equal(existsSync(join(created.path, 'feature.txt')), true)
  assert.equal(existsSync(join(dir, 'feature.txt')), false)
  assert.equal(await readFile(join(dir, '.agents', 'worktrees', '.gitignore'), 'utf8'), '*\n')

  const wtInfo = await gitBranchInfo(created.path)
  assert.equal(wtInfo.current, created.branch)
})
