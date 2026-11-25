export function startDirectFromNative(ctx, navigation, engine, cwd) {
  const sessionId = ctx.get('uiSession')?.adapter.current.getSnapshot()?.key
  const scope = sessionId === undefined ? undefined : ctx.get('sessions')?.scope(sessionId)
  const nativeInput = scope && ctx.get('conversation')?.input.for(scope)
  const text = nativeInput?.state.getSnapshot().draft

  if (cwd) navigation.rememberCwd(cwd)
  navigation.start(engine, cwd)
  if (!text) return

  const composer = navigation.draftFor(navigation.getSnapshot(), engine)
  const target = composer.getSnapshot()
  if (!target.sending && !target.text && !target.command && !target.attachments.length) {
    composer.setText(text)
    nativeInput?.setDraft?.('')
  }
}

export async function startNativeFromDirect(ctx, workspaceId, cwd, draft) {
  if (!workspaceId && cwd) {
    const navigationSignal = ctx.layout.beginNavigation()
    workspaceId = (await ctx.workspaces.create({ path: cwd })).workspaceId
    if (navigationSignal.aborted) return false
  }
  if (workspaceId) await ctx.uiWorkspace.openWorkspace(workspaceId)
  else ctx.uiWorkspace.startSession()

  if (!draft) return false
  const sessionId = ctx.get('uiSession')?.adapter.current.getSnapshot()?.key
  const scope = sessionId === undefined ? undefined : ctx.get('sessions')?.scope(sessionId)
  const nativeInput = scope && ctx.get('conversation')?.input.for(scope)
  if (!nativeInput || nativeInput.state.getSnapshot().draft) return false
  nativeInput.setDraft(draft)
  return true
}
