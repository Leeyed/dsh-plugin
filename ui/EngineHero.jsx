import { useEffect, useId, useRef, useState } from 'react'
import { FishLogo, IconChevronDownOutlineRegular, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import antigravityLogo from './engine-logos/agy.png'
import claudeLogo from './engine-logos/claude.png'
import codexLogo from './engine-logos/codex.png'

const logos = new Map([
  ['agy', antigravityLogo],
  ['claude', claudeLogo],
  ['codex', codexLogo],
])

export function EngineLogo({ engine, label = engine, icon, size = 24 }) {
  if (engine === null) return <FishLogo size={size} />
  const logo = icon || logos.get(engine)
  if (logo) return <img src={logo} alt="" width={size} height={size} draggable={false} />
  return <span className="dchat-engine-initial" aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.68 }}>
    {Array.from(label || '')[0]?.toLocaleUpperCase()}
  </span>
}

export function EngineDropdown({ selected = null, engines, status, reload, onSelect, disabled = false, t }) {
  const [open, setOpen] = useState(false)
  const options = [{ id: null, label: t('engine.native'), meta: null }, ...engines]
  const active = options.find(option => option.id === selected) ?? { id: selected, label: selected || t('engine.native') }
  if (!engines.length && status === 'ready' && selected === null) return null
  const items = options.map(({ id, label, meta, status: cli }) => ({
    id: id === null ? '__native__' : id,
    label: cli?.installed === false ? label + ' · ' + t('engine.notInstalled') : label,
    disabled: cli?.installed === false,
    icon: <EngineLogo engine={id} label={label} icon={meta?.icon} size={16} />,
  }))
  return <Menu open={open && !disabled} portal side="bottom" align="start" dense items={items}
    selectedId={selected === null ? '__native__' : selected}
    onClose={() => setOpen(false)}
    onSelect={id => {
      setOpen(false)
      void onSelect(id === '__native__' ? null : id)
    }}
    anchor={<button type="button" className="dchat-workspace-trigger" disabled={disabled}
      aria-haspopup="menu" aria-expanded={open && !disabled}
      onClick={() => {
        if (!open && status !== 'loading') void reload?.()
        setOpen(v => !v)
      }}>
      <EngineLogo engine={active.id} label={active.label} icon={active.meta?.icon} size={16} />
      <span className="dchat-workspace-selection">{active.label}</span>
      <IconChevronDownOutlineRegular className="dchat-workspace-chevron" size={12} />
    </button>} />
}

export function EngineHero({ selected, engines, status, reload, onSelect, nativeHeadline, t }) {
  const options = [{ id: null, label: t('engine.native') }, ...engines]
  const active = options.find(option => option.id === selected) ?? { id: selected, label: selected || t('panel') }
  const root = useRef(null)
  const trigger = useRef(null)
  const menuId = useId()
  const changing = useRef(false)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    const onPointerDown = event => {
      if (!root.current?.contains(event.target)) setOpen(false)
    }
    const onKeyDown = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  async function select(id) {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
    if (selected === id || changing.current) return
    changing.current = true
    setBusy(true)
    setFailed(false)
    try { await onSelect(id) }
    catch { setFailed(true) }
    finally {
      changing.current = false
      setBusy(false)
    }
  }

  return <div ref={root} className="dchat-engine-hero">
    <h1 className="dchat-engine-headline">
      <button ref={trigger} type="button" className="dchat-engine-headline-button"
        aria-expanded={open} aria-controls={open ? menuId : undefined} aria-description={t('engine.choose')}
        aria-disabled={busy || undefined} onClick={() => {
          if (changing.current) return
          if (!open && status !== 'loading') void reload()
          setOpen(value => !value)
        }}>
        {nativeHeadline ?? <>
          {selected !== undefined && <EngineLogo engine={active.id} label={active.label} icon={active.meta?.icon} size={38} />}
          <span>{active.label}</span>
        </>}
      </button>
    </h1>
    {open && <div id={menuId} className="dchat-engine-popover">
      <div className="dchat-engine-cards" role="group" aria-label={t('engine.choose')}>
        {options.map(({ id, label, meta, status: engStatus }) => <button key={id === null ? 'dsh' : `cli:${id}`} type="button"
          className="dchat-engine-card" data-engine={id === null ? 'dsh' : `cli:${id}`} aria-pressed={selected === id}
          style={meta?.accentColor ? { '--dchat-card-accent': meta.accentColor } : undefined}
          onClick={() => void select(id)}>
          <EngineLogo engine={id} label={label} icon={meta?.icon} />
          <span>{label}</span>
          {engStatus?.installed === false && <span className="dchat-engine-version">{t('engine.notInstalled')}</span>}
          {engStatus?.version && <span className="dchat-engine-version">v{engStatus.version}</span>}
        </button>)}
      </div>
      {(status === 'idle' || status === 'loading') &&
        <p className="dchat-engine-availability" role="status">{t('engine.loading')}</p>}
      {status === 'error' && <div className="dchat-engine-availability">
        <span role="status">{t('engine.failed')}</span>
        <button type="button" onClick={() => void reload()}>{t('engine.retry')}</button>
      </div>}
    </div>}
    {failed && <p className="dchat-engine-availability" role="alert">{t('request.failed')}</p>}
  </div>
}
