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
    return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      {/* Wind & road */}
      <path className="dchat-pet-wind" d="M2.5 17H7.5M4 20.5H8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M4 35.5H36" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.28" strokeLinecap="round" strokeDasharray="3 3" />
      {/* Rear wheel */}
      <circle cx="10.5" cy="29.5" r="5.4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="10.5" cy="29.5" r="1.1" fill="currentColor" />
      <g className="dchat-pet-wheel" style={{ transformOrigin: '10.5px 29.5px' }}>
        <path d="M10.5 24.5V34.5M6.2 27L14.8 32M14.8 27L6.2 32" stroke="currentColor" strokeWidth="1.05" strokeOpacity="0.7" strokeLinecap="round" />
      </g>
      {/* Front wheel */}
      <circle cx="29.5" cy="29.5" r="5.4" stroke="currentColor" strokeWidth="1.7" />
      <circle cx="29.5" cy="29.5" r="1.1" fill="currentColor" />
      <g className="dchat-pet-wheel" style={{ transformOrigin: '29.5px 29.5px' }}>
        <path d="M29.5 24.5V34.5M25.2 27L33.8 32M33.8 27L25.2 32" stroke="currentColor" strokeWidth="1.05" strokeOpacity="0.7" strokeLinecap="round" />
      </g>
      {/* Bicycle frame, crank, saddle & handlebars */}
      <path d="M10.5 29.5H18.5L24.5 21.5H15L10.5 29.5ZM18.5 29.5L14.5 20.5M29.5 29.5L23.8 18.2L27.2 17.5C28.4 17.3 28.8 18.6 27.8 19.2"
        stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18.5" cy="29.5" r="1.7" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M12.6 20.3H16.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {/* Pelican rider */}
      <g className="dchat-pet-rider">
        {/* Tail & body */}
        <path d="M11.5 18.8L8 17.4L9.8 19.8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M11.5 19.8C11 15.8 14 13.5 17.6 14.2C20 14.7 21 17.2 19 19.8Z"
          fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
        {/* Neck & head with crest */}
        <path d="M16.2 14.5C16.2 12.2 16.6 10.6 17.6 9.6" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
        <circle cx="18.5" cy="9.5" r="3.4" fill="currentColor" fillOpacity="0.14" stroke="currentColor" strokeWidth="1.55" />
        <path d="M16.8 6.4C17.4 4.8 19.2 4.8 19.8 6.3" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
        {/* Signature pelican beak & pouch */}
        <path d="M21.6 8.6L34.5 10.7C34.8 11.4 34.4 12.1 33.7 12.2C31 15.4 25.4 15.8 21.1 12.6Z"
          fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M21.8 10.6L33.8 11.7" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
        {/* Eye & wing gripping handlebar */}
        <circle cx="19.6" cy="8.9" r="0.95" fill="currentColor" />
        <path d="M16.8 16.2C19.5 16.6 22 17.5 24.4 18.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </svg>
  }

  if (mood === 'attention') {
    return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      {/* Ground */}
      <path d="M7 33.5H26" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Pelican body & raised wings */}
      <path d="M10 33.2C9.2 25 12.2 19.5 17 19.5C21.5 19.5 24 24.5 23.2 33.2Z"
        fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
      <path d="M10.4 25.5L5.5 21M22.8 25L27.5 20.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      {/* Head & crest */}
      <circle cx="16.5" cy="13.8" r="4.1" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.65" />
      <path d="M14.8 9.8C15.5 8 17.6 8 18.3 9.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Open alert beak */}
      <path d="M20.2 12.5L31.2 13.3C30 16.8 24.6 17.8 19.8 15.6Z"
        fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M20.4 14.1L30.2 14.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="17.8" cy="13" r="1.2" fill="currentColor" />
      {/* Alert exclamation */}
      <g className="dchat-pet-spark" style={{ transformOrigin: '32.5px 8.5px' }}>
        <path d="M32.5 4.8V9.6" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
        <circle cx="32.5" cy="12.6" r="1.2" fill="currentColor" />
      </g>
    </svg>
  }

  if (mood === 'done') {
    return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      {/* Ground */}
      <path d="M7 33.5H26" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      {/* Pelican body & cheering wings */}
      <path d="M10 33.2C9.2 25 12.2 19.5 17 19.5C21.5 19.5 24 24.5 23.2 33.2Z"
        fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
      <path d="M10.4 24.2L5.5 18.8M22.8 24.2L27.5 19.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      {/* Head & happy eye */}
      <circle cx="16.5" cy="13.8" r="4.1" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.65" />
      <path d="M14.8 9.8C15.5 8 17.6 8 18.3 9.7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M20.2 12.6L30.5 13.8C29 17 24 17.6 19.8 15.4Z"
        fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M16.5 13.3C17.2 12.3 18.4 12.3 19.1 13.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      {/* Sparkle */}
      <path className="dchat-pet-spark" style={{ transformOrigin: '32.5px 8.5px' }}
        d="M32.5 4.2L33.6 7.4L36.8 8.5L33.6 9.6L32.5 12.8L31.4 9.6L28.2 8.5L31.4 7.4Z" fill="currentColor" />
    </svg>
  }

  // Idle: pelican relaxing with a warm cup of coffee
  return <svg className="dchat-pet-svg" width="30" height="30" viewBox="0 0 40 40" fill="none" aria-hidden="true">
    {/* Table / perch */}
    <path d="M5 33.5H35" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    {/* Tail & resting pelican body */}
    <path d="M8.5 29L5.5 26.8L7.5 30.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.2 33.3C7.6 24.8 10.8 19.2 15.5 19.2C19.6 19.2 21.8 23.6 21.2 33.3Z"
      fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
    {/* Layered wing holding mug */}
    <path d="M14.5 23.2C17.6 23.8 20.5 25.5 23.8 26.2" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
    {/* Head & crest */}
    <circle cx="15" cy="13.5" r="4" fill="currentColor" fillOpacity="0.15" stroke="currentColor" strokeWidth="1.65" />
    <path d="M13.5 9.5C14.2 7.8 16.2 7.8 16.9 9.4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    {/* Pelican beak & pouch */}
    <path d="M18.6 12.2L28.8 13.8C27.2 16.8 22.2 17.4 18.2 15.2Z"
      fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
    <path d="M18.8 13.8L28 14.6" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
    {/* Relaxed closed eye */}
    <path d="M14.8 13.1C15.5 13.9 16.8 13.9 17.5 13.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    {/* Coffee mug + handle + steam */}
    <rect x="23.8" y="23.2" width="8.6" height="9.2" rx="1.8"
      fill="currentColor" fillOpacity="0.18" stroke="currentColor" strokeWidth="1.55" />
    <path d="M32.4 25.2C34.8 25.2 34.8 29.8 32.4 29.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path className="dchat-pet-steam"
      d="M26.5 20.8C25.8 19.3 27.3 18.2 26.6 16.6M29.8 20.8C29.1 19.3 30.6 18.2 29.9 16.6"
      stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
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
