import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { nativeId } from '../server/native-history.mjs'

test('imported AGY session reloads newer native messages even while adapter is open, until web turns begin', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dchat-native-sync-'))
  const store = join(temp, 'direct-chat')
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = temp
  t.after(async () => {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    await rm(temp, { recursive: true, force: true })
  })

  const remoteId = randomUUID()
  const id = nativeId('agy', remoteId)
  const initialMessages = [
    { role: 'user', text: 'first prompt' },
    { role: 'assistant', text: 'first answer' },
  ]
  const entry = {
    id,
    remoteId,
    engine: 'agy',
    cwd: temp,
    title: 'Initial Title',
    nativeTitle: 'Initial Title',
    createdAt: 1000,
    updatedAt: 2000,
    archived: false,
    messages: initialMessages,
    metrics: { inputTokens: 10, outputTokens: 20 },
  }

  await mkdir(join(store, 'workspace-state'), { recursive: true })
  await mkdir(join(temp, 'engines'))
  await mkdir(join(temp, 'server'))
  await Promise.all([
    'index.mjs', 'engines/cli-admin.mjs',
    'server/agy-session-history.mjs', 'server/account-usage-cache.mjs', 'server/tool-activity.mjs',
    'server/workspace-file.mjs', 'server/workspace-worktree.mjs', 'server/workspace-diff.mjs', 'server/codex-commands.mjs',
  ].map(name => copyFile(new URL('../' + name, import.meta.url), join(temp, name))))

  await writeFile(join(temp, 'server', 'native-history.mjs'), `
    export { nativeId, nativeUuid, openNativeDatabase } from ${JSON.stringify(new URL('../server/native-history.mjs', import.meta.url).href)}
    export const entries = new Map(${JSON.stringify([[id, entry]])})
    export const nativeCatalog = () => ({
      async list() { return new Map(entries) },
      async refreshEngine() {},
      async children() { return [] },
      async metrics(item) { return item.metrics },
      async messages(item) { return item.messages },
    })
  `)
  await writeFile(join(temp, 'registry.mjs'), `
    export let settlePrompt
    async function start({ resumeId }) {
      return {
        id: resumeId,
        options: [],
        async close() {},
        prompt() {
          const p = Promise.withResolvers()
          settlePrompt = p.resolve
          return p.promise
        },
      }
    }
    const agy = { id: 'agy', label: 'Antigravity', start }
    const engines = new Map([[agy.id, agy]])
    export const createEngineRegistry = () => ({
      ready: Promise.resolve(),
      has: key => engines.has(key),
      get: key => engines.get(key),
      list: () => [...engines.values()],
    })
  `)

  const { apply } = await import(pathToFileURL(join(temp, 'index.mjs')))
  const historyMod = await import(pathToFileURL(join(temp, 'server', 'native-history.mjs')))
  const registry = await import(pathToFileURL(join(temp, 'registry.mjs')))
  const { call, openEvents, dispose } = mount(apply)
  t.after(dispose)

  // Initial load via GET + events opens the AGY adapter while keeping hasWebTurns false.
  const first = await call('GET', `/${id}`)
  assert.equal(first.status, 200)
  assert.equal(first.data.messages.length, 2)

  const stream = openEvents(id)
  t.after(() => stream.close())
  await new Promise(resolve => setTimeout(resolve, 40))

  // Simulate terminal AGY adding a new turn while the DSH adapter is open.
  const updatedEntry = {
    ...entry,
    updatedAt: 3000,
    nativeTitle: 'Updated Title',
    messages: [
      ...initialMessages,
      { role: 'user', text: 'terminal follow-up' },
      { role: 'assistant', text: 'terminal response' },
    ],
    metrics: { inputTokens: 30, outputTokens: 40 },
  }
  historyMod.entries.set(id, updatedEntry)

  const reloaded = await call('GET', `/${id}`)
  assert.equal(reloaded.status, 200)
  assert.equal(reloaded.data.messages.length, 4)
  assert.equal(reloaded.data.messages.at(-1).text, 'terminal response')
  assert.equal(reloaded.data.metrics.outputTokens, 40)
  assert.equal(reloaded.data.title, 'Updated Title')

  // Once a web turn occurs (hasWebTurns = true), native updates must not overwrite web messages.
  assert.equal((await call('POST', `/${id}/prompt`, { text: 'web prompt' })).status, 202)
  registry.settlePrompt({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))

  historyMod.entries.set(id, {
    ...updatedEntry,
    updatedAt: 4000,
    messages: [{ role: 'user', text: 'stale overwrite' }],
  })
  const afterWeb = await call('GET', `/${id}`)
  assert.equal(afterWeb.status, 200)
  assert.equal(afterWeb.data.messages.some(m => m.text === 'web prompt'), true)
  assert.equal(afterWeb.data.messages.some(m => m.text === 'stale overwrite'), false)
})

function mount(apply) {
  let dispatch, dispose
  apply({
    effect(fn) { dispose = fn() },
    connection: { admit() { return { peer: { principal: { kind: 'owner' } } } } },
    webServer: { register(route) { dispatch = route.handler; return () => {} } },
  })
  return {
    dispose,
    async call(method, suffix = '', body) {
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
        url: '/api/direct-chat/sessions' + suffix,
        method,
        headers: { 'content-type': 'application/json' },
      })
      const res = Object.assign(new EventEmitter(), {
        writeHead(status) { this.status = status },
        write() {},
        end(str) { this.data = str && JSON.parse(str) },
      })
      await dispatch(req, res)
      return res
    },
    openEvents(id) {
      const req = Object.assign(Readable.from([]), {
        url: `/api/direct-chat/sessions/${id}/events`,
        method: 'GET',
        headers: {},
      })
      const res = Object.assign(new EventEmitter(), {
        writeHead() {},
        write() {},
        end() {},
      })
      void dispatch(req, res)
      return { close() { res.emit('close') } }
    },
  }
}
