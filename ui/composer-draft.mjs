const prefix = 'dsh-direct-chat.composer-draft.'
const empty = { text: '', command: null, attachments: [], sending: false, error: '' }

export function createComposerDrafts(storage) {
  const drafts = new Map()
  return {
    forTarget(target, engine) {
      const key = prefix + JSON.stringify(target.id
        ? ['session', target.id] : ['new', engine ?? null, target.cwd ?? ''])
      if (!drafts.has(key)) drafts.set(key, createDraft(storage, key))
      return drafts.get(key)
    },
    forgetSession(id) {
      const key = prefix + JSON.stringify(['session', id])
      drafts.get(key)?.forget()
      drafts.delete(key)
      try { storage?.removeItem(key) } catch {}
    },
  }
}

function createDraft(storage, key) {
  let snapshot = { ...empty }
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? 'null')
    if (typeof saved?.text === 'string') snapshot.text = saved.text
    if (typeof saved?.command === 'string' && /^[^/\\\s]+$/.test(saved.command)) snapshot.command = saved.command
  } catch {}

  const listeners = new Set()
  let forgotten = false
  const update = next => {
    if (next.text !== snapshot.text || next.command !== snapshot.command) {
      try {
        const { text, command } = next
        if (text || command) storage?.setItem(key, JSON.stringify({ text, command }))
        else storage?.removeItem(key)
      } catch {}
    }
    snapshot = next
    for (const listener of listeners) listener()
  }
  const set = (field, value) => {
    if (forgotten || snapshot.sending) return
    const next = typeof value === 'function' ? value(snapshot[field]) : value
    if (snapshot[field] !== next) update({ ...snapshot, [field]: next, error: '' })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setText: value => set('text', value),
    setCommand: value => set('command', value),
    setAttachments: value => set('attachments', value),
    beginSend() {
      if (forgotten || snapshot.sending) return
      update({ ...snapshot, sending: true, error: '' })
      let settled = false
      return (accepted, error) => {
        if (forgotten || settled) return
        settled = true
        update(accepted ? empty : { ...snapshot, sending: false, error })
      }
    },
    forget() {
      forgotten = true
      update(empty)
    },
  }
}
