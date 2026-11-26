import { useEffect, useSyncExternalStore } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocumentModulesContext, documentCopy } from './DocumentPreview.jsx'
import { spreadsheetCopy } from './SpreadsheetPreview.jsx'
import { ArchiveSettings, archiveSettingsCopy } from './ArchiveSettings.jsx'
import { EngineSettings } from './EngineSettings.jsx'
import { forgeCopy } from './ForgeChanges.jsx'
import { WorkspaceDiffPane, diffCopy } from './WorkspaceDiff.jsx'
import { createWorkspaceViewStore } from '@deepseek-ai/dsh-client-ui-workspace/src/client/stores.ts'
import { createWorkspaceShortcutControls } from '@deepseek-ai/dsh-client-ui-workspace/src/client/shortcuts.ts'
import { connectSidebarDirectoryFlow, sidebarDirectorySlot } from './sidebar-directory-flow.mjs'
import { MergedWorkspaceBrowser } from './MergedWorkspaceBrowser.jsx'
import { sessionStatusCopy } from './SessionStatus.jsx'
import statusStyles from './session-status.css'
import { createQueueDockSource } from './MessageQueue.jsx'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import { workspaceEntryMenu } from './workspace-entry-menu.mjs'
import { DirectChat } from './DirectChat.jsx'
import { EngineDropdown } from './EngineHero.jsx'
import { createEngineCatalog, createDirectStatusStore } from './chat-state.mjs'
import { createNavigation } from './navigation.mjs'
import { startDirectFromNative, startNativeFromDirect } from './native-draft.mjs'
import { SessionPet } from './SessionPet.jsx'
import petStyles from './session-pet.css'
import { en, zh } from './copy.mjs'
import { createSidebarHistory } from './sidebar-history.mjs'
import { createWorkspaceDiffController } from './workspace-diff-view.mjs'
import { sidebarCopy } from './sidebar.jsx'
import { worktreeCopy } from './WorktreeToggle.jsx'
import archiveStyles from './archive-settings.css'
import engineStyles from './engine-hero.css'
import sidebarStyles from './sidebar.css'
import styles from './styles.css'
import workspaceStyles from './workspace-picker.css'
import diffStyles from './workspace-diff.css'

const panelId = 'direct-chat'
const forgeLocale = 'direct-chat-forge'
export const inject = ['slots', 'layout', 'locale', 'uiWorkspace', 'workspaces', 'contextMenus']

