import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNavigation } from './navigation.mjs'
import { createWorktreePrompt } from './worktree-prompt.mjs'

test('worktree first prompt retries in place and opens the configured session', async () => {
  const navigation = createNavigation(() => {}, null)
  const target = navigation.getSnapshot()
  let trees = 0
  let attempts = 0
  const actions = []
  const send = createWorktreePrompt('/repo', 'main', {
    async createWorktree() { trees++; return { path: '/tree' } },
    async createSession(engine, path, profileId) {
      assert.deepEqual([engine, path, profileId], ['codex', '/tree', 'account'])
      if (++attempts === 1) throw new Error('session unavailable')
      return { id: 'new', options: [] }
    },
    async sessionAction(id, action, data) {
      assert.equal(id, 'new')
      actions.push([action, data])
      if (action === 'prompt' && actions.length === 2) throw new Error('prompt rejected')
      return { id, options: [{ id: 'model', currentValue: 'selected' }] }
    },
  })
  const input = { engine: 'codex', profileId: 'account', options: [{ id: 'model', currentValue: 'selected' }],
    payload: { text: 'hello' }, navigation, target }
  await assert.rejects(send(input), /session unavailable/)
  await assert.rejects(send(input), /prompt rejected/)
  assert.equal(navigation.getSnapshot(), target)
  await send(input)
  assert.equal(navigation.getSnapshot().id, 'new')
  assert.equal(trees, 1)
  assert.equal(attempts, 2)
  assert.deepEqual(actions, [['configure', { id: 'model', value: 'selected' }], ['prompt', input.payload], ['prompt', input.payload]])
})
