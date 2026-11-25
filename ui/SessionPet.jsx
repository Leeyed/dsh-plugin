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
  const cycling = mood === 'running'
  return <svg className="dchat-pet-svg" width="32" height="32" viewBox="0 0 40 40"
    fill="none" stroke="#293746" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {cycling && <>
      {[9, 31].map(x => <g key={x} transform={`translate(${x} 31)`}>
        <circle r="6" fill="#d6f5e8" strokeWidth="2.6" />
        <path className="dchat-pet-wheel" d="M0-4V0l3.5 2M0 0l-3.5 2" stroke="#599887" strokeWidth="1.4" />
      </g>)}
      <path d="M9 31l7-10 5 10H9m12 0 6-12 4 12m-7-12h4" stroke="#197969" strokeWidth="2.8" />
    </>}
    <g transform={cycling ? 'translate(4 -2) scale(.87)' : 'translate(0 2)'}>
      <path fill="#fff5dc" d="M3 19q4 2 8 0 4-3 4-9 0-7 6-7 6 0 7 6l-5 6q1 12-8 14Q5 31 3 19Z" />
      <path fill="#ffb14c" d="m23 10 14 1q-4 9-11 8-4-1-5-6Z" />
      <path d="m24 11 11 1" stroke="#975829" strokeWidth="1.2" />
      {mood === 'idle' ? <path d="M18 9q2 2 4 0" /> : <circle cx="21" cy="8.5" r="1.45" fill="#293746" stroke="none" />}
      <path d={cycling ? 'M9 20q5 8 15 1' : 'M7 22q5 6 11 0'} stroke="#9a8073" />
    </g>
    {cycling && <path className="dchat-pet-leg" d="m15 22 6 2-2 4" stroke="#b36530" strokeWidth="2.6" />}
    {mood === 'idle' && <g className="dchat-pet-cup">
      <path d="M32 26h2q5 0 2 5l-4 1" fill="#ffe0a2" />
      <path d="M21 25h12v6q0 5-6 5t-6-5Z" fill="#ef885d" />
      <path className="dchat-pet-steam" d="M27 22q-2-2 0-4" stroke="#a96c50" />
    </g>}
    {mood === 'attention' && <g className="dchat-pet-flag">
      <path d="m22 36 1-14" strokeWidth="2.5" />
      <path d="m23 22 13-2-3 6 3 3-13 2Z" fill="#ff9d62" />
    </g>}
    {mood === 'done' && <g className="dchat-pet-check">
      <circle cx="29" cy="29" r="8" fill="#70d7a2" />
      <path d="m25 29 3 3 5-6" strokeWidth="2.6" />
    </g>}
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
