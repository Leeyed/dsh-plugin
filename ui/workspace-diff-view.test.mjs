import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendReviewQuote, createWorkspaceDiffController, workspaceSessionKey, workspaceTabMenuGroup } from './workspace-diff-view.mjs'

test('the open comparison follows the selected session and ignores a stale target release', () => {
  const diff = createWorkspaceDiffController()
  const first = { id: 'fixture-1', cwd: '/first' }
  const second = { id: 'fixture-2', cwd: '/second' }
  const releaseFirst = diff.bindTarget(first)
  diff.toggle()
  const releaseSecond = diff.bindTarget(second)
  releaseFirst()
  assert.deepEqual(diff.getSnapshot(), { open: true, view: 'changes', target: second, file: null, layoutSeat: false })
  releaseSecond()
  assert.deepEqual(diff.getSnapshot(), { open: true, view: 'changes', target: null, file: null, layoutSeat: false })
  diff.close()
  assert.deepEqual(diff.getSnapshot(), { open: false, view: 'changes', target: null, file: null, layoutSeat: false })
})

test('file previews open beside the active workspace and the files entry returns to its tree', () => {
  const panel = createWorkspaceDiffController()
  const target = { id: 'first', cwd: '/first' }
  panel.bindTarget(target)
  const requested = { path: 'src/main.ts', line: 18 }
  panel.openFile('unknown-session', requested)
  assert.equal(panel.getSnapshot().open, false)
  panel.openFile(target.id, requested)
  assert.deepEqual(panel.getSnapshot().file, { ...target, requested })
  assert.equal(panel.getSnapshot().view, 'files')
  assert.equal(panel.getSnapshot().open, true)
  panel.toggleFiles()
  assert.equal(panel.getSnapshot().file, null)
  assert.equal(panel.getSnapshot().open, true)
  panel.toggleFiles()
  assert.equal(panel.getSnapshot().open, false)
})

test('opening changes preserves the active file until the workspace changes', () => {
  const panel = createWorkspaceDiffController()
  const target = { id: 'first', cwd: '/first' }
  const release = panel.bindTarget(target)
  panel.openFile(target.id, { path: 'image.png', attachmentId: 'image' })
  panel.toggle()
  assert.equal(panel.getSnapshot().view, 'changes')
  assert.equal(panel.getSnapshot().file.requested.attachmentId, 'image')
  panel.bindTarget({ id: 'next', cwd: '/next' })
  release()
  assert.equal(panel.getSnapshot().file, null)
  assert.equal(panel.getSnapshot().target.id, 'next')
  panel.browseFiles()
  assert.equal(panel.getSnapshot().view, 'files')
  assert.equal(panel.getSnapshot().open, true)
})

test('review references preserve the existing draft and only reach the current target', () => {
  const panel = createWorkspaceDiffController()
  const format = index => `## User Comment ${index}\nCaptured hunk`
  let draft = 'Check this too.\n'
  const current = { id: 'first', cwd: '/first', addReviewToInput: quote => {
    draft = appendReviewQuote(draft, quote)
    return true
  } }
  const release = panel.bindTarget(current)
  assert.equal(panel.addReviewToInput(current, format), true)
  assert.equal(draft, 'Check this too.\n\n## User Comment 1\nCaptured hunk')
  assert.equal(panel.addReviewToInput(current, format), true)
  assert.ok(draft.endsWith('\n\n## User Comment 2\nCaptured hunk'))
  panel.bindTarget({ id: 'first', cwd: '/another' })
  assert.equal(panel.addReviewToInput(current, format), false)
  release()
  assert.ok(!draft.includes('User Comment 3'))
})

test('sidebar layouts are isolated by session and workspace', () => {
  const target = { id: 'session', cwd: '/first' }
  assert.equal(workspaceSessionKey({ ...target }), workspaceSessionKey(target))
  assert.notEqual(workspaceSessionKey({ ...target, cwd: '/second' }), workspaceSessionKey(target))
  assert.notEqual(workspaceSessionKey({ ...target, id: 'other' }), workspaceSessionKey(target))
  assert.notEqual(workspaceSessionKey(null), workspaceSessionKey(target))
})

test('tab menu bulk actions stay in the captured pane and ignore moved or closed tabs', () => {
  const surface = { layout: { nodes: {
    left: { tabs: ['first', 'selected', 'last'] },
    right: { tabs: ['terminal'] },
  } } }
  assert.deepEqual(workspaceTabMenuGroup(surface, 'left', 'selected'), { others: ['first', 'last'], right: ['last'] })
  assert.deepEqual(workspaceTabMenuGroup(surface, 'right', 'terminal'), { others: [], right: [] })
  assert.equal(workspaceTabMenuGroup(surface, 'right', 'selected'), null)
  assert.equal(workspaceTabMenuGroup(surface, 'left', 'closed'), null)
})
