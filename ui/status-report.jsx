import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Button, IconRefreshOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { accountReportKey, accountObservedAt, createAccountReportStore, hasAccountLimits, observeAccountUsage } from './account-report.mjs'
import { accountLimitGroups, accountRemainingPercent } from './session-status.mjs'

const accountReports = createAccountReportStore()

export function useAccountReport(sessionId, engine, profileId, open) {
  const key = accountReportKey(engine, profileId)
  const subscribe = useCallback(listener => accountReports.subscribe(key, listener), [key])
  const getSnapshot = useCallback(() => accountReports.getSnapshot(key), [key])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const request = useCallback(mode => accountReports.request(key, sessionId, mode, profileId), [key, sessionId, profileId])
  const observedAt = accountObservedAt(snapshot.report)

  useEffect(() => {
    if (!key || !sessionId) return
    return observeAccountUsage(document, open, request, () => getSnapshot().report)
  }, [key, getSnapshot, open, request, sessionId])

  return { ...snapshot, observedAt, canRefresh: Boolean(key && sessionId),
    refresh: () => { if (key && sessionId && !document.hidden) void request('refresh') } }
}

export function useStatusReport(sessionId, kind, open) {
  const [report, setReport] = useState(null)
  const key = open && sessionId ? `${sessionId}/${kind}` : null
  useEffect(() => {
    setReport(null)
    if (!key) return
    const controller = new AbortController()
    fetch('/api/direct-chat/sessions/' + encodeURIComponent(sessionId) + '/' + kind, { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error()
        return response.json()
      })
      .then(data => { if (!controller.signal.aborted) setReport({ key, data }) })
      .catch(() => { if (!controller.signal.aborted) setReport({ key, data: { failed: true } }) })
    return () => controller.abort()
  }, [key, sessionId, kind])
  return key && report?.key === key ? report.data : null
}

function formatResetTime(resetsAt, t) {
  if (!Number.isFinite(resetsAt)) return null
  const date = new Date(resetsAt)
  const diffMs = resetsAt - Date.now()
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (diffMs > 0) {
    const totalMinutes = Math.max(1, Math.round(diffMs / 60_000))
    if (totalMinutes < 60) {
      return { text: t('status.accountResetInMinutes', { minutes: totalMinutes, time: timeStr }), full: date.toLocaleString() }
    }
    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    if (hours < 24) {
      return {
        text: t('status.accountResetInHours', { hours, minutes, time: timeStr }),
        full: date.toLocaleString(),
      }
    }
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' })
    return {
      text: t('status.accountResetInDays', { days, hours: remHours, time: `${dateStr} ${timeStr}` }),
      full: date.toLocaleString(),
    }
  }
  return { text: t('status.accountReset', { time: date.toLocaleString() }), full: date.toLocaleString() }
}

export function AccountReport({ account, t }) {
  const { report, refreshing, failed, observedAt, canRefresh, refresh } = account
  const date = observedAt === undefined ? undefined : new Date(observedAt)
  const hasLimits = hasAccountLimits(report)
  const status = refreshing ? 'status.accountRefreshing' : failed ? (hasLimits ? 'status.accountShowingOld' : 'status.accountFailed')
    : report?.reason === 'noSubscriptionQuota' ? 'status.noSubscriptionQuota'
    : !hasLimits ? (report ? 'status.accountUnavailable' : 'status.accountLoading') : undefined
  return <>
    <div className="dchat-quota-observation">
      {date && <time className="dchat-quota-meta" dateTime={date.toISOString()}>
        {t('status.accountObserved', { time: date.toLocaleString() })}
      </time>}
      <Tooltip label={t(refreshing ? 'status.accountRefreshing' : 'status.accountRefresh')} side="bottom">
        <Button size="sm" className="dchat-quota-refresh" aria-label={t('status.accountRefresh')}
          aria-disabled={!canRefresh || refreshing} onClick={() => { if (canRefresh && !refreshing) refresh() }}>
          <IconRefreshOutlineRegular size={15} aria-hidden="true" />
        </Button>
      </Tooltip>
    </div>
    {status && <p className="dchat-quota-status" role="status">{t(status)}</p>}
    {hasLimits && <AccountLimits limits={report.limits} t={t} />}
  </>
}

function AccountLimits({ limits, t }) {
  const groups = accountLimitGroups(limits)
  return <div className="dchat-quota-list">
    {groups.map(group => <div className="dchat-quota-item" key={group.key}>
      <div className="dchat-quota-title">
        <span className="dchat-quota-name">{group.name}</span>
      </div>
      <div className="dchat-quota-windows">
        {group.windows.map((limit, index) => {
          const remaining = accountRemainingPercent(limit.usedPercent)
          const tone = remaining === undefined ? 'normal' : remaining <= 10 ? 'critical' : remaining <= 25 ? 'warning' : 'normal'
          const reset = formatResetTime(limit.resetsAt, t)
          return <div className="dchat-quota-window" key={index} data-tone={tone}>
            <div className="dchat-quota-header">
              <span className="dchat-quota-window-label">
                {limit.windowLabel && <span className="dchat-quota-badge">{limit.windowLabel}</span>}
                {reset && <span className="dchat-quota-meta" title={reset.full}>{reset.text}</span>}
              </span>
              {remaining !== undefined && <span className="dchat-quota-percent">
                {t('status.accountRemaining', { value: remaining })}
              </span>}
            </div>
            {remaining !== undefined && <div className="dchat-quota-bar" aria-hidden="true">
              {remaining > 0 && <div className="dchat-quota-fill" style={{ width: `${remaining}%` }} />}
            </div>}
          </div>
        })}
      </div>
    </div>)}
  </div>
}
