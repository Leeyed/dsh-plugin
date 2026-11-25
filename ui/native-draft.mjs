export function startDirectFromNative(ctx, navigation, engine, cwd) {
  const sessionId = ctx.get('uiSession')?.adapter.current.getSnapshot()?.key
  const scope = sessionId === undefined ? undefined : ctx.get('sessions')?.scope(sessionId)
  const text = scope && ctx.get('conversation')?.input.for(scope).state.getSnapshot().draft

  navigation.start(engine, cwd)
  if (!text) return

  const composer = navigation.draftFor(navigation.getSnapshot(), engine)
  const target = composer.getSnapshot()
  if (!target.sending && !target.text && !target.command && !target.attachments.length) {
    composer.setText(text)
  }
}
