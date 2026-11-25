export const codexCommands = [
  { name: 'compact', description: 'Compact the conversation context.' },
  { name: 'mcp', description: 'List MCP server connection and authentication status.' },
  {
    name: 'goal', description: 'Show, pause, clear, or set a paused goal. Automatic execution is not available here.',
    input: { hint: 'set <objective> | pause | clear' },
  },
  {
    name: 'review', description: 'Run a Codex code review on this conversation.',
    input: { hint: 'uncommitted | base <branch> | commit <sha> | custom <instructions>' },
  },
]

export function parseCodexCommand(text, attachmentCount = 0) {
  const command = /^\/(compact|review|mcp|goal)(?=\s|$)/.exec(text.trimStart())
  if (!command) return
  const [, name] = command
  const args = text.trimStart().slice(command[0].length).trim()
  if (attachmentCount) throw new Error(`/${name} does not accept attachments`)
  if (name === 'compact' || name === 'mcp') {
    if (args) throw new Error(`/${name} does not accept arguments`)
    return { name }
  }
  if (name === 'goal') {
    if (!args) return { name, action: 'get' }
    if (args === 'pause') return { name, action: 'set', status: 'paused' }
    if (args === 'clear') return { name, action: 'clear' }
    const objective = /^set\s+([\s\S]+)$/.exec(args)?.[1]?.trim()
    if (objective) return { name, action: 'set', objective, status: 'paused' }
    throw new Error('Use /goal, /goal set <objective>, /goal pause, or /goal clear. Automatic execution is not available here.')
  }

  const mode = /^\S*/.exec(args)[0]
  const value = args.slice(mode.length).trimStart()
  switch (mode) {
    case '':
    case 'uncommitted':
      if (value) throw new Error('Use /review uncommitted without additional arguments')
      return { name, target: { type: 'uncommittedChanges' } }
    case 'base':
      if (!/^[^-\s][^\s]*$/.test(value)) throw new Error('Use /review base <branch> with one branch name')
      return { name, target: { type: 'baseBranch', branch: value } }
    case 'commit':
      if (!/^[a-f\d]{4,64}$/i.test(value)) throw new Error('Use /review commit <sha> with a commit hash')
      return { name, target: { type: 'commit', sha: value } }
    case 'custom':
      if (!value) throw new Error('Use /review custom <instructions>')
      return { name, target: { type: 'custom', instructions: value } }
    default:
      return { name, target: { type: 'custom', instructions: args } }
  }
}