export function apply(ctx) {
  const getModules = () => ctx.get?.('modules') ?? ctx.modules
  const forgeT = ctx.locale.bind(forgeLocale)
  const DocumentWorkspacePane = props => <DocumentModulesContext.Provider value={getModules}>
    <WorkspaceDiffPane {...props} forgeT={forgeT} />
  </DocumentModulesContext.Provider>
  const history = createSidebarHistory()
  const statusStore = createDirectStatusStore()
  const engineSource = createEngineCatalog()
  const queueDock = createQueueDockSource(ctx)
  const navigation = createNavigation(history.refresh)
  const archiveListeners = new Set()
  let archiveSnapshot = null
  const archiveRequest = {
    getSnapshot: () => archiveSnapshot,
    subscribe: listener => {
      archiveListeners.add(listener)
      return () => archiveListeners.delete(listener)
    },
    set: next => {
      archiveSnapshot = next
      for (const listener of archiveListeners) listener()
    },
  }
  const diffController = createWorkspaceDiffController()
  const panelSource = {
    getSnapshot: () => ctx.layout.panelInfo.getSnapshot(),
    subscribe: listener => ctx.layout.panelInfo.subscribe(listener),
  }
  const activePanelKey = 'dsh-direct-chat.active-panel'
  ctx.effect(() => {
    let restored = false
    const sync = () => {
      const current = ctx.layout.panelInfo.getSnapshot()?.activePanelId
      if (!restored) {
        restored = true
        try {
          if (localStorage.getItem(activePanelKey) === '1' && navigation.getSnapshot()?.id && current !== panelId) {
            ctx.layout.selectPanel(panelId)
            return
          }
        } catch {}
      }
      if (current) {
        try { localStorage.setItem(activePanelKey, current === panelId ? '1' : '0') } catch {}
      }
    }
    queueMicrotask(sync)
    return ctx.layout.panelInfo.subscribe(sync)
  }, 'direct-chat: restore-active-panel')
  ctx.effect(() => ctx.locale.register(panelId, {
    en: { ...en, ...sidebarCopy.en, ...archiveSettingsCopy.en, ...sessionStatusCopy.en, ...diffCopy.en, ...documentCopy.en, ...spreadsheetCopy.en, ...worktreeCopy.en },
    zh: { ...zh, ...sidebarCopy.zh, ...archiveSettingsCopy.zh, ...sessionStatusCopy.zh, ...diffCopy.zh, ...documentCopy.zh, ...spreadsheetCopy.zh, ...worktreeCopy.zh },
  }), 'direct-chat: locale')
  ctx.effect(() => ctx.locale.register(forgeLocale, forgeCopy), 'direct-chat: Forge locale')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-direct-chat'
    style.textContent = compiledNativeStyles + styles + workspaceStyles + sidebarStyles + archiveStyles + engineStyles + statusStyles + diffStyles + petStyles
    document.head.append(style)
    return () => style.remove()
  }, 'direct-chat: styles')
  const t = ctx.locale.bind(panelId)
  ctx.inject(['fileActions', 'remote', 'remote.session'], child => {
    child.effect(() => child.contextMenus.register(workspaceEntryMenu({
      session: child.remote.session, fileActions: child.fileActions, writeClipboard,
      pathLabel: child.locale.bind('open-in-app'), fileLabel: child.locale.bind('fileActions'),
      notify: (...args) => child.contextMenus.notify(...args),
    })), 'direct-chat: workspace file menu')
  })
  const workspaceList = ctx.workspaces.list
  const workspaceSource = {
    getSnapshot: () => workspaceList.getSnapshot(),
    subscribe: listener => workspaceList.subscribe(listener),
  }
  const terminalHost = {
    getTheme: () => {
      try { return ctx.theme?.getTheme?.() ?? ctx.get?.('theme')?.getTheme?.() } catch { return undefined }
    },
    getModules: () => {
      try { return ctx.modules?.manifest?.modules ?? ctx.get?.('modules')?.manifest?.modules } catch { return undefined }
    },
  }
  const startNative = (workspaceId, cwd, draft) => startNativeFromDirect(ctx, workspaceId, cwd, draft)
  const startDirect = (engine, cwd) => {
    startDirectFromNative(ctx, navigation, engine, cwd)
    ctx.layout.selectPanel(panelId)
  }
  const openDirect = id => {
    ctx.layout.selectPanel(panelId)
    navigation.open(id)
  }
  const sessionPetProps = () => ({
    statusStore,
    nativeSessions: (() => { try { return ctx.get?.('sessions')?.list } catch { return undefined } })(),
    engineSource,
    navigation,
    panelInfo: ctx.layout.panelInfo,
    panelId,
    openDirect,
    openNative: id => { try { ctx.uiWorkspace.openSession(id) } catch {} },
  })

  ctx.effect(() => {
    const sync = () => {
      if (ctx.layout.panelInfo.getSnapshot()?.activePanelId === panelId) {
        ctx.layout.closeRightbar()
      }
    }
    sync()
    return ctx.layout.panelInfo.subscribe(sync)
  }, 'direct-chat: close-native-rightbar')

  const renderRightbar = props => <DocumentWorkspacePane {...props}
    controller={diffController} contextMenus={ctx.contextMenus} panelSource={panelSource} panelId={panelId} terminalHost={terminalHost} t={t} />

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: panelId,
    inject: () => ({ ...sessionPetProps(), navigation, startNative, workspaceSource, diffController, renderRightbar, queueDock,
      performanceSettings: ctx.get('configForms')?.get('ui-chat'),
      submissionSettings: ctx.get('configForms')?.get('ui-conversation') }),
  }, DirectChat))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'direct-chat-workspace-diff', locale: panelId,
    inject: () => ({ controller: diffController, contextMenus: ctx.contextMenus, panelSource, panelId, terminalHost }),
  }, DocumentWorkspacePane))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'direct-cli-engines', order: 45, locale: panelId,
    label: () => t('engineSettings.title'),
    inject: () => ({ engineSource }),
  }, EngineSettings))
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'direct-chat-engines', locale: panelId,
    label: () => t('engineSettings.pluginLabel'),
    inject: () => ({ engineSource }),
  }, ({ view, ...props }) => view === 'page' ? <EngineSettings {...props} /> : t('engineSettings.pluginSummary')))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'archived-sessions', order: 46, locale: panelId,
    label: () => t('archiveSettings.title'),
    inject: () => ({ history, engineSource }),
  }, ArchiveSettings))
  ctx.slots.inject('conversation.hero.agentPreset', () => ctx.slots.register({
    name: 'conversation.hero.agentPreset', priority: -10, locale: panelId,
    inject: sessionId => ({ sessionId, engineSource, startDirect, navigation }),
  }, NativeInputDockHero))

  const viewHandle = createWorkspaceViewStore()
  const viewInstance = viewHandle.create()
  const viewStore = { ...viewHandle, create: () => viewInstance }
  const shortcutControls = createWorkspaceShortcutControls()
  const getShortcutsCatalog = () => {
    try { return ctx.get?.('shortcuts')?.catalog } catch { return undefined }
  }
  const directoryFlowSource = {
    getSnapshot: () => ctx.slots.entriesOfSlot(sidebarDirectorySlot).length > 0,
    subscribe: listener => ctx.slots.subscribe(sidebarDirectorySlot, listener),
  }
  ctx.slots.inject(sidebarDirectorySlot, () => connectSidebarDirectoryFlow(ctx.slots))
  const hostInfoSource = {
    getSnapshot: () => {
      try { return ctx.get?.('remote')?.$host ?? {} } catch { return {} }
    },
    subscribe: listener => {
      try { return ctx.on?.('connection/reset', listener) ?? (() => {}) } catch { return () => {} }
    },
  }
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    children: { [sidebarDirectorySlot]: { kind: 'single', scope: 'root' } },
    priority: -10,
    store: viewStore,
    locale: 'workspace',
    inject: () => {
      const sessionsApi = (() => { try { return ctx.get?.('sessions') } catch { return undefined } })()
      return {
        history, statusStore, navigation, openDirect, panelId, engineSource, archiveRequest,
        registerWorkspace: path => ctx.workspaces.create({ path }),
        uiWorkspace: ctx.uiWorkspace, sessionsApi, workspacesApi: ctx.workspaces,
        directT: t,
        startSession: (workspaceId, options) => ctx.uiWorkspace.startSession(workspaceId, options),
        open: sessionId => ctx.uiWorkspace.openSession(sessionId),
        searchSessions: async (query, signal) => {
          const result = await sessionsApi?.search(query, signal)
          if (result && !result.ok) throw new Error(result.error?.message || 'Search failed')
          return result?.value ?? { items: [], truncated: false }
        },
        searchResultLimit: sessionsApi?.searchResultLimit ?? 50,
        requestSessionRename: shortcutControls.rename,
        notifyArchivedNotOpenable: () => {},
        renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
        deleteWorkspace: async workspaceId => { await ctx.workspaces.delete(workspaceId) },
        insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
          await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
        },
        unarchiveSession: async sessionId => { await ctx.uiWorkspace.unarchiveSession(sessionId) },
        createWorkspace: input => ctx.workspaces.create(input),
        requestSearch: shortcutControls.search,
        requestAddWorkspace: shortcutControls.add,
        closeAddWorkspace: shortcutControls.closeAdd,
        setDirectoryBusy: shortcutControls.directoryBusy,
        dismissForkError: shortcutControls.dismissForkError,
        hooks: {
          directoryFlow: directoryFlowSource,
          hostInfo: hostInfoSource,
          workspaceShortcuts: shortcutControls.state,
          shortcuts: getShortcutsCatalog() ?? { getSnapshot: () => [], subscribe: () => () => {} },
        },
      }
    },
  }, MergedWorkspaceBrowser))
  ctx.effect(() => ctx.contextMenus.register({
    id: 'direct-chat.workspace.archive', target: 'workspace', order: 290,
    resolve: ({ path, displayTitle }) => {
      const cwd = path || ''
      const rows = history.getSnapshot().byCwd.get(cwd) ?? []
      const count = rows.filter(row => !row.archived && row.archiveMode !== 'unsupported').length
      return count > 0 ? [{
        id: 'direct-chat.archive-workspace',
        label: t('sidebar.archiveFolder'),
        icon: { key: 'workspace.archive' },
        separatorBefore: true,
        run: () => archiveRequest.set({ cwd, name: displayTitle, count }),
      }] : []
    },
  }), 'direct-chat: workspace archive menu')
  ctx.slots.inject('sidebar.session.row.leading', () => ctx.slots.register({
    name: 'sidebar.session.row.leading', id: 'direct-chat-native-logo', order: 100, locale: panelId,
  }, () => <span className="dchat-sidebar-native-logo" aria-hidden="true"><FishLogo size={14} /></span>))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'direct-chat-session-pet', locale: panelId,
    inject: sessionPetProps,
  }, SessionPet))
  ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
    name: 'conversation.header.leading', id: 'direct-chat-session-pet', locale: panelId,
    inject: () => ({ ...sessionPetProps(), variant: 'header' }),
  }, SessionPet))
}

function NativeInputDockHero({ sessionId, useSessions, useWorkspaces, engineSource, startDirect, navigation, t }) {
  const session = useSessions(s => sessionId ? s.byId[sessionId] : undefined)
  const workspacePath = useWorkspaces(w => sessionId
    ? w.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path
    : undefined) ?? (session?.cwd || undefined)
  const { engines, status } = useSyncExternalStore(engineSource.subscribe, engineSource.getSnapshot)
  const preferred = status === 'ready' && session?.blank ? navigation.preferredEngine(engines) : undefined
  useEffect(() => {
    if (preferred) startDirect(preferred, workspacePath)
  }, [preferred, sessionId, workspacePath, startDirect])
  if (!session?.blank) return null
  return <EngineDropdown selected={null} engines={engines} status={status} reload={engineSource.refresh}
    onSelect={engine => { if (engine !== null) startDirect(engine, workspacePath) }} t={t} />
}

