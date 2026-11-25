import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import {
  Modal, IconChevronRightOutlineRegular, focusWithoutRing, IconDatabaseOutlineRegular, IconGaugeOutlineRegular, Tooltip, useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { formatDuration } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/StatsPills.tsx'
import { TurnUsagePanel } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/TurnUsagePanel.tsx'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/token-format.ts'
import pillStyles from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/StatsPills.module.css'
import dialogStyles from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/stat-dialog.module.css'
import { AccountReport, useAccountReport, useStatusReport } from './status-report.jsx'
import { modelAccountWindow, sessionStatus, transcriptCounts, turnTokenUsage } from './session-status.mjs'

const emptySettings = { getSnapshot: () => undefined, subscribe: () => () => {} }
const ringRadius = 5.5
const ringLength = 2 * Math.PI * ringRadius
const readingSlot = '\u0000'

const turnUsageLabels = {
  'message.turnUsage.title': 'status.lastTurn',
  'message.turnUsage.input': 'status.uncachedInput',
  'message.turnUsage.cacheRead': 'status.cacheRead',
  'message.turnUsage.cacheWrite': 'status.cacheWrite',
  'message.turnUsage.output': 'status.output',
  'message.turnUsage.cacheHit': 'status.cacheHit',
}

function exact(value, t) {
  return t('status.tokens', { value: formatExactTokens(value, t) })
}

function turnUsageTranslate(t, cacheSummary, key, params) {
  if (key === 'message.turnUsage.count') return t('status.tokens', { value: params.count })
  if (key === 'message.turnUsage.consumed') return [params.total, cacheSummary].filter(Boolean).join(' · ')
  if (key === 'message.turnUsage.reasoning') return t('status.reasoningSubset', { value: params.tokens })
  return t(turnUsageLabels[key] ?? key, params)
}

export function SessionStatus({ sessionId, engine, profileId, engineCapabilities, messages, model, modelName, effort, agentCount, createdAt, updatedAt, usage, metrics, settings = emptySettings, t }) {
  const subscribe = useCallback(listener => settings.subscribe(listener), [settings])
  const getSnapshot = useCallback(() => settings.getSnapshot()?.value?.performanceUsage === 'compact', [settings])
  const isCompact = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [open, setOpen] = useState(null)
  const contextReport = useStatusReport(sessionId, 'context', open === 'context' || open === 'summary')
  const account = useAccountReport(sessionId, engine, profileId, open === 'account' || open === 'summary')
  const accountWindow = modelAccountWindow(engine, model, modelName, account.report?.limits)
  const accountRemaining = accountWindow?.remaining
  const accountReading = accountRemaining === undefined ? t('status.account') : t('status.accountSummary', { value: accountRemaining })
  const accountTitle = accountRemaining === undefined ? undefined : [accountWindow.pool, accountWindow.window, t('status.accountRemaining', { value: accountRemaining })].filter(Boolean).join(' · ')
  const accountLabel = [t('status.account'), accountTitle].filter(Boolean).join(' · ')
  const status = sessionStatus(metrics, usage, engine, engineCapabilities)
  const speed = status.tps === undefined ? undefined
    : t('status.tps', { value: status.tps >= 10 ? Math.round(status.tps) : Math.round(status.tps * 10) / 10 })
  const history = useMemo(() => transcriptCounts(messages), [messages])
  const turns = history.turns
  const counts = turns > 0 ? t('status.turns', { value: turns }) : undefined
  const timeRows = [
    ['status.model', modelName || model],
    ['status.effort', effort],
    ['status.userTurns', turns || undefined],
    ['status.replies', history.replies || undefined],
    ['status.progressUpdates', history.commentary || undefined],
    ['status.toolCalls', history.tools || undefined],
    ['status.agentCount', agentCount || undefined],
    ['status.createdAt', createdAt > 0 ? new Date(createdAt).toLocaleString() : undefined],
    ['status.updatedAt', updatedAt > 0 ? new Date(updatedAt).toLocaleString() : undefined],
    ['status.elapsed', status.turnMs === undefined ? undefined : formatDuration(status.turnMs, t)],
    ['status.speed', speed],
  ].filter(([, value]) => value !== undefined)
  const totals = metrics?.sessionTokens
  const totalRows = [
    ['status.totalTokens', totals?.total], ['status.input', totals?.input],
    ['status.includedCacheRead', totals?.cacheRead], ['status.output', totals?.output],
    ['status.includedReasoning', totals?.reasoning],
  ].filter(([, value]) => Number.isSafeInteger(value) && value >= 0).map(([key, value]) => [key, exact(value, t)])
  const activityReadings = isCompact ? [speed ?? counts] : [counts, speed ?? (!counts && status.turnMs !== undefined ? formatDuration(status.turnMs, t) : undefined)]
  const cacheShare = status.cacheHit === undefined ? null : formatCacheHitPercent(status.cacheRead, status.input, 1)
  const cache = cacheShare === null ? undefined : `${cacheShare}%`
  const cacheSummary = cache && t('status.cacheSummary', { value: cache })
  const hasUsage = [status.input, status.output, status.cacheRead, status.cacheWrite, status.reasoning].some(value => value !== undefined)
  const tokenSummary = status.total !== undefined ? t('status.tokens', { value: formatTokens(status.total, t) })
    : status.output !== undefined ? t('status.outputSummary', { value: formatTokens(status.output, t) })
      : status.input !== undefined ? t('status.inputSummary', { value: formatTokens(status.input, t) }) : t('status.usage')
  const cumulativeSummary = totalRows.length && Number.isSafeInteger(totals.total)
    ? t('status.cumulativeSummary', { value: formatTokens(totals.total, t) }) : t('status.usage')
  const usageReadings = hasUsage ? (isCompact ? [cacheSummary ?? tokenSummary] : [tokenSummary, cacheSummary])
    : totalRows.length ? [cumulativeSummary] : []
  const hasActivity = activityReadings.some(Boolean)
  const showUsage = usageReadings.some(Boolean)
  const showContext = status.context !== undefined || Boolean(sessionId)
  const activityDialog = hasActivity && timeRows.length > 0
  const usageDialog = showUsage && (!isCompact || totalRows.length > 0)
  // Use the stand-alone DSH panel when it can represent every reading in the dialog.
  const nativeUsage = !isCompact && totalRows.length === 0 ? turnTokenUsage(status) : undefined
  const customUsageDialog = usageDialog && !nativeUsage

  useEffect(() => {
    setOpen(current => (
      (current === 'activity' && !activityDialog) || (current === 'usage' && !customUsageDialog) || (current === 'context' && !showContext)
        ? null : current
    ))
  }, [activityDialog, customUsageDialog, showContext])

  useEffect(() => {
    if (open !== 'summary') return
    const mobile = window.matchMedia('(width < 768px)')
    const resized = () => { if (!mobile.matches) setOpen(null) }
    mobile.addEventListener('change', resized)
    return () => mobile.removeEventListener('change', resized)
  }, [open])

  if (!hasActivity && !showUsage && !showContext && !sessionId) return null
  const select = key => ({
    open: open === key,
    onOpenChange: value => setOpen(current => value ? key : current === key ? null : current),
  })
  const summary = [speed, accountRemaining === undefined ? undefined : t('status.accountRemaining', { value: accountRemaining })].filter(Boolean)
  return <>
    <button type="button" className="dchat-mobile-stat-summary" aria-haspopup="dialog" aria-expanded={open === 'summary'}
      onClick={() => setOpen('summary')}>
      <IconGaugeOutlineRegular size={14} /><span>{t('status.title')}</span>
      {summary.length > 0 && <span className="dchat-mobile-stat-reading">{summary.join(' · ')}</span>}
      <IconChevronRightOutlineRegular size={12} />
    </button>
    <Modal className="dchat-mobile-stat-dialog" contentClassName="dchat-mobile-stat-content" open={open === 'summary'} onClose={() => setOpen(null)} title={t('status.title')} closeLabel={t('close')}>
      <div className="dchat-mobile-stat-details">
        {timeRows.length > 0 && <section><h3>{t('status.time')}</h3><StatDetails rows={timeRows} t={t} /></section>}
        {showUsage && <section><h3>{t('status.usage')}</h3>
          {hasUsage && <UsageDetails status={status} cache={cache} t={t} />}
          {totalRows.length > 0 && <><h4>{t('status.cumulativeUsage')}</h4><StatDetails rows={totalRows} t={t} /></>}
        </section>}
        {showContext && <section><h3>{t('status.context')}</h3><ContextDetails context={status.context} report={contextReport} t={t} /></section>}
        {sessionId && <section><h3>{t('status.account')}</h3><AccountReport account={account} t={t} /></section>}
      </div>
    </Modal>
    <div className="dchat-session-status" role="group" aria-label={t('status.title')}>
      {hasActivity && <StatusPill stat="activity" icon={<IconGaugeOutlineRegular />} readings={activityReadings}
        heading={t('status.time')} titleValue={counts} t={t} {...select('activity')}>
        {activityDialog && <StatDetails rows={timeRows} t={t} />}
      </StatusPill>}
      {nativeUsage ? <span className="dchat-native-usage" data-composer-stat="usage" onClickCapture={() => setOpen(null)}>
        <TurnUsagePanel usage={nativeUsage} t={(key, params) => turnUsageTranslate(t, cacheSummary, key, params)} />
      </span> : showUsage && <StatusPill stat="usage" icon={<IconDatabaseOutlineRegular />} readings={usageReadings}
        heading={t('status.usage')} titleValue={status.total === undefined ? undefined : exact(status.total, t)} t={t} {...select('usage')}>
        {usageDialog && <>
          {hasUsage && <UsageDetails status={status} cache={cache} t={t} />}
          {totalRows.length > 0 && <>
            <h3 className="dchat-stat-subheading">{t('status.cumulativeUsage')}</h3>
            <StatDetails rows={totalRows} t={t} />
          </>}
        </>}
      </StatusPill>}
      {showContext && <ContextPill context={status.context} report={contextReport} {...select('context')} t={t} />}
      {sessionId && <StatusPill stat="account" icon={<IconGaugeOutlineRegular />}
        readings={[accountReading]}
        fullLabel={accountLabel} heading={t('status.account')} titleValue={accountTitle} t={t} {...select('account')}>
        <AccountReport account={account} t={t} />
      </StatusPill>}
    </div>
  </>
}

function UsageDetails({ status, cache, t }) {
  const output = status.output === undefined ? undefined : <>
    {exact(status.output, t)}
    {status.reasoning !== undefined && <span className={dialogStyles.reasoning}>
      {t('status.reasoningSubset', { value: exact(status.reasoning, t) })}
    </span>}
  </>
  const counts = [
    [status.uncachedInput === undefined ? 'status.input' : 'status.uncachedInput', status.uncachedInput ?? status.input],
    ['status.cacheRead', status.cacheRead],
    ['status.cacheWrite', status.cacheWrite > 0 ? status.cacheWrite : undefined],
    ['status.reasoning', status.output === undefined ? status.reasoning : undefined],
  ].filter(([, value]) => value !== undefined).map(([label, value]) => [label, exact(value, t)])
  return <StatDetails t={t} rows={[
    ['status.scope', t('status.lastTurn')],
    ...cache ? [['status.cacheHit', cache]] : [],
    ...counts,
    ...output ? [['status.output', output]] : [],
  ]} />
}

function StatDetails({ rows, t }) {
  return <dl className={`${dialogStyles.details} dchat-stat-details`}>
    {rows.map(([label, value]) => <Fragment key={label}>
      <dt>{t(label)}</dt><dd>{value}</dd>
    </Fragment>)}
  </dl>
}

function ContextRing({ percent }) {
  return <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <circle className="dchat-context-track" cx="7" cy="7" r={ringRadius} />
    {percent > 0 && <circle className="dchat-context-fill" cx="7" cy="7" r={ringRadius}
      strokeDasharray={`${ringLength * percent / 100} ${ringLength}`} transform="rotate(-90 7 7)" />}
  </svg>
}

function contextReading(context, report, t) {
  const used = context?.used ?? report?.used
  const size = context?.size ?? report?.size
  const percent = Number.isFinite(used) && size > 0 ? Math.min(100,Math.round(100 * used / size)) : undefined
  const estimated = context?.used !== undefined ? context?.estimated : report?.estimated
  const usedCompact = used === undefined ? undefined : `${estimated ? '~' : ''}${formatTokens(used, t)}`
  const sizeCompact = size === undefined ? undefined : formatTokens(size, t)
  return { used, size, percent, estimated, usedCompact, sizeCompact }
}

function ContextPill({ context, report, t, ...popover }) {
  const { percent, usedCompact, sizeCompact } = contextReading(context, report, t)
  const reading = percent !== undefined ? `${percent}%`
    : usedCompact !== undefined ? t('status.usedSummary', { value: usedCompact }) : sizeCompact !== undefined ? t('status.windowSummary', { value: sizeCompact }) : t('status.context')
  const label = percent === undefined ? undefined : t('status.contextUsedPercent', { percent: reading })
  return <StatusPill stat="context" icon={<ContextRing percent={percent} />} readings={[reading]} fullLabel={label}
    heading={t('status.context')} t={t} {...popover}>
    <ContextDetails context={context} report={report} t={t} />
  </StatusPill>
}

function ContextDetails({ context, report, t }) {
  const { used, size, percent, estimated, usedCompact, sizeCompact } = contextReading(context, report, t)
  const reading = percent === undefined ? undefined : `${percent}%`
  const [before = '', after = ''] = t('status.contextUsedPercent', { percent: readingSlot }).split(readingSlot).map(part => part.trim())
  const request = report?.requestTokens
  const requestRows = [
    ['status.input', request?.input], ['status.includedCacheRead', request?.cacheRead],
    ['status.includedCacheWrite', request?.cacheWrite], ['status.output', request?.output],
    ['status.includedReasoning', request?.reasoning],
  ].filter(([, value]) => Number.isFinite(value)).map(([key, value]) => [key, exact(value, t)])
  const contextRows = [
    ['status.contextModel', report?.model],
    ['status.readingSource', report?.source === 'lastRequest' ? t('status.requestTokens') : report?.source === 'native' ? t('status.nativeSummary') : undefined],
    ['status.contextUsed', used === undefined ? undefined : `${estimated ? '~' : ''}${exact(used, t)}`],
    ['status.contextWindow', size === undefined ? undefined : exact(size, t)],
    ['status.contextRemaining', used !== undefined && size >= used ? `${estimated ? '~' : ''}${exact(size - used, t)}` : undefined],
  ].filter(([, value]) => value !== undefined)
  return <>
    {percent !== undefined ? <>
      <div className="dchat-context-heading">
        <span>{before}</span><strong>{reading}</strong><span>{after}</span>
        <strong className="dchat-context-figures" title={`${exact(used, t)} / ${exact(size, t)}`}>
          {usedCompact} / {sizeCompact}
        </strong>
      </div>
      <div className="dchat-context-bar" aria-hidden="true">
        {percent > 0 && <div style={{ width: `${percent}%` }} />}
      </div>
    </> : null}
    {contextRows.length > 0 && <StatDetails t={t} rows={contextRows} />}
    {report?.categories?.length > 0 && <>
      <h3 className="dchat-stat-subheading">{t('status.contextBreakdown')}</h3>
      <dl className={`${dialogStyles.details} dchat-stat-details`}>{report.categories.map((item,i)=><Fragment key={i}>
        <dt>{item.name}</dt><dd>{exact(item.tokens,t)}</dd></Fragment>)}</dl>
    </>}
    {requestRows.length > 0 && <>
      <h3 className="dchat-stat-subheading">{t('status.requestTokens')}</h3>
      <StatDetails t={t} rows={requestRows} />
    </>}
    {used === undefined && size === undefined && !report?.categories?.length && <small role="status">{t(report ? 'status.contextUnavailable' : 'status.accountLoading')}</small>}
  </>
}

function StatusPill({ stat, icon, readings, fullLabel, heading, titleValue, children, open, onOpenChange, t }) {
  const trigger = useRef(null)
  const panel = useRef(null)
  const id = useId()
  const hasDialog = Boolean(children)
  const expanded = hasDialog && open
  const context = stat === 'context'
  const hoverable = context || stat === 'account'
  const hoverTimer = useRef(null)
  const transient = useRef(false)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const hover = hoverable ? {
    onPointerEnter(event) {
      if (event.pointerType !== 'mouse') return
      clearTimeout(hoverTimer.current)
      if (event.currentTarget.parentElement?.querySelector('.dchat-native-usage [aria-expanded="true"]')) return
      if (!expanded) hoverTimer.current = setTimeout(() => { transient.current=true; onOpenChange(true) }, 220)
    },
    onPointerLeave() {
      clearTimeout(hoverTimer.current)
      if (transient.current) hoverTimer.current=setTimeout(() => {transient.current=false; onOpenChange(false)}, 220)
    },
  } : {}
  const segments = readings.filter(Boolean)
  const label = fullLabel ?? segments.join(' · ')
  useDismissOnOutsidePointer(trigger, expanded, onOpenChange, panel)
  useLayoutEffect(() => {
    const anchor = trigger.current
    const dialog = panel.current
    if (!expanded || !anchor || !dialog) return
    const margin = 12
    const place = () => {
      const rect = anchor.getBoundingClientRect()
      const { offsetWidth, offsetHeight } = dialog
      const inset = parseFloat(getComputedStyle(dialog).getPropertyValue('--dsh-frame-overlay-top')) || margin
      const topLimit = Math.max(margin, inset)
      const bottomLimit = Math.max(topLimit, window.innerHeight - offsetHeight - margin)
      const above = rect.top - offsetHeight - 8
      const below = rect.bottom + 8
      const top = above < topLimit && below <= bottomLimit ? below : above
      dialog.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - offsetWidth - margin))}px`
      dialog.style.top = `${Math.max(topLimit, Math.min(top, bottomLimit))}px`
    }
    place()
    if (!transient.current) focusWithoutRing(dialog, { preventScroll: true })
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined
    observer?.observe(dialog)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      observer?.disconnect()
    }
  }, [expanded])
  useEffect(() => {
    if (!expanded) return
    const escape = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (panel.current?.contains(document.activeElement) || document.activeElement === trigger.current) {
        event.preventDefault()
        trigger.current?.focus({ preventScroll: true })
      }
      transient.current=false
      onOpenChange(false)
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [expanded, onOpenChange])

  const content = <>{icon}<span className={pillStyles.label}>
    {segments[0]}{segments[1] && <><span className={pillStyles.sep} aria-hidden="true">·</span>{segments[1]}</>}
  </span></>
  return <span className={`${pillStyles.anchor} dchat-stat-anchor`} data-composer-stat={stat} {...hover}>
    <Tooltip label={label} side="top" delayMs={200} portal onlyWhenClipped={!hoverable} openOnClick={!hasDialog} disabled={expanded}>
      {hasDialog ? <button className={`${pillStyles.pill} dchat-stat-pill`} type="button" ref={trigger} aria-label={label}
        aria-haspopup="dialog" aria-expanded={expanded} aria-controls={expanded ? id : undefined}
        onClick={() => { clearTimeout(hoverTimer.current); if (transient.current && expanded) { transient.current=false; focusWithoutRing(panel.current, {preventScroll:true}) } else { transient.current=false; onOpenChange(!expanded) } }}>{content}</button>
        : <span className={`${pillStyles.pill} dchat-stat-pill`}>{content}</span>}
    </Tooltip>
    {expanded && createPortal(<div className={`${dialogStyles.panel} dchat-stat-panel`} data-stat-panel={stat} onPointerEnter={() => clearTimeout(hoverTimer.current)} id={id} ref={panel}
      role="dialog" aria-label={heading} tabIndex={-1}>
      {(!context || fullLabel === undefined) && <>
        <div className={dialogStyles.title}>
          <span className={dialogStyles.titleLabel}>{icon}{heading}</span>{titleValue !== undefined && <span className={dialogStyles.titleValue}>{titleValue}</span>}
        </div>
        <div className={dialogStyles.titleRule} aria-hidden="true" />
      </>}
      {children}
    </div>, document.body)}
  </span>
}

export const sessionStatusCopy = {
  en: {
    'status.account':'Account usage','status.accountLoading':'Loading…','status.accountFailed':'Could not read usage.',
    'status.noSubscriptionQuota': 'This authentication configuration does not provide a CLI subscription quota.',
    'status.accountUnavailable':'The CLI has no account quota to report for this session.','status.accountRemaining':'{value}% left',
    'status.accountSummary':'{value}%',
    'status.accountObserved':'Checked {time}', 'status.accountRefresh':'Refresh', 'status.accountRefreshing':'Refreshing…',
    'status.accountShowingOld':'Refresh failed. Showing the last reading.',
    'status.accountReset':'Resets {time}','status.contextUnavailable':'No context reading yet.',
    'status.accountResetInMinutes': 'Resets in {minutes}m ({time})',
    'status.accountResetInHours': 'Resets in {hours}h {minutes}m ({time})',
    'status.accountResetInDays': 'Resets in {days}d {hours}h ({time})',
    'status.title': 'Performance & usage',
    'status.time': 'Session statistics',
    'status.cumulativeSummary': '{value} cumulative tokens', 'status.cumulativeUsage': 'Session token totals', 'status.totalTokens': 'Total',
    'status.model': 'Current model', 'status.effort': 'Reasoning effort', 'status.userTurns': 'User messages',
    'status.replies': 'Assistant replies', 'status.progressUpdates': 'Progress updates', 'status.toolCalls': 'Recorded tool calls',
    'status.agentCount': 'Subagents', 'status.createdAt': 'Created', 'status.updatedAt': 'Last updated',
    'status.usage': 'Token usage',
    'status.elapsed': 'Last turn time',
    'status.speed': 'Last turn average output speed (TPS)',
    'duration.compactSeconds': '{seconds}s',
    'duration.compactMinutes': '{minutes}m{seconds}s',
    'status.tps': '{value} tok/s',
    'status.tokens': '{value} tok',
    'status.outputSummary': '{value} tok output',
    'status.inputSummary': '{value} tok input',
    'number.groupSeparator': ',', 'number.thousand': '{value}K', 'number.million': '{value}M',
    'status.scope': 'Scope',
    'status.lastTurn': 'Last completed turn',
    'status.input': 'Input',
    'status.uncachedInput': 'Uncached input',
    'status.output': 'Output',
    'status.cacheRead': 'Cache read',
    'status.cacheWrite': 'Cache write',
    'status.reasoning': 'Reasoning',
    'status.reasoningSubset': ' (including {value} reasoning)',
    'status.cacheHit': 'Cache hit',
    'status.cacheSummary': 'Cache hit {value}',
    'status.turns': '{value} turns',
    'status.context': 'Context usage',
    'status.contextUsedPercent': '{percent} of context used',
    'status.contextUsed': 'Context used',
    'status.contextWindow': 'Context window',
    'status.usedSummary': '{value} used',
    'status.windowSummary': '{value} window',
    'status.readingSource': 'Reading source', 'status.nativeSummary': 'CLI context summary',
    'status.contextRemaining': 'Remaining context', 'status.contextModel': 'Model',
    'status.contextBreakdown': 'Context breakdown', 'status.requestTokens': 'Last model request',
    'status.includedCacheRead': 'Of input: cache read', 'status.includedCacheWrite': 'Of input: cache write',
    'status.includedReasoning': 'Of output: reasoning',
  },
  zh: {
    'status.account':'账户用量','status.accountLoading':'读取中…','status.accountFailed':'用量读取失败。',
    'status.noSubscriptionQuota': '当前认证配置不提供 CLI 订阅额度。',
    'status.accountUnavailable':'此会话的 CLI 未提供账户额度。','status.accountRemaining':'剩余 {value}%','status.accountReset':'{time} 重置',
    'status.accountSummary':'{value}%',
    'status.accountObserved':'采集于 {time}', 'status.accountRefresh':'刷新', 'status.accountRefreshing':'刷新中…',
    'status.accountShowingOld':'刷新失败，显示上次采集的用量。',
    'status.accountResetInMinutes': '{minutes} 分钟后重置 ({time})',
    'status.accountResetInHours': '{hours} 小时 {minutes} 分后重置 ({time})',
    'status.accountResetInDays': '{days} 天 {hours} 小时后重置 ({time})',
    'status.contextUnavailable':'暂无上下文读数。',
    'status.title': '性能与用量',
    'status.readingSource': '读数来源', 'status.nativeSummary': 'CLI 上下文摘要',
    'status.contextRemaining': '剩余上下文', 'status.contextModel': '模型',
    'status.contextBreakdown': '上下文组成', 'status.requestTokens': '最近一次模型请求',
    'status.includedCacheRead': '输入中命中缓存', 'status.includedCacheWrite': '输入中写入缓存',
    'status.includedReasoning': '输出中的推理',
    'status.time': '会话统计',
    'status.cumulativeSummary': '累计 {value} Token', 'status.cumulativeUsage': '会话累计 Token', 'status.totalTokens': '总计',
    'status.model': '当前模型', 'status.effort': '推理档位', 'status.userTurns': '用户消息',
    'status.replies': '助手回复', 'status.progressUpdates': '过程更新', 'status.toolCalls': '已记录的工具调用',
    'status.agentCount': '子代理', 'status.createdAt': '创建时间', 'status.updatedAt': '最近更新',
    'status.usage': 'Token 用量',
    'status.elapsed': '上一轮耗时',
    'status.speed': '上一轮平均输出速度（TPS）',
    'duration.compactSeconds': '{seconds}秒',
    'duration.compactMinutes': '{minutes}分{seconds}秒',
    'status.tps': '{value} tok/s',
    'status.tokens': '{value} tok',
    'status.outputSummary': '输出 {value} tok',
    'status.inputSummary': '输入 {value} tok',
    'number.groupSeparator': ',', 'number.thousand': '{value}K', 'number.million': '{value}M',
    'status.scope': '统计范围',
    'status.lastTurn': '上一完成轮',
    'status.input': '输入',
    'status.uncachedInput': '未缓存输入',
    'status.output': '输出',
    'status.cacheRead': '缓存读取',
    'status.cacheWrite': '缓存写入',
    'status.reasoning': '推理',
    'status.reasoningSubset': '（其中推理 {value}）',
    'status.cacheHit': '缓存命中',
    'status.cacheSummary': '缓存命中 {value}',
    'status.turns': '{value} 轮',
    'status.context': '上下文用量',
    'status.contextUsedPercent': '上下文已用 {percent}',
    'status.contextUsed': '上下文已用',
    'status.contextWindow': '上下文窗口',
    'status.usedSummary': '已用 {value}',
    'status.windowSummary': '窗口 {value}',
  },
}
