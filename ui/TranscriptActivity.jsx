import { useState } from 'react'
import {
  DisclosureRow, IconApiOutlineRegular, IconBrowseOutlineRegular, IconChecklistOutlineRegular,
  IconEditOutlineRegular, IconFolderOpenRegular, IconGlobeOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular, IconThinkOutlineRegular,
  IconTrashOutlineRegular, MarkdownText, Tag, TerminalBlock,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fileUriReference, normalizeMarkdownFileUrls } from './chat-state.mjs'

export const toolIcons = {
  read: IconBrowseOutlineRegular,
  edit: IconEditOutlineRegular,
  write: IconEditOutlineRegular,
  delete: IconTrashOutlineRegular,
  search: IconSearchOutlineRegular,
  move: IconFolderOpenRegular,
  fetch: IconGlobeOutlineRegular,
  execute: IconApiOutlineRegular,
}

export function describeTool(tool, t) {
  const execution = tool.execution
  const locations = Array.isArray(tool.locations) ? tool.locations : []
  const Icon = toolIcons[tool.kind] ?? IconSparkleRegular
  const title = Object.hasOwn(toolIcons, tool.kind) ? t(`activity.${tool.kind}`) : tool.title || t('permission.tool')
  const legacyCommand = !execution && tool.kind === 'execute' && !locations.length && typeof tool.title === 'string'
  const command = legacyCommand ? tool.title.trim() : execution?.command?.trim() ?? ''
  const shell = /^(?:\/[^\s]+\/)?(bash|sh|zsh|fish)\s+-[a-z]*c\s+/.exec(command)
  const script = shell ? command.slice(shell[0].length).replace(/^(['"])([\s\S]*)\1$/, '$2') : command
  const lines = script.split('\n').map(line => line.trim()).filter(Boolean)
  const preview = lines.find(line => !/^(?:cd\s|[A-Za-z_][A-Za-z0-9_]*=)/.test(line)) || lines[0] || ''
  const detailedCommand = Boolean(command && (shell || lines.length > 1 || command.length > 88))
  const summary = detailedCommand
    ? preview.slice(0, 84) + (preview.length > 84 || lines.length > 1 ? '…' : '')
    : command || tool.title
  return { execution, locations, Icon, title, command, detailedCommand, summary }
}

function FileLocation({ location, openFile, t }) {
  const raw = location?.path ?? location?.uri
  if (typeof raw !== 'string' || !raw) return null
  const uri = fileUriReference(raw)
  const path = uri?.path ?? raw
  const line = Number.isSafeInteger(location.line) && location.line > 0 ? location.line : uri?.line
  const label = line ? `${path}:${line}` : path
  return <button type="button" className="dchat-tool-path" title={label}
    aria-label={t('file.open', { path: label })}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); openFile(path, { line }) }}>{label}</button>
}

function withOutputTail(head, tail, omission) {
  if (tail === undefined) return head
  const before = head && !head.endsWith('\n') ? '\n' : ''
  const after = tail.startsWith('\n') ? '' : '\n'
  return `${head ?? ''}${before}${omission}${after}${tail}`
}

export function CommandDetails({ execution, exitCode, running, failed, stopped, t }) {
  const { command, input, commandTruncated, inputTruncated, outputTruncated } = execution
  const omitted = t('activity.outputOmitted')
  const combined = withOutputTail(execution.output, execution.outputTail, omitted)
  const stdout = withOutputTail(execution.stdout, execution.stdoutTail, omitted)
  const stderr = withOutputTail(execution.stderr, execution.stderrTail, omitted)
  const splitOutput = combined === undefined && Boolean(stderr)
  const separator = stdout && !stdout.endsWith('\n') ? '\n' : ''
  const output = splitOutput
    ? `${stdout ? `${t('activity.stdout')}\n${stdout}${separator}` : ''}${t('activity.stderr')}\n${stderr}`
    : combined ?? stdout ?? stderr
  const labels = {
    commandLine: n => t('activity.commandLine', { n }),
    signal: signal => signal,
    exitCode: code => t('activity.exitCode', { code }),
    noExitCode: t('activity.noExitCode'),
    running: t('in_progress'),
    failed: t('failed'),
    done: t('completed'),
    copy: t('copy'),
    copied: t('copied'),
    noOutput: t(output === undefined ? 'activity.outputUnavailable' : 'activity.noOutput'),
    collapseAria: t('activity.collapseOutput'),
    collapse: t('activity.collapseOutput'),
    expandAria: n => t('activity.expandOutput', { n }),
    expand: n => t('activity.expandOutput', { n }),
  }
  return <>
    <TerminalBlock command={command ?? t('activity.commandUnavailable')} output={output}
      copyText={splitOutput && !running ? `${stdout ?? ''}${separator}${stderr}` : undefined}
      exitCode={exitCode} running={running} runStateDot={!stopped && (!failed || Boolean(exitCode))}
      maxLines={Infinity} labels={labels} className="dchat-flow-terminal" />
    {input && <div className="dchat-flow-input">
      <span>{t('activity.input')}</span>
      <pre>{input}</pre>
    </div>}
    {(commandTruncated || inputTruncated || outputTruncated) && <small className="dchat-flow-truncated">
      {[
        commandTruncated && t('activity.commandTruncated'),
        inputTruncated && t('activity.inputTruncated'),
        outputTruncated && t('activity.outputTruncated'),
      ].filter(Boolean).join(' · ')}
    </small>}
  </>
}

