export function createWorkspaceDiffController() {
  const listeners = new Set()
  let snapshot = { open: false, view: 'changes', target: null, file: null, layoutSeat: false }
  const publish = next => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const toggle = view => publish({ ...snapshot, view, open: !snapshot.open || snapshot.view !== view })
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    toggle() { toggle('changes') },
    openGuide() { publish({ ...snapshot, view: 'guide', open: true, file: null }) },
    toggleFiles() {
      const open = !snapshot.open || snapshot.view !== 'files' || Boolean(snapshot.file)
      publish({ ...snapshot, view: 'files', open, file: null })
    },
    browseFiles() { publish({ ...snapshot, view: 'files', open: true, file: null }) },
    openFile(id, requested) {
      const target = snapshot.target
      if (!id || target?.id !== id || typeof requested?.path !== 'string' || !requested.path) return
      publish({ ...snapshot, view: 'files', open: true, file: { id, cwd: target.cwd, requested } })
    },
    close() { if (snapshot.open) publish({ ...snapshot, open: false }) },
    addReviewToInput(target, format) {
      return target === snapshot.target && target?.addReviewToInput?.(format) === true
    },
    useLayoutSeat(layoutSeat) { publish({ ...snapshot, layoutSeat }) },
    bindTarget(target) {
      const file = snapshot.file
      publish({ ...snapshot, target, file: file?.id === target?.id && file?.cwd === target?.cwd ? file : null })
      return () => {
        if (snapshot.target === target) publish({ ...snapshot, target: null })
      }
    },
  }
}

export function appendReviewQuote(draft, format) {
  const indices = Array.from(draft.matchAll(/(?:^|\n)(?:> )?## User Comment (\d+)/g), match => Number(match[1]))
  const last = indices.reduce((latest, index) => Number.isSafeInteger(index) ? Math.max(latest, index) : latest, 0)
  const separator = !draft || draft.endsWith('\n\n') ? '' : draft.endsWith('\n') ? '\n' : '\n\n'
  return draft + separator + format(last + 1)
}

export function workspaceSessionKey(target) {
  return JSON.stringify([target?.id, target?.cwd])
}

export function workspaceTabMenuGroup(surface, paneId, tabId) {
  const tabs = surface?.layout.nodes[paneId]?.tabs
  const index = tabs?.indexOf(tabId) ?? -1
  if (index < 0) return null
  return { others: tabs.filter(id => id !== tabId), right: tabs.slice(index + 1) }
}
