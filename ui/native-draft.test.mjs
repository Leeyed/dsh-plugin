import assert from 'node:assert/strict'
import test from 'node:test'
import { startDirectFromNative } from './native-draft.mjs'
import { createNavigation } from './navigation.mjs'

function nativeContext(getDraft) {
  const scope = {}
  const services = {
    uiSession: { adapter: { current: { getSnapshot: () => ({ key: 'native-session' }) } } },
    sessions: { scope(id) {
      assert.equal(id, 'native-session')
      return scope
    } },
    conversation: { input: { for(sessionScope) {
      assert.equal(sessionScope, scope)
      return { state: { getSnapshot: () => ({ draft: getDraft() }) } }
    } } },
  }
  return { get: key => services[key] }
}

test('copies the current native draft verbatim to the workspace selected by navigation', () => {
  const values = new Map()
  const storage = {
    getItem: key => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
  const navigation = createNavigation(() => {}, storage)
  navigation.rememberCwd('/remembered')
  navigation.open('previous-direct-session')
  const text = '  第一行\n\nsecond line\n'
  const ctx = nativeContext(() => {
    assert.equal(navigation.getSnapshot().id, 'previous-direct-session')
    return text
  })

  startDirectFromNative(ctx, navigation, 'codex')

  const target = navigation.getSnapshot()
  assert.equal(target.cwd, '/remembered')
  assert.equal(navigation.draftFor(target, 'codex').getSnapshot().text, text)
  assert.equal(navigation.draftFor({ cwd: '' }, 'codex').getSnapshot().text, '')
  const reloaded = createNavigation(() => {}, storage)
  assert.equal(reloaded.draftFor(reloaded.getSnapshot(), 'codex').getSnapshot().text, text)
})

test('preserves an existing destination draft and an in-progress submission', () => {
  const navigation = createNavigation(() => {}, null)
  const ctx = nativeContext(() => 'native draft')
  const cases = [
    ['codex', draft => draft.setText('already typed')],
    ['claude', draft => draft.setCommand('plan')],
    ['agy', draft => draft.setAttachments([{ id: 1 }])],
    ['custom', draft => draft.beginSend()],
  ]

  for (const [engine, prepare] of cases) {
    const composer = navigation.draftFor({ cwd: '/project' }, engine)
    prepare(composer)
    const existing = composer.getSnapshot()

    startDirectFromNative(ctx, navigation, engine, '/project')

    assert.equal(navigation.getSnapshot().engine, engine)
    assert.equal(composer.getSnapshot(), existing)
  }
})

test('opens the direct engine when a native session is absent', () => {
  const navigation = createNavigation(() => {}, null)
  const ctx = { get: () => undefined }

  startDirectFromNative(ctx, navigation, 'claude', '/project')

  const target = navigation.getSnapshot()
  assert.equal(target.engine, 'claude')
  assert.equal(navigation.draftFor(target, 'claude').getSnapshot().text, '')
})
