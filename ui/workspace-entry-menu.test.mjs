import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceEntryMenu } from './workspace-entry-menu.mjs'

function fixture(t, { desktop = false, saveAs = false, available = true, file = 'dir/a #&.bin', directory = false } = {}) {
  const calls = []
  const bytes = Uint8Array.of(0, 240, 159, 255)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url.pathname, '/api/direct-chat/sessions/test%2Fid/download')
    assert.equal(url.searchParams.get('path'), file)
    assert.equal(options.credentials, 'same-origin')
    calls.push(options.method ?? 'GET')
    return new Response(options.method === 'HEAD' ? null : bytes, { status: available ? 200 : 404 })
  })
  globalThis.document = { baseURI: 'https://dsh.test/', documentElement: { dataset: { platform: 'linux' } } }
  t.after(() => { delete globalThis.document })
  const saved = []
  const notifications = []
  const menu = workspaceEntryMenu({
    session: {
      async canOpenWorkspacePath() { return { ok: true, value: desktop } },
      async workspacePathApplications() { return { ok: true, value: [{ default: true, name: 'Viewer', id: 'viewer' }] } },
      async openWorkspacePath(request) { calls.push(request); return { ok: true } },
    },
    fileActions: {
      canSaveAs: saveAs,
      async save(source, mode) { saved.push({ mode, source }); return { status: 'requested' } },
      async copyImage(source) { saved.push({ mode: 'copy', source }) },
    },
    pathLabel: (key, params) => params?.app ?? key, fileLabel: key => key,
    writeClipboard: async path => { calls.push(path); return true }, notify: (...args) => notifications.push(args),
  })
  const absolutePath = file ? '/work/' + file : '/work'
  const items = menu.resolve({
    sessionId: 'test/id', absolutePath, entry: { path: file, name: file.split('/').at(-1), directory },
    openIn: (path, destination) => calls.push([path, destination]),
  }, new AbortController().signal)
  return { items, calls, notifications, saved, absolutePath, bytes }
}

test('web file actions open each destination and download the original', async t => {
  const { items, calls, saved, bytes } = fixture(t)
  const actions = await items
  assert.deepEqual(actions.map(a => a.id), ['sidebar', 'float', 'reveal', 'open', 'copyPath', 'download'])
  assert.ok(actions.find(a => a.id === 'reveal').disabled)
  assert.ok(actions.find(a => a.id === 'open').disabled)
  for (const id of ['sidebar', 'float', 'copyPath', 'download']) await actions.find(a => a.id === id).run()
  assert.deepEqual(calls, ['HEAD', ['dir/a #&.bin', 'sidebar'], ['dir/a #&.bin', 'float'], '/work/dir/a #&.bin'])
  assert.equal(saved[0].source.name, 'a #&.bin')
  const blob = await saved[0].source.read(new AbortController().signal)
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes)
})

test('desktop image has copy, download and save-as plus associated application and reveal', async t => {
  const { items, calls, saved, absolutePath } = fixture(t, { desktop: true, saveAs: true, file: '目录/A.PNG' })
  const actions = await items
  assert.deepEqual(actions.map(a => a.id), ['sidebar', 'float', 'reveal', 'open', 'copyPath', 'copyImage', 'download', 'saveAs'])
  assert.equal(actions.find(a => a.id === 'open').label, 'Viewer')
  for (const id of ['open', 'reveal', 'copyImage', 'download', 'saveAs']) await actions.find(a => a.id === id).run()
  assert.deepEqual(calls, ['HEAD', { path: absolutePath, application: 'viewer' }, { path: absolutePath, action: 'reveal' }])
  assert.deepEqual(saved.map(s => s.mode), ['copy', 'download', 'saveAs'])
  assert.equal((await saved[0].source.read(new AbortController().signal)).type, 'image/png')
})

test('unavailable desktop file keeps copy path, offers save-as and disables reads', async t => {
  const { items } = fixture(t, { desktop: true, saveAs: true, available: false })
  const actions = await items
  assert.deepEqual(actions.map(a => a.id), ['sidebar', 'float', 'reveal', 'open', 'copyPath', 'saveAs'])
  assert.deepEqual(actions.filter(a => !a.disabled).map(a => a.id), ['copyPath'])
})

for (const file of ['', 'dir/subdir']) {
  test('directory menu for ' + (file || 'root') + ' reveals and copies the directory itself', async t => {
    const { items, calls, absolutePath } = fixture(t, { desktop: true, directory: true, file })
    const actions = await items
    assert.deepEqual(actions.map(a => a.id), ['reveal', 'copyPath'])
    for (const action of actions) await action.run()
    assert.deepEqual(calls, [{ path: absolutePath, action: 'reveal' }, absolutePath])
  })
}