function ToolActivityRow({ tool, openFile, expandedTools, toggleExecution, t }) {
  const [localOpen, setLocalOpen] = useState(false)
  const { execution, locations, Icon, title, command, detailedCommand, summary } = describeTool(tool, t)
  const sharedDisclosure = execution && tool.toolCallId && toggleExecution
  const open = sharedDisclosure ? expandedTools?.has(tool.toolCallId) ?? false : localOpen
  const expandable = Boolean(execution || detailedCommand) || locations.length > 1
  const running = tool.status === 'in_progress' || tool.status === 'pending'
  const stopped = tool.status === 'cancelled' || tool.status === 'interrupted'
  const exitCode = !running && Number.isSafeInteger(execution?.exitCode) ? execution.exitCode : undefined
  const failed = tool.status === 'failed' || (exitCode !== undefined && exitCode !== 0)
  const status = running ? tool.status
    : stopped && execution ? 'activity.stopped'
    : failed ? 'failed'
    : execution && tool.status === 'completed' ? 'completed' : undefined
  return <DisclosureRow icon={<Icon size={14} />} title={title} running={running}
    open={open && expandable} expandable={expandable} expandOnRowClick={!execution || !locations.length}
    keepContentWhenOpen onToggle={() => sharedDisclosure ? toggleExecution(tool.toolCallId) : setLocalOpen(value => !value)}
    collapsedContent={<>
      {locations.length ? <>
        <span className="dchat-flow-separator" aria-hidden="true" data-shimmer-decoration>·</span>
        <FileLocation location={locations[0]} openFile={openFile} t={t} />
      </>
        : summary && summary !== title && <span className="dchat-flow-summary" title={summary}>{summary}</span>}
      {locations.length > 1 && <small className="dchat-flow-count">+{locations.length - 1}</small>}
      {exitCode !== undefined ? <Tag tone="neutral" className="dchat-flow-exit">
        {failed && <span className="dchat-flow-exit-dot" aria-hidden="true" />}
        {t('activity.exitCode', { code: exitCode })}
      </Tag> : status && <small className="dchat-flow-status" data-failed={failed || undefined}>{t(status)}</small>}
    </>}>
    {open && (execution
      ? <CommandDetails execution={execution} exitCode={exitCode} running={running} failed={failed} stopped={stopped} t={t} />
      : detailedCommand && <pre className="dchat-flow-command">{command}</pre>)}
    {locations.length > 1 && <ul className="dchat-flow-files">{locations.slice(1).map((location, index) =>
      <li key={index}><FileLocation location={location} openFile={openFile} t={t} /></li>)}</ul>}
  </DisclosureRow>
}

function ReasoningRow({ text, streaming, markdown, t }) {
  const [open, setOpen] = useState(false)
  const summary = text.trim().split('\n', 1)[0].replaceAll('**', '')
  return <DisclosureRow icon={<IconThinkOutlineRegular size={14} />} title={t('thought')} running={streaming}
    open={open} expandable expandOnRowClick onToggle={() => setOpen(value => !value)}
    collapsedContent={summary && <span className="dchat-flow-summary">{summary}</span>}>
    {open && <div className="dchat-flow-body">
      <MarkdownText {...markdown} text={normalizeMarkdownFileUrls(text)} streaming={streaming} variant="compact" />
    </div>}
  </DisclosureRow>
}

function PlanRow({ plan, t }) {
  const [open, setOpen] = useState(false)
  return <DisclosureRow icon={<IconChecklistOutlineRegular size={14} />} title={t('plan')}
    open={open} expandable expandOnRowClick onToggle={() => setOpen(value => !value)}>
    <ul className="dchat-flow-files">{plan.map((entry, index) =>
      <li key={index}>{entry.content} <small>{['pending','in_progress','completed','failed'].includes(entry.status) ? t(entry.status) : entry.status}</small></li>)}</ul>
  </DisclosureRow>
}

export function TranscriptActivity({ activity, openFile, streaming, markdown, expandedTools, toggleExecution, t }) {
  const { thought, plan, tools, steps } = activity
  const hasSteps = Array.isArray(steps) && steps.length > 0
  if (!thought && !plan.length && !tools.length && !hasSteps) return null
  return <div className="dchat-flow">
    {hasSteps ? steps.map((step, index) => {
      if (step.kind === 'thought') {
        const isTail = index === steps.length - 1
        return <ReasoningRow key={`thought-${index}`} text={step.text} streaming={streaming && isTail} markdown={markdown} t={t} />
      }
      if (step.kind === 'tool' && step.tool) {
        return <ToolActivityRow key={step.tool.toolCallId ?? `tool-${index}`} tool={step.tool} openFile={openFile}
          expandedTools={expandedTools} toggleExecution={toggleExecution} t={t} />
      }
      if (step.kind === 'plan' && step.entries?.length) {
        return <PlanRow key={`plan-${index}`} plan={step.entries} t={t} />
      }
      return null
    }) : <>
      {thought && <ReasoningRow text={thought} streaming={streaming} markdown={markdown} t={t} />}
      {tools.map((tool, index) => <ToolActivityRow key={tool.toolCallId ?? index} tool={tool} openFile={openFile}
        expandedTools={expandedTools} toggleExecution={toggleExecution} t={t} />)}
    </>}
    {plan.length > 0 && !steps?.some(step => step.kind === 'plan') && <PlanRow plan={plan} t={t} />}
  </div>
}
