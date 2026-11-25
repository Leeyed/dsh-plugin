export function codexPromptCommand(text) {
  return /^\/(review|compact)(?:\s|$)/.exec(text.trimStart())?.[1]
}

export function reviewDraft(target, value) {
  if (target === 'uncommitted') return '/review uncommitted'
  const argument = value.trim()
  if ((target === 'base' && !argument.startsWith('-') && /^\S+$/.test(argument)) ||
      (target === 'commit' && /^[\da-f]{4,64}$/i.test(argument)) ||
      (target === 'custom' && argument)) {
    return `/review ${target} ${argument}`
  }
}
