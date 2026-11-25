import assert from 'node:assert/strict'
import test from 'node:test'
import { archivedSessions } from './archive-settings.mjs'
import { groupSidebarSessions } from './sidebar-history.mjs'

test('lists archived CLI conversations across workspaces in recency order', () => {
  const older = { id: 'older', cwd: '/one', engine: 'claude', archived: true, archiveMode: 'legacy', updatedAt: 10 }
  const recent = { id: 'recent', cwd: '/two', engine: 'codex', archived: true, archiveMode: 'native', updatedAt: 20 }
  const unavailable = { id: 'external', engine: 'custom', archived: true, archiveMode: 'unsupported', createdAt: 15 }
  const active = { id: 'active', cwd: '/one', engine: 'codex', archived: false, updatedAt: 50 }
  const child = { id: 'child', engine: 'codex', archived: true, parentId: recent.id, updatedAt: 30 }
  const history = groupSidebarSessions([older, recent, unavailable, active, child])

  assert.deepEqual(archivedSessions(history), [recent, unavailable, older])
  assert.deepEqual(history.get('/one'), [active, older])
  assert.deepEqual(archivedSessions(new Map()), [])
})
