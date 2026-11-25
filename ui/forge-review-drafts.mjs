export const localDiffScopes = ['uncommitted', 'unstaged', 'staged']

const emptyThreads = []

function validSelection(selection) {
  const source = selection?.source
  const comment = selection?.comment
  return source?.kind === 'local' && localDiffScopes.includes(source.scope) && source.base === null &&
    source.baseRef === null && source.commits === null && typeof comment?.path === 'string' &&
    (comment.side === 'L' || comment.side === 'R') && Number.isSafeInteger(comment.startLine) && comment.startLine > 0 &&
    Number.isSafeInteger(comment.endLine) && comment.endLine >= comment.startLine &&
    typeof comment.hunk === 'string' && typeof comment.body === 'string'
}

// Forge's pending records represent drafts on a change request. Direct sessions store local drafts
// separately and expose the same fileComments/editThread interface to the native comment cards.
export function createForgeReviewDrafts(id, cwd, {
  storage = () => globalThis.localStorage, events = globalThis.window,
  newId = () => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'),
} = {}) {
  const storageKey = `dsh-direct-chat.forge-review.v1.${JSON.stringify([id, cwd])}`
  const listeners = new Set()
  const files = new Map()
  const read = () => {
    try {
      const raw = storage().getItem(storageKey)
      const threads = raw === null ? emptyThreads : JSON.parse(raw)
      if (!Array.isArray(threads) || !threads.every(thread => typeof thread?.key === 'string' &&
        thread.kind === 'pending' && validSelection(thread.selection))) throw new Error('Invalid review drafts')
      return { raw, threads, error: null }
    } catch { return { threads: emptyThreads, error: 'load' } }
  }
  let state = read()
  const publish = next => {
    if (next.raw === state.raw && next.error === state.error) return
    state = next
    for (const listener of listeners) listener()
  }
  const reload = event => {
    if (event.key === storageKey || event.key === null) publish(read())
  }
  const update = change => {
    const current = read()
    if (current.error) { publish(current); return false }
    const threads = change(current.threads)
    if (!threads) return false
    const raw = JSON.stringify(threads)
    try {
      if (threads.length) storage().setItem(storageKey, raw)
      else storage().removeItem(storageKey)
    } catch {
      publish({ ...state, error: 'save' })
      return false
    }
    publish({ raw: threads.length ? raw : null, threads, error: null })
    return true
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      if (!listeners.size) {
        events?.addEventListener('storage', reload)
        publish(read())
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) events?.removeEventListener('storage', reload)
      }
    },
    save(selection) {
      if (!validSelection(selection) || !selection.comment.body.trim()) return false
      return update(threads => [...threads, { kind: 'pending', key: newId(), selection }])
    },
    editThread(key, body) {
      return update(threads => {
        if (!threads.some(thread => thread.key === key)) return
        return threads.flatMap(thread => {
          if (thread.key !== key) return [thread]
          return body === null ? [] : [{ ...thread, selection: {
            ...thread.selection, comment: { ...thread.selection.comment, body },
          } }]
        })
      })
    },
    fileComments(path, source) {
      const key = JSON.stringify([source.scope, path])
      const previous = files.get(key)
      if (previous?.owner === state) return previous.value
      const threads = state.threads.filter(({ selection }) => selection.source.scope === source.scope && selection.comment.path === path)
      const value = { threads, locked: state.error === 'load', error: state.error }
      files.set(key, { owner: state, value })
      return value
    },
  }
}
