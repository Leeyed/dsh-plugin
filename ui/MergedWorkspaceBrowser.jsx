import { useEffect, useRef, useState } from 'react'
import {
  Button, FishLogo, IconArchiveOutlineRegular, IconBranchOutlineRegular,
  IconEditOutlineRegular, IconPinFillRegular, IconPinOutlineRegular,
  IconUnarchiveOutlineRegular, Menu, Modal, Toast, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { WorkspaceBrowser } from '@deepseek-ai/dsh-client-ui-workspace/src/client/rows/WorkspaceBrowser.tsx'
import RowsCss from '@deepseek-ai/dsh-client-ui-workspace/src/client/rows/Rows.module.css'
import { SidebarProjection, SidebarSessions } from './sidebar.jsx'

function NativeSessionMenuItems({ sessionId, displayTitle, pinned, archived, onPin, onRename, onFork, onArchive, closeMenu, t }) {
  return <>
    {!archived && <Menu.Item key="pin" icon={pinned ? <IconPinFillRegular size={16} /> : <IconPinOutlineRegular size={16} />}
      onClick={() => { closeMenu(); onPin(sessionId, !pinned) }}>
      {t(pinned ? 'unpin' : 'pin')}
    </Menu.Item>}
    <Menu.Item key="rename" icon={<IconEditOutlineRegular size={16} />}
      onClick={() => { closeMenu(); onRename(sessionId, displayTitle) }}>
      {t('rename')}
    </Menu.Item>
    {!archived && <Menu.Item key="fork" icon={<IconBranchOutlineRegular size={16} />}
      onClick={() => { closeMenu(); onFork(sessionId) }}>
      {t('fork')}
    </Menu.Item>}
    <Menu.Separator key="sep" />
    <Menu.Item key="archive" icon={archived ? <IconUnarchiveOutlineRegular size={16} /> : <IconArchiveOutlineRegular size={16} />}
      onClick={() => { closeMenu(); onArchive(sessionId, !archived) }}>
      {t(archived ? 'unarchive' : 'archive')}
    </Menu.Item>
  </>
}

function NativeSessionRowActions({ sessionId, pinned, archived, onPin, onArchive, t }) {
  return <>
    <Tooltip label={t(archived ? 'unarchive' : 'archive')} side="bottom" align="end" delayMs={500} portal>
      <button type="button" className={RowsCss.iconButton} aria-label={t(archived ? 'unarchive' : 'archive')}
        onClick={event => { event.stopPropagation(); onArchive(sessionId, !archived) }}>
        {archived ? <IconUnarchiveOutlineRegular size={14} /> : <IconArchiveOutlineRegular size={14} />}
      </button>
    </Tooltip>
    {!archived && <Tooltip label={t(pinned ? 'unpin' : 'pin')} side="bottom" align="end" delayMs={500} portal>
      <button type="button" className={pinned ? `${RowsCss.iconButton} ${RowsCss.pinnedAction}` : RowsCss.iconButton}
        aria-label={t(pinned ? 'unpin' : 'pin')}
        onClick={event => { event.stopPropagation(); onPin(sessionId, !pinned) }}>
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>}
  </>
}

function DirectoryPickDialog({ open, busy, directoryPicker, useHostInfo, onPicked, onCancel, onError, t }) {
  const hostInfo = useHostInfo(info => info)
  const [pathInput, setPathInput] = useState('')
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const desktopPicker = globalThis.__DSH_DIRECTORY_PICKER__
  const nativePicker = desktopPicker?.pick ? desktopPicker : hostInfo?.nativeDirectoryPicker ? directoryPicker : null
  const pickedOnceRef = useRef(false)

  useEffect(() => {
    if (!open) {
      pickedOnceRef.current = false
      return
    }
    if (nativePicker?.pick) {
      if (pickedOnceRef.current) return
      pickedOnceRef.current = true
      nativePicker.pick().then(
        res => {
          if (nativePicker === desktopPicker) {
            if (res) onPicked(res)
            else onCancel()
          } else if (!res.ok) onError(res.error.message)
          else if (res.value) onPicked(res.value)
          else onCancel()
        },
        err => onError(err?.message || 'Failed to open directory picker'),
      )
      return
    }
    if (!directoryPicker?.list) return
    const controller = new AbortController()
    setLoading(true)
    directoryPicker.list(pathInput || undefined, controller.signal).then(
      res => {
        if (controller.signal.aborted) return
        setLoading(false)
        if (res?.ok === false) {
          onError(res.error?.message || 'Failed to list directories')
          return
        }
        const value = res?.value ?? res
        if (value?.path && !pathInput) setPathInput(value.path)
        setEntries(Array.isArray(value?.entries) ? value.entries.filter(item => item.isDirectory !== false) : [])
      },
      err => {
        if (!controller.signal.aborted) {
          setLoading(false)
          onError(err?.message || 'Failed to list directories')
        }
      },
    )
    return () => controller.abort()
  }, [open, nativePicker, desktopPicker, directoryPicker, pathInput])

  if (!open || nativePicker?.pick) return null
  return <Modal open title={t('workspace.add')} closeLabel={t('cancel')} onClose={() => { if (!busy) onCancel() }}
    footer={<>
      <Button variant="outline" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      <Button variant="primary" disabled={busy || !pathInput.trim()} onClick={() => onPicked(pathInput.trim())}>
        {t('workspace.add')}
      </Button>
    </>}>
    <input className="dchat-sidebar-rename-input" data-modal-autofocus value={pathInput} disabled={busy}
      onChange={event => setPathInput(event.target.value)}
      onKeyDown={event => {
        if (event.key === 'Enter' && pathInput.trim() && !busy) {
          event.preventDefault()
          onPicked(pathInput.trim())
        }
      }} />
    {loading ? <div className="dchat-status">…</div> : entries.length > 0 && <div style={{ maxHeight: 220, overflowY: 'auto', marginTop: 8 }}>
      {entries.map(entry => <button key={entry.path ?? entry.name} type="button" className={RowsCss.projectRow}
        style={{ width: '100%', textAlign: 'left' }}
        onClick={() => setPathInput(entry.path ?? (pathInput ? `${pathInput.replace(/\/$/, '')}/${entry.name}` : entry.name))}>
        <span className={RowsCss.title}>{entry.name}</span>
      </button>)}
    </div>}
  </Modal>
}

const defaultContextMenuTarget = () => false
const defaultContextMenu = () => ({ getTriggerProps: (_target, handlers) => handlers ?? {} })
const defaultSectionScroller = () => ({ bindScrollerRef: () => {} })
const defaultWorkspaceActionRequest = () => null
const noop = () => {}
const unavailableAccess = () => false
const emptyFactorySlot = () => null

export function MergedWorkspaceBrowser({
  history, statusStore, navigation, openDirect, panelId, engineSource, archiveRequest,
  registerWorkspace, directoryPicker, uiWorkspace, sessionsApi, workspacesApi, directT,
  ...browserProps
}) {
  const workspacesState = browserProps.useWorkspaces(state => state)
  const pinnedSet = new Set(workspacesState.pinnedSessionIds ?? [])
  const archivedSet = new Set(workspacesState.archivedSessionIds ?? [])
  const [renameTarget, setRenameTarget] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamePending, setRenamePending] = useState(false)
  const [toast, setToast] = useState(null)

  const showToast = text => setToast({ id: Date.now(), text })

  const handlePin = (sessionId, nextPinned) => {
    const fn = nextPinned ? uiWorkspace?.pinSession : uiWorkspace?.unpinSession
    void fn?.call(uiWorkspace, sessionId).catch(() => showToast(browserProps.t(nextPinned ? 'pinFailed' : 'unpinFailed')))
  }
  const handleArchive = (sessionId, nextArchived) => {
    const fn = nextArchived ? uiWorkspace?.archiveSession : uiWorkspace?.unarchiveSession
    void fn?.call(uiWorkspace, sessionId).catch(() => showToast(directT('sidebar.actionFailed')))
  }
  const handleFork = sessionId => {
    void uiWorkspace?.forkSession?.(sessionId).catch(() => showToast(directT('sidebar.actionFailed')))
  }
  const handleRename = (sessionId, displayTitle) => {
    setRenameTarget(sessionId)
    setRenameValue(displayTitle || '')
  }

  const localRenderSlot = (slotName, ownerProps, options) => {
    switch (slotName) {
      case 'sidebar.workspaces.directoryFlow':
        return <DirectoryPickDialog {...ownerProps} directoryPicker={directoryPicker} useHostInfo={browserProps.useHostInfo} t={browserProps.t} />
      case 'sidebar.session.row.leading':
        return <span className="dchat-sidebar-native-logo" aria-hidden="true"><FishLogo size={14} /></span>
      case 'sidebar.workspaces.session.menu.item': {
        const [, setMenuOpen] = options?.hookContext ?? [false, () => {}]
        return <NativeSessionMenuItems
          sessionId={ownerProps.sessionId}
          displayTitle={ownerProps.displayTitle}
          pinned={pinnedSet.has(ownerProps.sessionId)}
          archived={archivedSet.has(ownerProps.sessionId)}
          onPin={handlePin}
          onRename={handleRename}
          onFork={handleFork}
          onArchive={handleArchive}
          closeMenu={() => setMenuOpen(false)}
          t={browserProps.t}
        />
      }
      case 'sidebar.workspaces.session.row.action':
        return <NativeSessionRowActions
          sessionId={ownerProps.sessionId}
          pinned={pinnedSet.has(ownerProps.sessionId)}
          archived={archivedSet.has(ownerProps.sessionId)}
          onPin={handlePin}
          onArchive={handleArchive}
          t={browserProps.t}
        />
      default:
        return null
    }
  }

  const confirmRename = async () => {
    const title = renameValue.trim()
    if (!title || !renameTarget || renamePending) return
    setRenamePending(true)
    try {
      const res = await sessionsApi?.using?.(renameTarget, { source: 'workspaceOperation' }, ref => ref.binding.session.rename(title))
      if (res && res.ok === false) throw new Error(res.error?.message || 'Rename failed')
      setRenameTarget(null)
    } catch (error) {
      showToast(error?.message || directT('sidebar.actionFailed'))
    } finally {
      setRenamePending(false)
    }
  }

  return <>
    <SidebarProjection
      history={history}
      statusStore={statusStore}
      navigation={navigation}
      openDirect={openDirect}
      usePanelInfo={browserProps.usePanelInfo}
      panelId={panelId}
      engineSource={engineSource}
      archiveRequest={archiveRequest}
      registerWorkspace={registerWorkspace}
      t={directT}
      render={extension => <WorkspaceBrowser
        {...browserProps}
        useContextMenuTarget={browserProps.useContextMenuTarget ?? defaultContextMenuTarget}
        useContextMenu={browserProps.useContextMenu ?? defaultContextMenu}
        useSectionScroller={browserProps.useSectionScroller ?? defaultSectionScroller}
        useWorkspaceActionRequest={browserProps.useWorkspaceActionRequest ?? defaultWorkspaceActionRequest}
        settleWorkspaceAction={browserProps.settleWorkspaceAction ?? noop}
        useWorkspaceAccess={browserProps.useWorkspaceAccess ?? unavailableAccess}
        useSessionAccess={browserProps.useSessionAccess ?? unavailableAccess}
        renderFactorySlot={browserProps.renderFactorySlot ?? emptyFactorySlot}
        renderSlot={localRenderSlot}
        extension={{
          ...extension,
          renderToolbar: () => <SidebarSessions placement="toolbar" history={history} t={directT} />,
        }}
      />}
    />
    {renameTarget && <Modal open title={directT('sidebar.renameTitle')} closeLabel={directT('close')}
      onClose={() => { if (!renamePending) setRenameTarget(null) }}
      footer={<>
        <Button variant="outline" disabled={renamePending} onClick={() => setRenameTarget(null)}>{directT('cancel')}</Button>
        <Button variant="primary" disabled={renamePending || !renameValue.trim()} onClick={() => void confirmRename()}>{directT('sidebar.rename')}</Button>
      </>}>
      <input className="dchat-sidebar-rename-input" data-modal-autofocus maxLength={256}
        value={renameValue} disabled={renamePending} onChange={event => setRenameValue(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void confirmRename() } }} />
    </Modal>}
    {toast && <Toast key={toast.id} text={toast.text} onDone={() => setToast(null)} />}
  </>
}
