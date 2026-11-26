import { createSession, createWorktree, sessionAction } from './chat-state.mjs'

export function createWorktreePrompt(cwd, from, api = { createSession, createWorktree, sessionAction }) {
  let path
  let destination
  return async ({ engine, profileId, options, payload, navigation, target }) => {
    if (!path) path = (await api.createWorktree(cwd, from)).path
    if (!destination || destination.engine !== engine || destination.profileId !== profileId) {
      const session = await api.createSession(engine, path, profileId)
      destination = { engine, profileId, session }
    }
    for (const { id, currentValue } of options) {
      if (typeof currentValue !== 'string') continue
      const current = destination.session.options?.find(option => option.id === id)
      if (current?.currentValue === currentValue) continue
      destination.session = await api.sessionAction(destination.session.id, 'configure', { id, value: currentValue })
    }
    await api.sessionAction(destination.session.id, 'prompt', payload)
    if (navigation.getSnapshot() === target) navigation.rememberCwd(path)
    navigation.open(destination.session.id, target)
  }
}
