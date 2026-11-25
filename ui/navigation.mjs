import { createComposerDrafts } from './composer-draft.mjs'

const sessionKey = 'dsh-direct-chat.active-session'
const newTargetKey = 'dsh-direct-chat.new-target'
const cwdKey = 'dsh-direct-chat.cwd'

function browserStorage() {
  try { return globalThis.localStorage } catch {}
}

export function createNavigation(refreshHistory, storage = browserStorage()) {
  const drafts = createComposerDrafts(storage)
  const read = key => { try { return storage?.getItem(key) } catch {} }
  let number = 0
  const createTarget = (engine, cwd) => ({ engine, cwd, key: 'draft-' + ++number })
  const savedId = read(sessionKey)
  let savedNew
  try { savedNew = JSON.parse(read(newTargetKey) ?? 'null') } catch {}
  let target = savedId ? { id: savedId, key: savedId } : createTarget(
    typeof savedNew?.engine === 'string' ? savedNew.engine : undefined,
    typeof savedNew?.cwd === 'string' ? savedNew.cwd : read(cwdKey) || undefined,
  )

  const listeners = new Set()
  const set = next => {
    target = next
    try {
      if (next.id) {
        storage?.setItem(sessionKey, next.id)
        storage?.removeItem(newTargetKey)
      } else {
        const { engine, cwd } = next
        storage?.setItem(newTargetKey, JSON.stringify({ engine, cwd }))
        storage?.removeItem(sessionKey)
      }
    } catch {}
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => target,
    draftFor: drafts.forTarget,
    refreshHistory,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start(engine, cwd = read(cwdKey) || undefined) {
      if (!target.id && target.engine === engine && target.cwd === cwd) return
      set(createTarget(engine, cwd))
    },
    rememberCwd(cwd) {
      if (cwd) { try { storage?.setItem(cwdKey, cwd) } catch {} }
    },
    open(id, expected) {
      if (expected) void refreshHistory()
      if ((expected && target !== expected) || target.id === id) return
      set({ id, key: expected?.key ?? id })
    },
    forget(ids, { engine, cwd }) {
      for (const id of ids) drafts.forgetSession(id)
      if (ids.has(target.id)) set(createTarget(engine, cwd))
      else {
        try {
          if (ids.has(read(sessionKey))) storage?.removeItem(sessionKey)
        } catch {}
      }
    },
  }
}
