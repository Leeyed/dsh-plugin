import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNavigation } from './navigation.mjs'

function localStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

function activeDraft(navigation) {
  const target = navigation.getSnapshot()
  return navigation.draftFor(target, target.engine)
}

test('sessions restore their own text, command and attachments after navigation', () => {
  const storage = localStorage()
  const navigation = createNavigation(() => {}, storage)
  const attachment = { id: 0, file: new Blob(['test']) }
  navigation.open('first')
  const first = activeDraft(navigation)
  first.setText('  first question\n')
  first.setCommand('plan')
  first.setAttachments([attachment])

  navigation.open('second')
  assert.equal(activeDraft(navigation).getSnapshot().text, '')
  activeDraft(navigation).setText('second question')
  navigation.open('first')
  assert.deepEqual(activeDraft(navigation).getSnapshot(), {
    text: '  first question\n', command: 'plan', attachments: [attachment], sending: false, error: '',
  })

  const reloaded = createNavigation(() => {}, storage)
  assert.equal(reloaded.getSnapshot().id, 'first')
  assert.deepEqual(activeDraft(reloaded).getSnapshot(), {
    text: '  first question\n', command: 'plan', attachments: [], sending: false, error: '',
  })
  reloaded.open('second')
  assert.equal(activeDraft(reloaded).getSnapshot().text, 'second question')
})

test('new-session drafts are independent for each engine and workspace', () => {
  const storage = localStorage()
  const navigation = createNavigation(() => {}, storage)
  navigation.open('existing')
  navigation.start('codex', '/one')
  const first = activeDraft(navigation)
  first.setText('codex one')
  first.setCommand('plan')
  navigation.start('claude', '/one')
  activeDraft(navigation).setText('claude one')
  navigation.start('codex', '/two')
  assert.equal(activeDraft(navigation).getSnapshot().text, '')
  activeDraft(navigation).setText('codex two')
  navigation.start('codex', '/one')
  assert.equal(activeDraft(navigation), first)

  const reloaded = createNavigation(() => {}, storage)
  assert.equal(reloaded.getSnapshot().engine, 'codex')
  assert.equal(reloaded.getSnapshot().cwd, '/one')
  assert.equal(activeDraft(reloaded).getSnapshot().text, 'codex one')
  assert.equal(activeDraft(reloaded).getSnapshot().command, 'plan')
  reloaded.start('claude', '/one')
  assert.equal(activeDraft(reloaded).getSnapshot().text, 'claude one')
  reloaded.start('codex', '/two')
  assert.equal(activeDraft(reloaded).getSnapshot().text, 'codex two')
})

test('a send stays pending across navigation and its receipt settles only that draft', () => {
  const storage = localStorage()
  const navigation = createNavigation(() => {}, storage)
  navigation.open('first')
  const first = activeDraft(navigation)
  const attachment = { id: 0, file: new Blob(['test']) }
  first.setText('send me')
  first.setCommand('plan')
  first.setAttachments([attachment])
  const reject = first.beginSend()
  navigation.open('second')
  const second = activeDraft(navigation)
  second.setText('keep me')
  navigation.open('first')
  assert.equal(activeDraft(navigation).getSnapshot().sending, true)
  assert.equal(activeDraft(navigation).beginSend(), undefined)
  reject(false, 'retry')
  assert.deepEqual(first.getSnapshot(), {
    text: 'send me', command: 'plan', attachments: [attachment], sending: false, error: 'retry',
  })
  const accept = first.beginSend()
  navigation.open('second')
  accept(true)
  assert.equal(first.getSnapshot().text, '')
  assert.equal(first.getSnapshot().command, null)
  assert.deepEqual(first.getSnapshot().attachments, [])
  assert.equal(second.getSnapshot().text, 'keep me')
  const reloaded = createNavigation(() => {}, storage)
  reloaded.open('first')
  assert.equal(activeDraft(reloaded).getSnapshot().text, '')
})

test('accepting a first message after navigation refreshes history without changing the current selection', () => {
  const refreshed = []
  const navigation = createNavigation(() => refreshed.push(true), localStorage())
  navigation.start('codex', '/one')
  const source = navigation.getSnapshot()
  const draft = activeDraft(navigation)
  draft.setText('first prompt')
  const accept = draft.beginSend()
  navigation.open('another')
  accept(true)
  navigation.open('created', source)
  assert.equal(navigation.getSnapshot().id, 'another')
  assert.equal(draft.getSnapshot().text, '')
  assert.equal(refreshed.length, 1)
})

test('new sessions default to the last created agent without being overwritten by browsing history', () => {
  const storage = localStorage()
  const navigation = createNavigation(() => {}, storage)
  assert.equal(navigation.getSnapshot().engine, undefined)

  navigation.start('codex', '/one')
  assert.equal(navigation.getSnapshot().engine, 'codex')

  // Browsing an existing session must not forget or overwrite the remembered engine.
  navigation.open('existing-claude-session')
  assert.equal(navigation.getSnapshot().id, 'existing-claude-session')

  navigation.start(undefined, '/two')
  assert.equal(navigation.getSnapshot().engine, 'codex')
  assert.equal(navigation.getSnapshot().cwd, '/two')

  // Explicit engine selection updates the remembered engine, and survives reload.
  navigation.start('agy', '/two')
  navigation.open('another-session')
  const reloaded = createNavigation(() => {}, storage)
  reloaded.start()
  assert.equal(reloaded.getSnapshot().engine, 'agy')

  // Deleting the active session falls back to the remembered engine when none is given.
  reloaded.open('doomed')
  reloaded.forget(new Set(['doomed']), { engine: 'claude' })
  assert.equal(reloaded.getSnapshot().engine, 'agy')
})

test('deleting a session removes its saved draft and ignores a late receipt', () => {
  const storage = localStorage()
  const navigation = createNavigation(() => {}, storage)
  navigation.open('deleted')
  const draft = activeDraft(navigation)
  draft.setText('old draft')
  const settle = draft.beginSend()
  navigation.forget(new Set(['deleted']), { engine: 'codex', cwd: '/one' })
  assert.equal(navigation.getSnapshot().id, undefined)
  settle(false, 'late error')
  assert.equal(draft.getSnapshot().error, '')
  const reloaded = createNavigation(() => {}, storage)
  assert.equal(reloaded.getSnapshot().id, undefined)
  reloaded.open('deleted')
  assert.equal(activeDraft(reloaded).getSnapshot().text, '')
})

test('native new-chat entry restores only an available preference and honors switching back', () => {
  const navigation = createNavigation(() => {}, localStorage())
  const engines = [{ id: 'claude' }, { id: 'codex' }]
  assert.equal(navigation.preferredEngine(engines), undefined)
  navigation.start('codex')
  navigation.open('claude-history')
  assert.equal(navigation.preferredEngine(engines), 'codex')
  assert.equal(navigation.preferredEngine([{ id: 'codex', status: { installed: false } }]), undefined)
  assert.equal(navigation.preferredEngine([]), undefined)
  navigation.selectNative()
  assert.equal(navigation.preferredEngine(engines), undefined)
})
