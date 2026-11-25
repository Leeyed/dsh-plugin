import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createForgeReviewDrafts } from './forge-review-drafts.mjs'

function fixture() {
  const stored = new Map()
  const events = new EventTarget()
  let id = 0
  const options = {
    events, newId: () => String(++id),
    storage: () => ({
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => stored.delete(key),
    }),
  }
  const source = { kind: 'local', scope: 'uncommitted', base: null, baseRef: null, commits: null }
  const comment = { path: 'src/app.js', startLine: 12, endLine: 13, side: 'R', hunk: '@@ -12,2 +12,2 @@\n- ...\n+ ...', body: 'Check this.' }
  return { stored, events, options, source, comment }
}

test('review drafts survive reload and keep their scope, session, path and captured lines', () => {
  const { options, source, comment } = fixture()
  const records = createForgeReviewDrafts('a', '/repo', options)
  assert.equal(records.save({ source, comment }), true)
  const reloaded = createForgeReviewDrafts('a', '/repo', options)
  const range = reloaded.fileComments(comment.path, source)
  assert.equal(range, reloaded.fileComments(comment.path, source))
  assert.deepEqual(range.threads[0].selection, { source, comment })
  assert.deepEqual(reloaded.fileComments(comment.path, { ...source, scope: 'staged' }).threads, [])
  assert.deepEqual(createForgeReviewDrafts('b', '/repo', options).getSnapshot().threads, [])
  assert.deepEqual(createForgeReviewDrafts('a', '/elsewhere', options).getSnapshot().threads, [])
  assert.equal(reloaded.editThread(range.threads[0].key, 'Reworded'), true)
  assert.deepEqual(reloaded.fileComments(comment.path, source).threads[0].selection.comment, { ...comment, body: 'Reworded' })
  assert.equal(reloaded.editThread(range.threads[0].key, null), true)
  assert.deepEqual(createForgeReviewDrafts('a', '/repo', options).getSnapshot().threads, [])
})

test('writes retain drafts added elsewhere and unreadable storage is preserved', () => {
  const { stored, options, source, comment } = fixture()
  const one = createForgeReviewDrafts('a', '/repo', options)
  const two = createForgeReviewDrafts('a', '/repo', options)
  one.save({ source, comment })
  two.save({ source, comment: { ...comment, body: 'Second.' } })
  assert.deepEqual(two.getSnapshot().threads.map(item => item.selection.comment.body), ['Check this.', 'Second.'])
  const key = [...stored.keys()][0]
  stored.set(key, 'bad storage')
  assert.equal(two.save({ source, comment }), false)
  assert.equal(two.getSnapshot().error, 'load')
  assert.equal(stored.get(key), 'bad storage')
})
