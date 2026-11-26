const nativeSlot = 'sidebar.workspaces.directoryFlow'
export const sidebarDirectorySlot = 'direct-chat.sidebar.directoryFlow'

// The merged sidebar owns a different child slot. Mount the host's elected
// picker in that slot so the renderer supplies its normal props and lifecycle.
export function connectSidebarDirectoryFlow(slots) {
  let current
  let remove
  const sync = () => {
    const [entry] = slots.entriesOfSlot(nativeSlot)
    if (entry === current) return
    remove?.()
    remove = undefined
    current = entry
    if (entry) {
      const { select, inject, locale } = entry
      remove = slots.register({ name: sidebarDirectorySlot, select, inject, locale }, entry.component)
    }
  }
  sync()
  const unsubscribe = slots.subscribe(nativeSlot, sync)
  return () => {
    unsubscribe()
    remove?.()
  }
}
