export const ACCOUNT_REFRESH_MS = 60_000
const INITIAL_LOAD_DELAY = 1_000
const priority = { cached: 0, background: 1, revalidate: 2, refresh: 2 }
const empty = Object.freeze({ report: null, refreshing: false, failed: false })

export function accountReportKey(engine, profileId) {
  return engine && profileId ? JSON.stringify([engine, profileId]) : undefined
}

async function fetchUsage(sessionId, mode, profileId) {
  const params = new URLSearchParams()
  if (priority[mode] >= priority.refresh) params.set('refresh', '1')
  else if (mode === 'cached') params.set('cached', '1')
  if (profileId) params.set('profileId', profileId)
  const query = params.size ? '?' + params.toString() : ''
  const response = await fetch(`/api/direct-chat/sessions/${encodeURIComponent(sessionId)}/usage${query}`)
  if (!response.ok) throw new Error('Usage request failed')
  return response.json()
}

export function hasAccountLimits(report) {
  return report?.status === 'available' && Array.isArray(report.limits) && report.limits.length > 0
}

export function accountObservedAt(report) {
  return Number.isSafeInteger(report?.observedAt) && report.observedAt > 0 && report.observedAt <= 8.64e15
    ? report.observedAt : undefined
}

export function accountExpiresAt(report) {
  const observedAt = accountObservedAt(report)
  if (observedAt === undefined) return
  let expiresAt = observedAt + ACCOUNT_REFRESH_MS
  for (const limit of report.limits ?? []) {
    if (Number.isSafeInteger(limit?.resetsAt) && limit.resetsAt > observedAt) expiresAt = Math.min(expiresAt, limit.resetsAt)
  }
  return expiresAt
}

export function accountUsageStale(report, now = Date.now()) {
  return hasAccountLimits(report) && (report.stale === true || now >= accountExpiresAt(report))
}

export function createAccountReportStore(load = fetchUsage) {
  const entries = new Map()
  const getEntry = engine => {
    if (!entries.has(engine)) entries.set(engine, { snapshot: empty, listeners: new Set(), lastQueryAt: -Infinity })
    return entries.get(engine)
  }
  const publish = (entry, snapshot) => {
    entry.snapshot = snapshot
    for (const listener of entry.listeners) listener()
  }

  return {
    getSnapshot: engine => entries.get(engine)?.snapshot ?? empty,
    subscribe(engine, listener) {
      if (!engine) return () => {}
      const { listeners } = getEntry(engine)
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    request(engine, sessionId, mode, profileId) {
      const entry = getEntry(engine)
      if (entry.pending && priority[entry.pending.mode] >= priority[mode]) return entry.pending.work
      const now = Date.now()
      if ((mode === 'background' || mode === 'revalidate') && now - entry.lastQueryAt < ACCOUNT_REFRESH_MS) {
        const expiresAt = mode === 'revalidate' ? accountExpiresAt(entry.snapshot.report) : undefined
        if (!(expiresAt > entry.lastQueryAt && expiresAt <= now)) return Promise.resolve()
      }
      if (mode !== 'cached') entry.lastQueryAt = now
      const pending = { mode }
      entry.pending = pending
      pending.work = Promise.resolve().then(() => load(sessionId, mode, profileId)).then(response => {
        if (entry.pending !== pending) return
        const { report: previous, failed } = entry.snapshot
        const newer = (accountObservedAt(response) ?? 0) >= (accountObservedAt(previous) ?? 0)
        const refreshFailed = response?.refreshFailed === true
        const keepPrevious = response?.reason !== 'noSubscriptionQuota' && hasAccountLimits(previous) && (!hasAccountLimits(response) || !newer)
        entry.pending = null
        publish(entry, {
          report: keepPrevious ? previous : response,
          refreshing: false,
          failed: refreshFailed || (mode !== 'cached' && keepPrevious && !hasAccountLimits(response)) ||
            (failed && (keepPrevious || (mode === 'cached' && response?.stale === true))),
        })
      }, () => {
        if (entry.pending !== pending) return
        entry.pending = null
        publish(entry, { ...entry.snapshot, refreshing: false, failed: mode !== 'cached' || entry.snapshot.failed })
      })
      if (mode !== 'cached') publish(entry, { ...entry.snapshot, refreshing: true })
      return pending.work
    },
  }
}

export function observeAccountUsage(visibility, open, request, getReport) {
  let generation = 0
  let interval, initialLoad
  const pause = () => {
    generation++
    clearInterval(interval)
    clearTimeout(initialLoad)
  }
  const sync = () => {
    pause()
    if (visibility.hidden) return
    const current = generation
    if (open) void request('refresh')
    else void request('cached').then(() => {
      if (current !== generation || visibility.hidden) return
      const report = getReport()
      if (accountUsageStale(report)) void request('revalidate')
      else if (report?.reason !== 'noSubscriptionQuota' && !hasAccountLimits(report)) initialLoad = setTimeout(() => {
        if (!visibility.hidden && !hasAccountLimits(getReport())) void request('background')
      }, INITIAL_LOAD_DELAY)
    })
    interval = setInterval(() => {
      if (!visibility.hidden && getReport()?.reason !== 'noSubscriptionQuota' && (open || hasAccountLimits(getReport()))) void request('refresh')
    }, ACCOUNT_REFRESH_MS)
  }
  visibility.addEventListener('visibilitychange', sync)
  sync()
  return () => {
    pause()
    visibility.removeEventListener('visibilitychange', sync)
  }
}
