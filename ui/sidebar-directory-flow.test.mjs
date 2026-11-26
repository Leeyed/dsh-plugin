import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectSidebarDirectoryFlow, sidebarDirectorySlot } from './sidebar-directory-flow.mjs'

test('merged sidebar tracks the native directory picker and its injected services', () => {
  let winner, notify, mounted
  const slots = {
    entriesOfSlot(name) {
      assert.equal(name, 'sidebar.workspaces.directoryFlow')
      return winner ? [winner] : []
    },
    subscribe(name, fn) { notify = fn; return () => { notify = undefined } },
    register(options, component) {
      assert.equal(options.name, sidebarDirectorySlot)
      assert.equal(mounted, undefined)
      mounted = { options, component }
      return () => { mounted = undefined }
    },
  }
  const dispose = connectSidebarDirectoryFlow(slots)
  assert.equal(mounted, undefined)
  for (const kind of ['web', 'desktop']) {
    winner = { component: () => kind, inject: () => ({ kind }) }
    notify()
    assert.equal(mounted.component, winner.component)
    assert.equal(mounted.options.inject, winner.inject)
  }
  winner = undefined
  notify()
  assert.equal(mounted, undefined)
  dispose()
  assert.equal(notify, undefined)
})
