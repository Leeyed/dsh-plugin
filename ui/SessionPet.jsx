import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button, FishLogo, IconChevronRightOutlineRegular, IconCloseOutlineRegular, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { engineLabel, sessionAction } from './chat-state.mjs'
import { EngineLogo } from './EngineHero.jsx'

const PET_POS_KEY = 'dsh-direct-chat.pet-pos'
const emptyNative = { byId: {}, ids: [] }
const emptyNativeStore = { getSnapshot: () => emptyNative, subscribe: () => () => {} }
const emptyNativeStatus = new Map()
const useEmptyNativeStatus = () => emptyNativeStatus
const useEmptyWorkspaces = () => undefined
const mobileViewport = '(max-width: 767px)'

function readSavedPos() {
  try {
    const raw = localStorage.getItem(PET_POS_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return { x: parsed.x, y: parsed.y }
  } catch {}
  return null
}

function clampPos(x, y) {
  const maxX = Math.max(16, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 72)
  const maxY = Math.max(16, (typeof window !== 'undefined' ? window.innerHeight : 800) - 72)
  return {
    x: Math.max(12, Math.min(maxX, x)),
    y: Math.max(12, Math.min(maxY, y)),
  }
}

function PetSprite({ mood }) {
  if (mood === 'running') {
    return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {/* Speed lines */}
      <path className="dchat-pet-wind" d="M2 14.5H5.5M3 17.5H6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      {/* Bicycle wheels */}
      <circle cx="8" cy="24" r="4.3" stroke="currentColor" strokeWidth="1.5" />
      <g className="dchat-pet-wheel" style={{ transformOrigin: '8px 24px' }}>
        <path d="M8 20.5V27.5M4.5 24H11.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </g>
      <circle cx="23.5" cy="24" r="4.3" stroke="currentColor" strokeWidth="1.5" />
      <g className="dchat-pet-wheel" style={{ transformOrigin: '23.5px 24px' }}>
        <path d="M23.5 20.5V27.5M20 24H27" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </g>
      {/* Bicycle frame & handlebar */}
      <path d="M8 24L14.2 24L18.5 17.8H11.8L8 24ZM14.2 24L11.8 17.8M23.5 24L18.2 15.5L20.8 14.8"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.3 17.5H13.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Pelican rider */}
      <g className="dchat-pet-rider">
        <path d="M9.6 17.2C9.2 14.2 11.6 12.2 14.6 13.1C16.2 13.6 16.8 15.5 15.2 17.2Z"
          fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <circle cx="14.6" cy="9.4" r="2.9" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.4" />
        <path d="M13.8 6.5C14.3 5.2 15.6 5.2 16.2 6.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M17.2 8.7L26.2 10.3C24.8 12.8 20.4 13.4 16.9 11.4Z"
          fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
        <circle cx="15.5" cy="8.9" r="0.8" fill="currentColor" />
        <path d="M13.8 14.4L18.6 15.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </g>
    </svg>
  }

  if (mood === 'attention') {
    return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {/* Pelican alerting */}
      <path d="M7.5 25.5C7 19.5 9.5 15.5 13.5 15.5C17.2 15.5 19.2 19.5 18.6 25.5Z"
        fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="13" cy="11.2" r="3.4" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7.8C12.5 6.4 14 6.4 14.6 7.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M16 10.2L24.5 11.2C23.2 14.1 18.8 14.8 15.6 12.8Z"
        fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="14.1" cy="10.6" r="1" fill="currentColor" />
      <path d="M7.8 19.5L4.8 16.5M18.2 19.5L21.5 17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 25.5H20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Alert exclamation */}
      <g className="dchat-pet-spark" style={{ transformOrigin: '25.5px 7px' }}>
        <path d="M25.5 4.2V7.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <circle cx="25.5" cy="10.2" r="1" fill="currentColor" />
      </g>
    </svg>
  }

  if (mood === 'done') {
    return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {/* Pelican celebrating */}
      <path d="M7.5 25.5C7 19.5 9.5 15.5 13.5 15.5C17.2 15.5 19.2 19.5 18.6 25.5Z"
        fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="13" cy="11.2" r="3.4" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7.8C12.5 6.4 14 6.4 14.6 7.7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M16 10.4L24.2 11.4C22.8 14 18.6 14.4 15.6 12.6Z"
        fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M13 10.8C13.6 10 14.6 10 15.1 10.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
      <path d="M7.8 18.5L4.5 14.8M18.2 18.5L22 15.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6 25.5H20" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Sparkle */}
      <path className="dchat-pet-spark" style={{ transformOrigin: '25.5px 7px' }}
        d="M25.5 3.8L26.3 6.2L28.7 7L26.3 7.8L25.5 10.2L24.7 7.8L22.3 7L24.7 6.2Z" fill="currentColor" />
    </svg>
  }

  // Idle: pelican relaxing with a warm cup of coffee
  return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    {/* Pelican resting */}
    <path d="M6.2 25.5C5.8 19.2 8.5 15 12.2 15C15.5 15 17.5 18.5 17 25.5Z"
      fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    <circle cx="11.8" cy="10.8" r="3.3" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.5" />
    <path d="M10.8 7.5C11.3 6.2 12.7 6.2 13.3 7.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    <path d="M14.8 10L22.6 11.3C21.3 13.6 17.4 14 14.5 12.3Z"
      fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
    <path d="M11.6 10.5C12.2 11.2 13.2 11.2 13.8 10.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M12.5 19.2C15 19.8 17.2 21 19.4 21" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    {/* Coffee mug & steam */}
    <rect x="19.5" y="18.8" width="6.8" height="6.7" rx="1.4"
      fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.4" />
    <path d="M26.3 20.3C28.2 20.3 28.2 23.8 26.3 23.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    <path d="M5 25.5H27.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path className="dchat-pet-steam" d="M21.6 16.8C21 15.6 22.3 14.8 21.7 13.5M24.4 16.8C23.8 15.6 25.1 14.8 24.5 13.5"
      stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
  </svg>
}

