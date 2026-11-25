import { useSyncExternalStore } from 'react'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocumentModulesContext, documentCopy } from './DocumentPreview.jsx'
import { spreadsheetCopy } from './SpreadsheetPreview.jsx'
import { ArchiveSettings, archiveSettingsCopy } from './ArchiveSettings.jsx'
import { EngineSettings } from './EngineSettings.jsx'
import { forgeCopy } from './ForgeChanges.jsx'
import { WorkspaceDiffPane, diffCopy, workspaceDiffSlot } from './WorkspaceDiff.jsx'
import { sessionStatusCopy } from './SessionStatus.jsx'
import statusStyles from './session-status.css'
import { createQueueDockSource } from './MessageQueue.jsx'
import { DirectChat } from './DirectChat.jsx'
import { EngineHero } from './EngineHero.jsx'
import { createEngineCatalog, createDirectStatusStore } from './chat-state.mjs'
import { createNavigation } from './navigation.mjs'
import { SessionPet } from './SessionPet.jsx'
import petStyles from './session-pet.css'
import { en, zh } from './copy.mjs'
import { createSidebarHistory } from './sidebar-history.mjs'
import { createWorkspaceDiffController } from './workspace-diff-view.mjs'
import { SidebarProjection, SidebarSessions, sidebarCopy, workspaceProjectionSlot, workspaceSessionsSlot } from './sidebar.jsx'
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
    en: { ...en, ...sidebarCopy.en, ...archiveSettingsCopy.en, ...sessionStatusCopy.en, ...diffCopy.en, ...documentCopy.en, ...spreadsheetCopy.en },
    zh: { ...zh, ...sidebarCopy.zh, ...archiveSettingsCopy.zh, ...sessionStatusCopy.zh, ...diffCopy.zh, ...documentCopy.zh, ...spreadsheetCopy.zh },
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
  const startNative = async (workspaceId, cwd) => {
    if (!workspaceId && cwd) {
      const navigationSignal = ctx.layout.beginNavigation()
      workspaceId = (await ctx.workspaces.create({ path: cwd })).workspaceId
      if (navigationSignal.aborted) return
    }
    if (workspaceId) await ctx.uiWorkspace.openWorkspace(workspaceId)
    else ctx.uiWorkspace.startSession()
  }
  const startDirect = (engine, cwd) => {
    navigation.start(engine, cwd)
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
    openDirect,
    openNative: id => { try { ctx.uiWorkspace.openSession(id) } catch {} },
  })

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: panelId, locale: panelId,
    inject: () => ({ ...sessionPetProps(), navigation, startNative, workspaceSource, diffController, queueDock,
      performanceSettings: ctx.get('configForms')?.get('ui-chat'),
      submissionSettings: ctx.get('configForms')?.get('ui-conversation') }),
  }, DirectChat))
  ctx.slots.inject(workspaceDiffSlot, () => {
    const dispose = ctx.slots.register({
      name: workspaceDiffSlot, locale: panelId,
      inject: () => ({ controller: diffController, contextMenus: ctx.contextMenus, panelSource, panelId, layout: ctx.layout, terminalHost }),
    }, DocumentWorkspacePane)
    diffController.useLayoutSeat(true)
    return () => { diffController.useLayoutSeat(false); dispose() }
  })
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
  ctx.slots.inject('conversation.hero.engine', () => ctx.slots.register({
    name: 'conversation.hero.engine', locale: panelId,
    inject: () => ({ engineSource, startDirect }),
  }, NativeEngineHero))
  ctx.slots.inject(workspaceSessionsSlot, () => ctx.slots.register({
    name: workspaceSessionsSlot, id: panelId, locale: panelId,
    inject: () => ({ history }),
  }, SidebarSessions))
  ctx.slots.inject(workspaceProjectionSlot, () => ctx.slots.register({
    name: workspaceProjectionSlot, locale: panelId,
    inject: () => ({ history, statusStore, navigation, openDirect, panelId, engineSource,
      registerWorkspace: path => ctx.workspaces.create({ path }),
    }),
  }, SidebarProjection))
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

function NativeEngineHero({ cwd, headline, startDirect, engineSource, t }) {
  const { engines, status } = useSyncExternalStore(engineSource.subscribe, engineSource.getSnapshot)
  return <EngineHero selected={null} engines={engines} status={status} reload={engineSource.refresh}
    nativeHeadline={headline} onSelect={engine => startDirect(engine, cwd)} t={t} />
}

