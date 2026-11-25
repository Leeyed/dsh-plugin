import * as React from 'react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { DockLayout, activeDockPaneId, dockPaneIds, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit'
import * as Primitives from '@deepseek-ai/dsh-client-ui-primitives'
import {
  Button, FileTypeIcon, GuideArtworkBrowser, GuideArtworkFiles,
  IconGlobeOutlineRegular, IconListPenOutlineRegular, IconPanelLeftOutlineRegular, IconRefreshOutlineRegular, Input,
  PluginArtworkTerminal, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { GUIDE_KIND, pageAddress } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/contract/seed.ts'
import { dockLabels } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/labels.ts'
import { en as rightbarEn, zh as rightbarZh } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/locales.ts'
import panelStyles from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/shell/SidebarRight.module.css'
import { PanelChrome } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/shell/SidebarRight.tsx'
import { canCloseTab, createSidebarRightStore } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/stores.ts'
import { GuideBody } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tabs/guide/GuideBody.tsx'
import { GuideTitle } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tabs/guide/GuideTitle.tsx'
import { TerminalIcon } from '@deepseek-ai/dsh-client-ui-sidebar-terminal/src/client/TerminalIcon.tsx'
import { WorkspaceFiles, filesCopy } from './FilePreview.jsx'
import { ForgeChanges } from './ForgeChanges.jsx'
import { workspaceSessionKey, workspaceTabMenuGroup } from './workspace-diff-view.mjs'

export const workspaceDiffSlot = 'rightbar.direct-chat'

const workspaceTabTarget = 'direct-chat-tab'
const empty = []
const noMenuTarget = { subscribe: () => () => {}, getSnapshot: () => null }
const noContextMenu = () => ({ getTriggerProps: (_target, handlers) => handlers })
const guideFallback = (_seat, _props, { fallback }) => fallback
const selectEmpty = select => select(empty)
const selectFalse = select => select(false)

function resolveBuiltinTerminalChunkUrl(extraModules) {
  const boot = typeof window !== 'undefined' ? window.__DSH_BOOT__ : undefined
  const list = [
    ...(Array.isArray(boot?.entries) ? boot.entries : []),
    ...(Array.isArray(boot?.modules) ? boot.modules : []),
    ...(Array.isArray(extraModules) ? extraModules : []),
  ]
  const row = list.find(item => item?.id === '@deepseek-ai/dsh-client-ui-sidebar-terminal')
  if (!row?.url || !row?.rev) return null
  const marker = '/??'
  const start = row.url.indexOf(marker)
  if (start >= 0) {
    return `${row.url.slice(0, start)}/${row.id}/client.terminal.js?rev=${encodeURIComponent(row.rev)}`
  }
  return `plugins/${row.id}/client.terminal.js?rev=${encodeURIComponent(row.rev)}`
}

let terminalBodyPromise
function loadNativeTerminalBody(extraModules) {
  if (!terminalBodyPromise) {
    const url = resolveBuiltinTerminalChunkUrl(extraModules)
    terminalBodyPromise = (async () => {
      if (!url) throw new Error('Terminal runtime chunk URL not found')
      const response = await fetch(url, { credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const code = await response.text()
      let capturedFactory
      const loader = window.__ModuleLoader__
      const origLoad = loader?.load
      if (loader && typeof origLoad === 'function') {
        loader.load = spec => {
          capturedFactory = spec?.factory
        }
        try {
          new Function(code)()
        } finally {
          loader.load = origLoad
        }
      } else {
        const fakeWindow = new Proxy(window, {
          get(target, prop) {
            if (prop === '__ModuleLoader__') {
              return { load(spec) { capturedFactory = spec?.factory } }
            }
            const val = target[prop]
            return typeof val === 'function' ? val.bind(target) : val
          },
        })
        new Function('window', code)(fakeWindow)
      }
      if (typeof capturedFactory !== 'function') throw new Error('Invalid terminal runtime bundle')
      const mod = capturedFactory(spec => {
        if (spec === 'react') return React
        if (spec === 'react/jsx-runtime') return JsxRuntime
        if (spec === '@deepseek-ai/dsh-client-ui-primitives') return Primitives
        throw new Error(`Unsupported require in terminal runtime: ${spec}`)
      })
      if (typeof mod?.TerminalBody !== 'function') throw new Error('TerminalBody not exported')
      return mod.TerminalBody
    })().catch(error => {
      terminalBodyPromise = undefined
      throw error
    })
  }
  return terminalBodyPromise
}

export function WorkspaceDiff({ controller, t }) {
  const { open, view } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const changesLabel = t('diff.title')
  const sidebarLabel = t('files.sidebar')
  const changesOpen = open && view === 'changes'
  return <>
    <Tooltip label={changesLabel} side="bottom">
      <Button size="sm" className="dchat-diff-icon" aria-label={changesLabel} aria-pressed={changesOpen}
        aria-controls={changesOpen ? 'dchat-workspace-diff' : undefined} onClick={controller.toggle}>
        <IconListPenOutlineRegular size={16} />
      </Button>
    </Tooltip>
    <Tooltip label={sidebarLabel} side="bottom">
      <Button size="sm" className="dchat-files-icon" aria-label={sidebarLabel} aria-pressed={open}
        aria-controls={open ? 'dchat-workspace-diff' : undefined}
        onClick={() => open ? controller.close() : (controller.openGuide ? controller.openGuide() : controller.browseFiles())}>
        <IconPanelLeftOutlineRegular size={16} className="dchat-rightbar-toggle-icon" />
      </Button>
    </Tooltip>
  </>
}

function workspaceTabTitle(kind, t, requested) {
  switch (kind) {
    case GUIDE_KIND: return t('tab.guide.title')
    case 'files': return t('files.title')
    case 'changes': return t('diff.title')
    case 'terminal': return t('guide.terminalTabTitle')
    case 'browser': return t('guide.browserTitle')
    default: return requested?.path.split(/[/\\\\]/).at(-1) || t('files.preview')
  }
}

export function WorkspaceDiffPane({
  controller, layout, panelSource, panelId, width, viewportWidth, canShow, terminalHost, forgeT, t,
  contextMenus, useContextMenu = noContextMenu,
}) {
  const { open, view, file, target, layoutSeat } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { activePanelId } = useSyncExternalStore(panelSource.subscribe, panelSource.getSnapshot)
  const menuSource = contextMenus?.active ?? noMenuTarget
  const menuTarget = useSyncExternalStore(menuSource.subscribe, menuSource.getSnapshot)
  const { getTriggerProps } = useContextMenu()
  const [dock] = useState(() => createSidebarRightStore(() => ({ kind: GUIDE_KIND, title: '' })).create())
  const { bySession } = useSyncExternalStore(dock.subscribe, dock.getSnapshot)
  const [tabDetails, setTabDetails] = useState({})
  const [expanded, setExpanded] = useState(false)
  const previousView = useRef({})
  const titleId = useId()
  const fallback = layout === undefined
  const shown = open && activePanelId === panelId && (fallback ? !layoutSeat : layoutSeat)
  const autoFullscreen = !fallback && (!canShow || viewportWidth < 768)
  const fullscreen = !fallback && (expanded || autoFullscreen)
  const requestedFile = view === 'files' && target?.id === file?.id ? file?.requested : null
  const sessionKey = workspaceSessionKey(target)
  const surface = bySession[sessionKey]
  const dockLayout = surface?.layout
  const actions = dock.actions
  const readSurface = useCallback(() => dock.getSnapshot().bySession[sessionKey], [dock, sessionKey])

  const updateTabDetails = useCallback((tabId, patch) => {
    if (patch !== null && !readSurface()?.layout.tabs[tabId]) return
    const key = JSON.stringify([sessionKey, tabId])
    setTabDetails(current => {
      if (patch === null) {
        if (!(key in current)) return current
        const next = { ...current }
        delete next[key]
        return next
      }
      const previous = current[key] ?? {}
      if (Object.entries(patch).every(([name, value]) => previous[name] === value)) return current
      return { ...current, [key]: { ...previous, ...patch } }
    })
  }, [sessionKey, readSurface])

  const openTab = useCallback((kind, { paneId, replaceTab, requested } = {}) => {
    const current = readSurface()?.layout
    if (!current) return
    const pane = paneId ? getPane(current, paneId) : getPane(current, activeDockPaneId(current))
    const destination = pane.host === 'dock' ? pane : getPane(current, activeDockPaneId(current))
    const active = current.tabs[destination.activeTabId]
    const replace = replaceTab ?? (active?.kind === GUIDE_KIND ? active.id : undefined)
    let contentId = kind
    if (requested) contentId = requested.attachmentId ? 'attachment:' + requested.attachmentId : 'file:' + requested.path
    if (kind === 'terminal') {
      contentId = 'terminal:' + (globalThis.crypto?.randomUUID?.() ?? Date.now() + '-' + Math.random().toString(36).slice(2))
    }
    let openedTab
    actions.openContent(sessionKey, {
      kind, contentId, title: workspaceTabTitle(kind, t, requested),
      paneId: destination.id, replaceTab: replace,
      revealIfOpened: kind !== 'browser' && kind !== 'terminal',
    }, tabId => { openedTab = tabId })
    if (requested && openedTab) updateTabDetails(openedTab, { requested })
  }, [actions, sessionKey, readSurface, t, updateTabDetails])

  useLayoutEffect(() => {
    if (!shown) return
    const previous = previousView.current
    previousView.current = { sessionKey, view, requestedFile }
    const tabs = readSurface()?.layout.tabs
    const hadTabs = tabs !== undefined && Object.keys(tabs).length > 0
    actions.setExpanded(sessionKey, true)
    if (requestedFile) {
      if (!hadTabs || previous.requestedFile !== requestedFile) openTab('file', { requested: requestedFile })
    } else if ((view === 'changes' || view === 'files') && (!hadTabs ||
      (previous.sessionKey === sessionKey && (previous.view !== view || previous.requestedFile)))) {
      openTab(view)
    }
  }, [shown, view, requestedFile, sessionKey, readSurface, actions, openTab])

  useLayoutEffect(() => {
    if (shown && layout) layout.openRightbar(Boolean(canShow) && !autoFullscreen, fullscreen)
  }, [shown, canShow, autoFullscreen, fullscreen, layout])
  useLayoutEffect(() => {
    if (!shown || !layout) return
    return () => layout.closeRightbar()
  }, [shown, layout])


  const closeTab = useCallback(tabId => {
    const current = readSurface()
    if (!current || !canCloseTab(current, tabId)) return
    const tab = current.layout.tabs[tabId]
    actions.closeTab(sessionKey, tabId)
    updateTabDetails(tabId, null)
    if (tab.kind === 'terminal' && target?.id) {
      void fetch('/api/direct-chat/sessions/' + encodeURIComponent(target.id) + '/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'close', termId: tab.contentId }),
      }).catch(() => {})
    }
    if (!readSurface().layout.expanded) controller.close()
  }, [actions, controller, sessionKey, readSurface, target?.id, updateTabDetails])

  useEffect(() => {
    if (!shown || !contextMenus) return
    const dispose = contextMenus.register({
      id: 'direct-chat.tabs',
      target: workspaceTabTarget,
      order: 100,
      resolve: captured => {
        const getGroup = () => {
          const current = controller.getSnapshot()
          if (!current.open || workspaceSessionKey(current.target) !== captured.sessionKey || captured.sessionKey !== sessionKey) return null
          return workspaceTabMenuGroup(readSurface(), captured.paneId, captured.tabId)
        }
        const group = getGroup()
        if (!group) return []
        const closable = canCloseTab(readSurface(), captured.tabId)
        if (!closable && group.others.length === 0) return []
        const closeMany = property => {
          for (const id of getGroup()?.[property] ?? []) closeTab(id)
        }
        return [
          {
            id: 'close', label: t('menu.close'), icon: { key: 'sidebar.close' },
            disabled: !closable,
            run: () => { if (getGroup()) closeTab(captured.tabId) },
          },
          { id: 'others', label: t('menu.closeOthers'), disabled: group.others.length === 0, run: () => closeMany('others') },
          ...(group.right.length ? [{ id: 'right', label: t('menu.closeRight'), run: () => closeMany('right') }] : []),
        ]
      },
    })
    return () => {
      if (contextMenus.active.getSnapshot()?.kind === workspaceTabTarget) contextMenus.close()
      dispose()
    }
  }, [shown, contextMenus, controller, sessionKey, readSurface, closeTab, t])

  const panelRef = useRef(null)
  const [motion, setMotion] = useState(null)
  const activeSeat = activePanelId === panelId && (fallback ? !layoutSeat : layoutSeat)
  const phase = motion?.key === sessionKey ? motion.phase : null
  useLayoutEffect(() => {
    if (!activeSeat || !dockLayout) return
    if (shown && (phase === null || phase === 'closing')) {
      setMotion({ key: sessionKey, phase: 'opening' })
    } else if (!shown && phase && phase !== 'closing') {
      setMotion({ key: sessionKey, phase: 'closing' })
    }
  }, [activeSeat, Boolean(dockLayout), shown, sessionKey, phase])

  useLayoutEffect(() => {
    if (!activeSeat || !panelRef.current || !['opening', 'closing'].includes(phase)) return
    let current = true
    const slides = panelRef.current.getAnimations({ subtree: true }).filter(a => a.transitionProperty === 'transform')
    void Promise.allSettled(slides.map(a => a.finished)).then(() => {
      if (current) setMotion(phase === 'opening' ? { key: sessionKey, phase: 'open' } : null)
    })
    return () => { current = false }
  }, [activeSeat, phase, sessionKey])
  useEffect(() => {
    if (!shown && (!phase || !activeSeat)) setExpanded(false)
  }, [shown, phase, activeSeat])
  if (!activeSeat || !dockLayout || !phase) return null
  const close = controller.close
  const detailsFor = tabId => tabDetails[JSON.stringify([sessionKey, tabId])] ?? {}
  const duplicateTab = tabId => {
    const tab = dockLayout.tabs[tabId]
    if (!tab) return
    if (tab.kind === 'terminal') {
      openTab('terminal', { paneId: findTabPane(dockLayout, tabId).id })
      return
    }
    actions.duplicateTab(sessionKey, tabId)
    const copied = Object.keys(readSurface().layout.tabs).find(id => !dockLayout.tabs[id])
    if (copied) updateTabDetails(copied, detailsFor(tabId))
  }
  const guideEntries = [
    [ 'files', GuideArtworkFiles, 'files.title', 'guide.filesDesc' ],
    [ 'terminal', PluginArtworkTerminal, 'guide.terminalTitle', 'guide.terminalDesc' ],
    [ 'changes', IconListPenOutlineRegular, 'diff.title', 'guide.changesDesc' ],
    [ 'browser', GuideArtworkBrowser, 'guide.browserTitle', 'guide.browserDesc' ],
  ].map(([kind, icon, title, description]) => ({
    id: kind, kind, providerId: 'dsh-direct-chat', icon, title: () => t(title), description: () => t(description),
  }))
  const renderTabTitle = tab => {
    const details = detailsFor(tab.id)
    const title = details.title || workspaceTabTitle(tab.kind, t, details.requested)
    switch (tab.kind) {
      case GUIDE_KIND: return <GuideTitle useTabInfo={() => ({ tab: { title } })} />
      case 'files': return <><FileTypeIcon kind="folder" size={14} />{title}</>
      case 'changes': return <><IconListPenOutlineRegular size={14} />{title}</>
      case 'terminal': return <><TerminalIcon />{title}</>
      case 'browser': return <><IconGlobeOutlineRegular size={14} />{title}</>
      default: return <><FileTypeIcon path={details.requested?.path || ''} size={14} />{title}</>
    }
  }
  const renderTab = tab => {
    const details = detailsFor(tab.id)
    const paneId = findTabPane(dockLayout, tab.id).id
    switch (tab.kind) {
      case GUIDE_KIND:
        return <GuideBody useTabInfo={() => ({ tab: { actions: {
          openTab: kind => openTab(kind, { paneId, replaceTab: tab.id }),
          close: () => {
            // A reveal in another pane leaves this pane usable when it only has the guide.
            const current = readSurface().layout
            if (current.tabs[tab.id] && getPane(current, paneId).tabs.length > 1) closeTab(tab.id)
          },
        } } })} useGuideEntries={select => select(guideEntries)} useShortcuts={selectEmpty}
          useEntryPins={selectEmpty} useEntryActions={selectFalse}
          renderSlot={guideFallback} renderSlotChain={guideFallback} t={t} />
      case 'files':
        return <WorkspaceFiles target={target} selected={null} controller={controller} t={t} />
      case 'file':
        return details.requested && <WorkspaceFiles target={target} selected={details.requested}
          controller={{ ...controller, browseFiles: () => openTab('files', { paneId }) }} t={t} />
      case 'changes':
        return <ForgeChanges target={target} controller={controller} t={forgeT} onQuote={format => {
          if (!controller.addReviewToInput(target, format)) return false
          if (fullscreen || fallback) close()
          return true
        }} />
      case 'terminal':
        return <RightbarTerminal id={target?.id} termId={tab.contentId} initialCwd={target?.cwd} terminalHost={terminalHost}
          onTitle={title => updateTabDetails(tab.id, { title })}
          onReplaceTerminal={() => openTab('terminal', { paneId })} t={t} />
      case 'browser':
        return <RightbarBrowser tab={details} t={t} onNavigate={url => updateTabDetails(tab.id, { url })} />
      default:
        return null
    }
  }

  return <aside ref={panelRef} id="dchat-workspace-diff" className={panelStyles.panel + ' dchat-diff-pane'}
    data-sidebar-right-open={shown || undefined} data-sidebar-right-opening={phase === 'opening' || undefined}
    data-sidebar-right-panel={fullscreen ? 'fullscreen' : 'push'} aria-hidden={!shown || undefined}
    data-fullscreen={fullscreen || undefined} data-fallback={fallback || undefined}
    style={{ width: fullscreen || fallback ? undefined : width, '--dsh-sidebar-width': fullscreen ? '100vw' : fallback ? 'min(480px, 100vw)' : width + 'px' }} aria-labelledby={titleId}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close()
    }}>
    <h2 id={titleId} className="dchat-diff-visually-hidden">{t('files.sidebar')}</h2>
    <div className={panelStyles.panelBody}><DockLayout key={sessionKey} state={dockLayout}
      canSplit={dockPaneIds(dockLayout).length < 2} dropZones="horizontal" minPaneFraction={0.2}
      canAddTab={paneId => !getPane(dockLayout, paneId).tabs.some(id => dockLayout.tabs[id].kind === GUIDE_KIND)}
      canCloseTab={tabId => canCloseTab(surface, tabId)}
      labels={dockLabels(t)} renderTab={renderTab} renderTabTitle={renderTabTitle}
      getTabTriggerProps={(tab, paneId, handlers) => getTriggerProps({
        kind: workspaceTabTarget, value: { sessionKey, paneId, tabId: tab.id },
      }, handlers)}
      tabMenuOpen={menuTarget?.kind === workspaceTabTarget && menuTarget.value.sessionKey === sessionKey}
      intents={{
        focusTab: tabId => actions.focusTab(sessionKey, tabId),
        focusPane: paneId => actions.focusPane(sessionKey, paneId),
        splitPane: paneId => actions.splitPane(sessionKey, paneId),
        addTab: paneId => actions.openContent(sessionKey, { kind: GUIDE_KIND, contentId: pageAddress(GUIDE_KIND), title: t('tab.guide.title'), paneId }, () => {}),
        closeTab,
        duplicateTab,
        placeTab: (tabId, paneId, index) => actions.placeTab(sessionKey, tabId, paneId, index),
        dropTab: (tabId, paneId, zone) => actions.dropTab(sessionKey, tabId, paneId, zone),
        floatTab: (tabId, rect) => actions.floatTab(sessionKey, tabId, rect),
        unfloatPane: paneId => actions.unfloatPane(sessionKey, paneId),
        moveFloat: (paneId, x, y) => actions.moveFloat(sessionKey, paneId, x, y),
        resizeFloat: (paneId, rect) => actions.resizeFloat(sessionKey, paneId, rect),
        resizeSplit: (splitId, sizes) => actions.resizeSplit(sessionKey, splitId, sizes),
      }}
      chrome={<PanelChrome sessionId={sessionKey} fullscreen={fullscreen} shortcuts={empty} t={t}
        actions={{ toggleExpanded: close }} toggleFullscreen={() => {
          if (autoFullscreen) close()
          else setExpanded(current => !current)
        }} />}
    /></div>
  </aside>
}

class TerminalErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      const msg = String(this.state.error?.message || this.state.error)
      const stack = typeof this.state.error?.stack === 'string'
        ? this.state.error.stack.split('\n').slice(0, 5).join('\n')
        : ''
      return <div className="dchat-preview-status" role="alert" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        <span>{msg}</span>
        {stack && <code style={{ fontSize: 11, opacity: 0.75 }}>{stack}</code>}
      </div>
    }
    return this.props.children
  }
}

function createPtyTerminalModel(sessionId, termId, initialCwd, onTitle) {
  const listeners = new Set()
  let revision = 0
  let source = null
  let state = {
    phase: 'connecting',
    writable: false,
    environment: {
      cwd: initialCwd || '~',
      maxInputBytes: 65536,
      maxCols: 500,
      maxRows: 200,
      scrollback: 1000,
    },
    info: undefined,
    render: undefined,
  }
  const notify = next => {
    state = next
    for (const listener of listeners) listener()
  }
  const connect = () => {
    if (!sessionId) return
    source?.close()
    notify({ ...state, phase: 'connecting', error: undefined })
    const query = new URLSearchParams({
      termId,
      cols: String(state.info?.cols || 80),
      rows: String(state.info?.rows || 24),
    })
    const es = new EventSource(`/api/direct-chat/sessions/${encodeURIComponent(sessionId)}/terminal?${query}`)
    source = es
    es.onmessage = ({ data }) => {
      try {
        const frame = JSON.parse(data)
        if (frame.type === 'snapshot') {
          if (frame.info?.title) onTitle?.(frame.info.title)
          const nextInfo = frame.info ?? state.info ?? {
            id: termId,
            title: 'bash',
            cwd: initialCwd || '~',
            cols: 80,
            rows: 24,
            state: 'running',
            exitCode: null,
          }
          notify({
            ...state,
            phase: 'connected',
            writable: nextInfo.state === 'running',
            environment: frame.environment ?? state.environment,
            info: nextInfo,
            render: {
              revision: ++revision,
              frame: { type: 'snapshot', screen: frame.screen || '', info: nextInfo },
            },
          })
        } else if (frame.type === 'output') {
          notify({
            ...state,
            phase: 'connected',
            render: {
              revision: ++revision,
              frame: { type: 'output', data: frame.data || '' },
            },
          })
        } else if (frame.type === 'state') {
          if (frame.info?.title) onTitle?.(frame.info.title)
          notify({
            ...state,
            info: frame.info ?? state.info,
            writable: frame.info?.state === 'running',
          })
        }
      } catch {}
    }
    es.onerror = () => {
      if (source === es) {
        es.close()
        source = null
        notify({ ...state, phase: 'disconnected', writable: false })
      }
    }
  }
  const post = payload => {
    if (!sessionId) return
    void fetch(`/api/direct-chat/sessions/${encodeURIComponent(sessionId)}/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ termId, ...payload }),
    }).catch(() => {})
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mount() {
      connect()
      return () => {
        source?.close()
        source = null
      }
    },
    connect,
    refresh: connect,
    write(data) {
      post({ action: 'write', data })
    },
    resize(cols, rows) {
      if (state.info && (state.info.cols !== cols || state.info.rows !== rows)) {
        state = { ...state, info: { ...state.info, cols, rows } }
      }
      post({ action: 'resize', cols, rows })
    },
    acknowledge() {},
  }
}

function RightbarTerminal({ id, termId, initialCwd, terminalHost, onTitle, onReplaceTerminal, t }) {
  const [NativeTerminalBody, setNativeTerminalBody] = useState(null)
  const [loadError, setLoadError] = useState('')
  const model = useMemo(() => createPtyTerminalModel(id, termId, initialCwd, onTitle), [id, termId])

  useEffect(() => {
    let active = true
    let modules
    try { modules = terminalHost?.getModules?.() } catch {}
    loadNativeTerminalBody(modules).then(
      Component => { if (active) setNativeTerminalBody(() => Component) },
      error => { if (active) setLoadError(error.message || 'Failed to load terminal') },
    )
    return () => { active = false }
  }, [terminalHost])

  const useTabInfo = useMemo(() => () => ({
    tab: {
      id: termId,
      visible: true,
      actions: {
        openTab: () => onReplaceTerminal?.(),
      },
    },
  }), [termId, onReplaceTerminal])

  const useTerminal = useMemo(() => (_id, selector) => {
    const snap = useSyncExternalStore(model.subscribe, model.getSnapshot)
    return typeof selector === 'function' ? selector(snap) : snap
  }, [model])

  const useTheme = useMemo(() => selector => {
    let hostTheme
    try { hostTheme = terminalHost?.getTheme?.() } catch {}
    if (hostTheme && hostTheme.fontFamilies && hostTheme.fontSizes) return selector(hostTheme)
    const dark = typeof document !== 'undefined' && document.body?.hasAttribute('data-ds-dark-theme')
    return selector({
      mode: dark ? 'dark' : 'light',
      fontFamilies: { terminal: hostTheme?.fontFamilies?.terminal ?? '' },
      fontSizes: { terminal: hostTheme?.fontSizes?.terminal ?? 13 },
    })
  }, [terminalHost])

  const terminalT = useMemo(() => (key, params) => {
    switch (key) {
      case 'new': return t('guide.terminalTitle')
      case 'title': return t('guide.terminalTabTitle')
      case 'loading':
      case 'creating':
      case 'connecting': return t('connecting')
      case 'disconnected': return t('disconnected')
      case 'reconnect':
      case 'control':
      case 'retry': return t('reconnect')
      case 'readonly': return t('session.readOnly')
      case 'closed': return t('guide.terminalClosed')
      case 'exited': return t('guide.terminalExited', { code: String(params?.code ?? '—') })
      case 'failed': return t('guide.terminalFailed', { message: String(params?.message ?? '') })
      case 'unavailable': return t('file.unsupported')
      case 'missingTerminal': return t('guide.terminalMissing')
      default: return key
    }
  }, [t])

  if (loadError) return <p className="dchat-preview-status" role="alert">{loadError}</p>
  if (!NativeTerminalBody) {
    return <p className="dchat-preview-status" role="status"><StateDot state="ongoing" />{t('connecting')}</p>
  }
  return <div className="dchat-files-pane dchat-native-terminal-host">
    <TerminalErrorBoundary>
      <NativeTerminalBody
        useTabInfo={useTabInfo}
        useTerminal={useTerminal}
        useTheme={useTheme}
        view={() => model}
        t={terminalT}
      />
    </TerminalErrorBoundary>
  </div>
}

function RightbarBrowser({ tab, t, onNavigate }) {
  const [inputUrl, setInputUrl] = useState(tab.url || 'http://localhost:3000')
  const activeUrl = tab.url || 'http://localhost:3000'
  const [revision, setRevision] = useState(0)
  const submit = event => {
    event.preventDefault()
    const raw = inputUrl.trim()
    if (!raw) return
    const next = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
    setInputUrl(next)
    onNavigate(next)
  }
  return <div className="dchat-files-pane">
    <form className="dchat-preview-toolbar dchat-browser-toolbar" onSubmit={submit}>
      <Input type="text" className="dchat-browser-url" value={inputUrl}
        placeholder="http://localhost:3000" onChange={event => setInputUrl(event.target.value)} />
      <Tooltip label={t('diff.refresh')} side="bottom">
        <Button size="sm" className="dchat-diff-icon" aria-label={t('diff.refresh')}
          onClick={() => setRevision(v => v + 1)}>
          <IconRefreshOutlineRegular size={15} />
        </Button>
      </Tooltip>
    </form>
    <div className="dchat-preview-content">
      <iframe key={`${activeUrl}:${revision}`} src={activeUrl} title={activeUrl} className="dchat-browser-frame"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  </div>
}

export const diffCopy = {
  en: {
    ...rightbarEn,
    ...filesCopy.en,
    'guide.filesDesc': 'Browse directories and files in the current workspace',
    'guide.terminalTitle': 'New terminal',
    'guide.terminalTabTitle': 'Terminal',
    'guide.terminalDesc': 'Run commands in the session workspace',
    'guide.terminalClosed': 'Terminal closed.',
    'guide.terminalExited': 'Process exited ({code})',
    'guide.terminalFailed': 'Terminal error: {message}',
    'guide.terminalMissing': 'This terminal no longer exists. Open a new terminal.',
    'guide.changesDesc': 'Review uncommitted, unstaged, and staged Git changes',
    'guide.browserTitle': 'Open browser',
    'guide.browserDesc': 'Open a web page or local dev server inside the sidebar',
    'diff.title': 'Code review changes', 'diff.refresh': 'Refresh',
  },
  zh: {
    ...rightbarZh,
    ...filesCopy.zh,
    'guide.filesDesc': '浏览当前工作区目录与文件',
    'guide.terminalTitle': '新建终端',
    'guide.terminalTabTitle': '终端',
    'guide.terminalDesc': '在会话工作区运行命令',
    'guide.terminalClosed': '终端已关闭。',
    'guide.terminalExited': '进程已退出（{code}）',
    'guide.terminalFailed': '终端错误：{message}',
    'guide.terminalMissing': '此终端已不存在，请新建终端。',
    'guide.changesDesc': '审查当前工作区的 Git 变更与代码差异',
    'guide.browserTitle': '打开浏览器',
    'guide.browserDesc': '在侧边栏中打开网页或本地调试服务',
    'diff.title': '代码审查变更', 'diff.refresh': '刷新',
  },
}
