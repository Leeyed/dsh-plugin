import { useId, useRef, useState, useSyncExternalStore } from 'react'
import {
  IconChevronDownOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'

export function WorkspacePicker({ value, onChange, disabled, t, renderFactorySlot, workspaceSource }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)
  const valueId = useId()
  const { items } = useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot, workspaceSource.getSnapshot)
  const selected = items.find(workspace => workspace.path === value)
  const folderName = value?.split(/[/\\]/).filter(Boolean).at(-1) || value
  const Folder = value ? IconFolderOpenRegular : IconFolderCloseRegular

  return <div className="dchat-workspace-picker">
    <button ref={anchorRef} className="dchat-workspace-trigger" type="button"
      disabled={disabled} title={value || t('cwd')}
      aria-label={t('cwd')} aria-describedby={valueId} aria-haspopup="menu" aria-expanded={open && !disabled}
      onClick={() => setOpen(!open)}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' || open) return
        event.preventDefault()
        setOpen(true)
      }}>
      <Folder size={16} />
      <span className="dchat-workspace-selection" id={valueId}>{selected?.title || folderName || t('cwd.default')}</span>
      <IconChevronDownOutlineRegular className="dchat-workspace-chevron" size={12} />
    </button>
    {renderFactorySlot('workspace.picker', {
      open: open && !disabled,
      anchorRef,
      selectedId: selected?.workspaceId,
      onClose: () => setOpen(false),
      onPick: workspaceId => {
        setOpen(false)
        // A newly added workspace updates the source before the factory reports its ID.
        const workspace = workspaceSource.getSnapshot().items.find(item => item.workspaceId === workspaceId)
        if (workspace && !disabled) onChange(workspace.path)
      },
    })}
  </div>
}
