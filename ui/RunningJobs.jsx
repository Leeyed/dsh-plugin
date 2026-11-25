import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { JobListAction } from '@deepseek-ai/dsh-client-ui-jobs/src/client/JobListAction.tsx'
import { en as jobEn, zh as jobZh } from '@deepseek-ai/dsh-client-ui-jobs/src/client/locales.ts'
import { describeTool } from './TranscriptActivity.jsx'

const noTools = []

function withOutputTail(head, tail, omission) {
  if (tail === undefined) return head
  const before = head && !head.endsWith('\n') ? '\n' : ''
  const after = tail.startsWith('\n') ? '' : '\n'
  return `${head ?? ''}${before}${omission}${after}${tail}`
}

function toolOutputText(execution, command, detailedCommand, t) {
  if (!execution) return detailedCommand ? command : ''
  const omitted = t('activity.outputOmitted')
  const combined = withOutputTail(execution.output, execution.outputTail, omitted)
  const stdout = withOutputTail(execution.stdout, execution.stdoutTail, omitted)
  const stderr = withOutputTail(execution.stderr, execution.stderrTail, omitted)
  if (combined !== undefined) return combined
  if (stderr) {
    const separator = stdout && !stdout.endsWith('\n') ? '\n' : ''
    return `${stdout ? `${t('activity.stdout')}\n${stdout}${separator}` : ''}${t('activity.stderr')}\n${stderr}`
  }
  return stdout ?? ''
}

function toJobStatus(tool) {
  if (tool.status === 'pending' || tool.status === 'in_progress') return 'running'
  if (tool.status === 'cancelled' || tool.status === 'interrupted') return 'killed'
  const exitCode = Number.isSafeInteger(tool.execution?.exitCode) ? tool.execution.exitCode : undefined
  if (tool.status === 'failed' || (exitCode !== undefined && exitCode !== 0)) return 'failed'
  return 'completed'
}

function createJobTranslator(t) {
  const dict = t('panel') === '直接对话' ? jobZh : jobEn
  return (key, params) => {
    let text = dict[key] ?? jobEn[key] ?? key
    if (params) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value))
      }
    }
    return text
  }
}

export function RunningJobsAction({ sessionId, summary, t }) {
  const tools = summary?.tools ?? noTools
  const timestampsRef = useRef(new Map())
  const stopRef = useRef(summary?.stop)
  stopRef.current = summary?.stop
  const jobT = useMemo(() => createJobTranslator(t), [t])

  const snapshot = useMemo(() => {
    const now = Date.now()
    const timestamps = timestampsRef.current
    const rows = []
    const observed = {}

    tools.forEach((tool, index) => {
      const id = String(tool.toolCallId ?? `tool-${index}`)
      const status = toJobStatus(tool)
      const isRunning = status === 'running'
      let timing = timestamps.get(id)
      if (!timing) {
        timing = { startedAt: now }
        timestamps.set(id, timing)
      }
      if (!isRunning && timing.finishedAt === undefined) timing.finishedAt = now
      else if (isRunning && timing.finishedAt !== undefined) delete timing.finishedAt

      const { execution, locations, title, command, detailedCommand, summary: toolSummary } = describeTool(tool, t)
      const label = command || toolSummary || title || t('permission.tool')
      const exitCode = !isRunning && Number.isSafeInteger(execution?.exitCode) ? execution.exitCode : undefined
      const detail = isRunning
        ? (locations[0]?.path ?? locations[0]?.uri)
        : (exitCode !== undefined ? t('activity.exitCode', { code: exitCode }) : undefined)
      const text = toolOutputText(execution, command, detailedCommand, t)
      if (text || isRunning) observed[id] = { text }

      rows.push({
        id,
        kind: title,
        label,
        status,
        detail,
        startedAt: timing.startedAt,
        finishedAt: timing.finishedAt,
        output: { total: text.length },
      })
    })

    return {
      rows: sessionId ? { [sessionId]: rows } : {},
      observed,
    }
  }, [sessionId, tools, t])

  const storeRef = useRef({
    snapshot,
    listeners: new Set(),
  })
  useEffect(() => {
    storeRef.current.snapshot = snapshot
    for (const listener of storeRef.current.listeners) listener()
  }, [snapshot])

  const useJobs = useCallback(selector => useSyncExternalStore(
    listener => {
      storeRef.current.listeners.add(listener)
      return () => { storeRef.current.listeners.delete(listener) }
    },
    () => selector(storeRef.current.snapshot),
  ), [])

  const watchRows = useCallback(() => () => {}, [])
  const observe = useCallback(() => () => {}, [])
  const killJob = useCallback(async () => {
    if (!stopRef.current) return false
    stopRef.current()
    return true
  }, [])

  if (!sessionId) return null
  return <JobListAction sessionId={sessionId} useJobs={useJobs} watchRows={watchRows} observe={observe} killJob={killJob} t={jobT} />
}
