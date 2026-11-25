import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountReportKey, ACCOUNT_REFRESH_MS, accountUsageStale, createAccountReportStore, observeAccountUsage } from './account-report.mjs'

const reading = (usedPercent, observedAt, state = {}) => ({
  status: 'available', limits: [{ label: '5h', usedPercent }], observedAt, ...state,
})

test('engine cache serves another session immediately and deduplicates concurrent refreshes', async () => {
  const fresh = Promise.withResolvers()
  const cached = reading(31, 100)
  const updated = reading(58, 200)
  const calls = []
  const store = createAccountReportStore((session, mode) => {
    calls.push([session, mode])
    return mode === 'cached' ? cached : fresh.promise
  })
  await store.request('agy', 'session-a', 'cached')
  assert.equal(store.getSnapshot('agy').report, cached)
  assert.equal(store.getSnapshot('codex').report, null)
  const update = store.request('agy', 'session-b', 'refresh')
  assert.equal(update, store.request('agy', 'session-c', 'refresh'))
  assert.deepEqual(store.getSnapshot('agy'), { report: cached, refreshing: true, failed: false })
  fresh.resolve(updated)
  await update
  assert.deepEqual(calls, [['session-a', 'cached'], ['session-b', 'refresh']])
  assert.deepEqual(store.getSnapshot('agy'), { report: updated, refreshing: false, failed: false })
})

test('switching a session account isolates pending usage and passes the expected profile', async () => {
  const previous = Promise.withResolvers()
  const store = createAccountReportStore((session, mode, profile) => profile === 'work' ? reading(12, 20) : previous.promise)
  const personal = accountReportKey('agy', 'default')
  const work = accountReportKey('agy', 'work')
  const pending = store.request(personal, 'session', 'refresh', 'default')
  await store.request(work, 'session', 'refresh', 'work')
  previous.resolve(reading(75, 30))
  await pending
  assert.equal(store.getSnapshot(work).report.limits[0].usedPercent, 12)
  assert.equal(store.getSnapshot(personal).report.limits[0].usedPercent, 75)
  assert.equal(accountReportKey('agy', undefined), undefined)
})

test('a slow cache read cannot replace a new report and a failed refresh keeps the last observation', async () => {
  const cacheRead = Promise.withResolvers()
  const initial = reading(41, 200)
  let result = initial
  const store = createAccountReportStore((_, mode) => mode === 'cached' ? cacheRead.promise : result)
  const old = store.request('claude', 'a', 'cached')
  await store.request('claude', 'b', 'refresh')
  cacheRead.resolve(reading(30, 100))
  await old
  assert.equal(store.getSnapshot('claude').report, initial)

  const failure = reading(41, 200, { stale: true, refreshFailed: true })
  result = failure
  await store.request('claude', 'b', 'refresh')
  assert.deepEqual(store.getSnapshot('claude'), { report: failure, refreshing: false, failed: true })

  const disconnected = createAccountReportStore((_, mode) => {
    if (mode === 'refresh') throw new Error('offline')
    return initial
  })
  await disconnected.request('claude', 'a', 'cached')
  await disconnected.request('claude', 'b', 'refresh')
  assert.deepEqual(disconnected.getSnapshot('claude'), { report: initial, refreshing: false, failed: true })
})

test('opening an account uses the correct cached, background and forced usage requests', async ({ mock }) => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{}'))
  const store = createAccountReportStore()
  await store.request('agy', 'session/a', 'cached')
  await store.request('agy', 'session/a', 'background')
  await store.request('agy', 'session/b', 'background')
  await store.request('agy', 'session/a', 'refresh')
  assert.deepEqual(fetch.mock.calls.map(call => call.arguments[0]), [
    '/api/direct-chat/sessions/session%2Fa/usage?cached=1',
    '/api/direct-chat/sessions/session%2Fa/usage',
    '/api/direct-chat/sessions/session%2Fa/usage?refresh=1',
  ])
})

test('visibility pauses both deferred cache misses and periodic refreshes', async ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const visibility = Object.assign(new EventTarget(), { hidden: false })
  const toggleVisibility = hidden => {
    visibility.hidden = hidden
    visibility.dispatchEvent(new Event('visibilitychange'))
  }
  const calls = []
  const request = async mode => { calls.push(mode) }
  let report = null
  const stopClosed = observeAccountUsage(visibility, false, request, () => report)
  await Promise.resolve()
  mock.timers.tick(999)
  assert.deepEqual(calls, ['cached'])
  toggleVisibility(true)
  mock.timers.tick(ACCOUNT_REFRESH_MS)
  assert.deepEqual(calls, ['cached'])
  toggleVisibility(false)
  await Promise.resolve()
  mock.timers.tick(1000)
  assert.deepEqual(calls, ['cached', 'cached', 'background'])
  report = reading(41, Date.now())
  mock.timers.tick(ACCOUNT_REFRESH_MS)
  assert.deepEqual(calls, ['cached', 'cached', 'background', 'refresh'])
  stopClosed()

  const stopOpen = observeAccountUsage(visibility, true, request, () => report)
  assert.equal(calls.at(-1), 'refresh')
  assert.equal(calls.length, 5)
  mock.timers.tick(ACCOUNT_REFRESH_MS)
  assert.equal(calls.length, 6)
  toggleVisibility(true)
  mock.timers.tick(ACCOUNT_REFRESH_MS * 2)
  assert.equal(calls.length, 6)
  toggleVisibility(false)
  assert.equal(calls.length, 7)
  stopOpen()
  mock.timers.tick(ACCOUNT_REFRESH_MS)
  assert.equal(calls.length, 7)
})

test('visible cache revalidation checks both observation age and window rollover', async () => {
  const observedAt = Date.now() - 10_000
  const fresh = reading(50, observedAt)
  const expired = { ...fresh, limits: [{ label: '5h', usedPercent: 50, resetsAt: observedAt + 1 }] }
  assert.equal(accountUsageStale(fresh, observedAt + ACCOUNT_REFRESH_MS - 1), false)
  assert.equal(accountUsageStale(fresh, observedAt + ACCOUNT_REFRESH_MS), true)
  assert.equal(accountUsageStale(expired), true)
  const calls = []
  const visibility = Object.assign(new EventTarget(), { hidden: false })
  const stop = observeAccountUsage(visibility, false, async mode => { calls.push(mode) }, () => expired)
  try {
    await Promise.resolve()
    assert.deepEqual(calls, ['cached', 'revalidate'])
  } finally { stop() }
})

test('the first request after a window rollover can refresh within the per-engine cooldown', async ({ mock }) => {
  mock.timers.enable({ apis: ['Date'], now: 100_000 })
  const initial = { ...reading(80, 100_000), limits: [{ label: '5h', usedPercent: 80, resetsAt: 105_000 }] }
  const calls = []
  const store = createAccountReportStore((session, mode) => { calls.push([session, mode]); return initial })
  await store.request('codex', 'a', 'refresh')
  mock.timers.tick(5_001)
  await store.request('codex', 'b', 'revalidate')
  await store.request('codex', 'c', 'revalidate')
  assert.deepEqual(calls, [['a', 'refresh'], ['b', 'revalidate']])
})

test('an explicitly unsupported configuration clears a previous subscription reading', async () => {
  let response = reading(41, 100)
  const store = createAccountReportStore(() => response)
  await store.request('profile', 's', 'cached')
  response = {status:'unavailable', reason:'noSubscriptionQuota', refreshFailed:false, limits:[]}
  await store.request('profile', 's', 'refresh')
  assert.deepEqual(store.getSnapshot('profile'), {report:response, refreshing:false, failed:false})
})