export function SessionPet({
  variant = 'floating', statusStore, nativeSessions = emptyNativeStore,
  useSessionStatus = useEmptyNativeStatus, useWorkspaces = useEmptyWorkspaces,
  engineSource, openDirect, openNative, t,
}) {
  const directSnap = useSyncExternalStore(statusStore.subscribe, statusStore.getSnapshot)
  const nativeSnap = useSyncExternalStore(nativeSessions.subscribe, nativeSessions.getSnapshot)
  const nativeStatus = useSessionStatus(snapshot => snapshot)
  const archivedNativeIds = useWorkspaces(snapshot => snapshot?.archivedSessionIds)
  const { engines } = useSyncExternalStore(engineSource.subscribe, engineSource.getSnapshot)
  const [open, setOpen] = useState(false)
  const [approvingKey, setApprovingKey] = useState(null)
  const [pos, setPos] = useState(() => readSavedPos())
  const dragRef = useRef(null)
  const rootRef = useRef(null)
  const panelRef = useRef(null)
  const closeRef = useRef(null)
  const isHeader = variant === 'header'
  const closePanel = () => setOpen(false)

  useEffect(() => {
    const onResize = () => setPos(prev => prev ? clampPos(prev.x, prev.y) : prev)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!open || isHeader) return
    const onPointerDown = event => {
      const inRoot = rootRef.current && rootRef.current.contains(event.target)
      const inPanel = panelRef.current && panelRef.current.contains(event.target)
      if (!inRoot && !inPanel) setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open, isHeader])

  useEffect(() => {
    if (!open || !isHeader) return
    const viewport = window.matchMedia(mobileViewport)
    const onChange = event => { if (!event.matches) setOpen(false) }
    viewport.addEventListener('change', onChange)
    return () => viewport.removeEventListener('change', onChange)
  }, [open, isHeader])

  const tasks = useMemo(() => {
    const items = []
    for (const item of directSnap.list ?? []) {
      items.push({
        key: `direct:${item.id}`,
        id: item.id,
        kind: 'direct',
        engine: item.engine,
        title: item.title || engineLabel(engines, item.engine),
        source: engineLabel(engines, item.engine),
        state: item.state,
        updatedAt: item.updatedAt || 0,
        permissions: Array.isArray(item.permissions) ? item.permissions : [],
      })
    }
    const nativeById = nativeSnap?.byId ?? {}
    const archivedNative = new Set(archivedNativeIds)
    for (const row of Object.values(nativeById)) {
      if (!row || row.archived || row.blank || archivedNative.has(row.id)) continue
      const status = nativeStatus?.get(row.id)
      const state = (status?.pendingInteraction ?? row.pendingInteraction) ? 'attention'
        : (status?.running ?? row.running) ? 'running'
        : (status?.completionUnread ?? row.completed) ? 'done' : null
      if (!state) continue
      items.push({
        key: `native:${row.id}`,
        id: row.id,
        kind: 'native',
        title: row.displayTitle || row.title || 'DSH',
        source: 'DSH',
        state,
        updatedAt: row.updatedAt || 0,
      })
    }
    const rank = { attention: 0, running: 1, done: 2 }
    return items.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.updatedAt - a.updatedAt))
  }, [directSnap.list, nativeSnap, nativeStatus, archivedNativeIds, engines])

  const counts = useMemo(() => {
    let running = 0
    let attention = 0
    let done = 0
    for (const item of tasks) {
      if (item.state === 'running') running++
      else if (item.state === 'attention') attention++
      else if (item.state === 'done') done++
    }
    return { running, attention, done }
  }, [tasks])

  const mood = counts.attention > 0 ? 'attention'
    : counts.running > 0 ? 'running'
    : counts.done > 0 ? 'done'
    : 'idle'

  const activeCount = counts.attention + counts.running + counts.done
  const openBelow = pos ? pos.y < 280 : true
  const alignLeft = pos ? pos.x < 220 : false

  const onPointerDown = event => {
    if (event.button !== 0) return
    const rect = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pos?.x ?? rect.left,
      originY: pos?.y ?? rect.top,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = event => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true
    setPos(clampPos(drag.originX + dx, drag.originY + dy))
  }

  const onPointerUp = event => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch {}
    if (drag.moved) {
      const next = clampPos(drag.originX + (event.clientX - drag.startX), drag.originY + (event.clientY - drag.startY))
      setPos(next)
      try { localStorage.setItem(PET_POS_KEY, JSON.stringify(next)) } catch {}
    } else {
      setOpen(v => !v)
    }
  }

  const style = variant === 'floating' && pos ? { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto' } : undefined
  const hasDirectCompletion = tasks.some(item => item.kind === 'direct' && item.state === 'done')
  const hasNativeCompletion = tasks.some(item => item.kind === 'native' && item.state === 'done')
  const panel = <>
    <header className="dchat-pet-panel-header">
      <h2 className="dchat-pet-panel-title">{t('pet.title')}</h2>
      <div className="dchat-pet-panel-actions">
        {hasDirectCompletion && <button type="button" className="dchat-pet-ack" onClick={() => {
          if (isHeader) closeRef.current?.focus()
          void statusStore.ack()
        }}>
          {t(hasNativeCompletion ? 'pet.clearDirectDone' : 'pet.clearDone')}
        </button>}
        <button type="button" ref={closeRef} className="dchat-pet-close" aria-label={t('close')} onClick={closePanel}
          data-modal-autofocus={isHeader ? '' : undefined}>
          <IconCloseOutlineRegular size={isHeader ? 20 : 16} />
        </button>
      </div>
    </header>
    {tasks.length === 0 ? <div className="dchat-pet-empty">
      {isHeader && <PetSprite mood="idle" />}
      <p>{t('pet.empty')}</p>
    </div> : <ul className="dchat-pet-list">
      {tasks.map(item => <li key={item.key}>
        <button type="button" className="dchat-pet-item" data-live-state={item.state} onClick={() => {
          if (item.kind === 'direct') {
            openDirect(item.id)
            if (item.state === 'done') void statusStore.ack(item.id)
          } else {
            openNative?.(item.id)
          }
          closePanel()
        }}>
          <span className="dchat-pet-item-logo" aria-hidden="true">
            {item.kind === 'direct'
              ? <EngineLogo engine={item.engine} label={item.source} size={16} />
              : <FishLogo size={16} />}
          </span>
          <span className="dchat-pet-item-body">
            <span className="dchat-pet-item-title">{item.title}</span>
            <span className="dchat-pet-item-meta">{item.source}{!isHeader && ` · ${t(`sidebar.status.${item.state}`)}`}</span>
          </span>
          {isHeader && <>
            <span className="dchat-pet-item-status">
              <StateDot size={item.state === 'running' ? 12 : 7}
                state={item.state === 'running' ? 'ongoing' : item.state === 'attention' ? 'warning' : 'done'} />
              {t(item.kind === 'native' && item.state === 'attention' ? 'pet.nativeAttention' : `sidebar.status.${item.state}`)}
            </span>
            <IconChevronRightOutlineRegular className="dchat-pet-item-chevron" size={16} aria-hidden="true" />
          </>}
        </button>
        {item.kind === 'direct' && item.state === 'attention' && item.permissions.length > 0 && (
          <div className="dchat-pet-approval" onClick={event => event.stopPropagation()}>
            {item.permissions.map(perm => {
              const key = `${item.id}:${perm.id}`
              const busy = approvingKey === key
              return <div key={perm.id} className="dchat-pet-approval-card">
                <div className="dchat-pet-approval-title">{perm.title || t('permission.tool')}</div>
                {perm.detail && <div className="dchat-pet-approval-detail" title={String(perm.detail)}>{String(perm.detail)}</div>}
                <div className="dchat-pet-approval-actions">
                  {perm.options.map(option => <Button key={option.optionId} size="sm"
                    variant={option.kind?.startsWith('allow') ? 'primary' : 'outline'}
                    disabled={busy}
                    onClick={async event => {
                      event.stopPropagation()
                      if (approvingKey) return
                      setApprovingKey(key)
                      try { await sessionAction(item.id, 'approve', { id: perm.id, option: option.optionId }) }
                      catch {}
                      finally { setApprovingKey(null) }
                    }}>{option.name}</Button>)}
                </div>
              </div>
            })}
          </div>
        )}
      </li>)}
    </ul>}
  </>

  return <div ref={rootRef} className={isHeader ? 'dchat-pet-header-slot' : 'dchat-pet-root'} data-mood={mood} style={style}>
    {isHeader ? <Modal open={open} onClose={closePanel} title={t('pet.title')} headless backdropBlur={false}
      className="dchat-pet-panel-fullscreen">{panel}</Modal> : open && (
      <div ref={panelRef} className="dchat-pet-panel" data-below={openBelow || undefined}
        data-align-left={alignLeft || undefined} role="dialog" aria-label={t('pet.title')}>{panel}</div>
    )}
    {isHeader ? <button type="button" className="dchat-pet-header-btn" title={t('pet.title')} aria-label={t('pet.title')}
      aria-expanded={open} aria-haspopup="dialog" onClick={event => {
        event.currentTarget.focus()
        setOpen(true)
      }}>
      <PetSprite mood={mood} />
      {activeCount > 0 && <span className="dchat-pet-badge" data-mood={mood}>{activeCount > 99 ? '99+' : activeCount}</span>}
    </button> : <button type="button" className="dchat-pet-fab" title={t('pet.title')} aria-label={t('pet.title')}
      aria-expanded={open} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <PetSprite mood={mood} />
      {activeCount > 0 && <span className="dchat-pet-badge" data-mood={mood}>{activeCount}</span>}
    </button>}
  </div>
}
