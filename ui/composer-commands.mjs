export function slashCommandAt(text, caret, selectionEnd = caret) {
  if (caret !== selectionEnd) return null
  const match = /^(\s*)\/([^/\s]*)/.exec(text)
  if (!match) return null
  const start = match[1].length
  const end = match[0].length
  if (caret <= start || caret > end || text[end] === '/') return null
  return { start, end, query: text.slice(start + 1, caret) }
}

export function replaceSlashCommand(text, { start, end }, name) {
  const before = text.slice(0, start)
  const tail = text.slice(end)
  const prefix = `${before}/${name}`
  return { text: prefix + (tail || ' '), caret: prefix.length + 1 }
}

export function atMentionAt(text, caret, selectionEnd = caret) {
  if (caret !== selectionEnd || caret <= 0) return null
  const before = text.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  const query = match[1]
  const start = caret - query.length - 1
  const tail = text.slice(caret)
  const tailEnd = tail.search(/\s/)
  const end = caret + (tailEnd === -1 ? tail.length : tailEnd)
  return { start, end, query }
}

export function splitMentionQuery(query) {
  const clean = String(query || '').replace(/^\/+/, '')
  const slash = clean.lastIndexOf('/')
  if (slash === -1) return { dir: '', needle: clean }
  return { dir: clean.slice(0, slash), needle: clean.slice(slash + 1) }
}

export function filterMentionEntries(entries, needle) {
  const q = String(needle || '').trim().toLowerCase()
  const list = Array.isArray(entries) ? entries : []
  if (!q) return list.slice(0, 60)
  const starts = item => item.name.toLowerCase().startsWith(q)
  return list
    .filter(item => item.name.toLowerCase().includes(q) || item.path.toLowerCase().includes(q))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)) || Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    .slice(0, 60)
}

export function replaceAtMention(text, { start, end }, path, { drill = false } = {}) {
  const before = text.slice(0, start)
  const tail = text.slice(end)
  const formatted = !drill && /\s/.test(path) ? `@"${path}"` : `@${path}`
  const suffix = drill ? '/' : (tail ? '' : ' ')
  const inserted = `${formatted}${suffix}`
  return { text: `${before}${inserted}${tail}`, caret: before.length + inserted.length }
}

export function commandEntries(commands) {
  const native = new Map()
  for (const command of Array.isArray(commands) ? commands : []) {
    const { name, description, input } = command ?? {}
    if (typeof name !== 'string' || !/^[^/\\\s\u0000-\u001f\u007f]+$/.test(name)) continue
    const key = name.toLowerCase()
    if (native.has(key)) continue
    native.set(key, { id: `cli:${name}`, name, label: `/${name}`,
      description: typeof description === 'string' ? description : '', hint: typeof input?.hint === 'string' ? input.hint : '' })
  }
  return [...native.values()]
}

export function filterCommandEntries(entries, query) {
  const needle = query.trim().toLowerCase().replace(/^\//, '')
  const starts = entry => [entry.name, entry.title].some(value => typeof value === 'string' && value.toLowerCase().startsWith(needle))
  return entries.filter(entry => !needle || [entry.name, entry.title, entry.description, entry.hint]
    .some(value => typeof value === 'string' && value.toLowerCase().includes(needle)))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)))
}

const addOrder = ['file', 'goal', 'plan', 'feedback', 'parallel']
const commandOrder = ['compact', 'permission', 'model', 'export']
const sectionOrder = [...addOrder, ...commandOrder]

export function composerMenuEntries(entries, addItems, query, t) {
  const rank = entry => {
    const index = sectionOrder.indexOf(entry.name)
    return index === -1 ? sectionOrder.length : index
  }
  const visible = query
    ? filterCommandEntries(entries, query)
    : [...addItems, ...entries].sort((a, b) => rank(a) - rank(b))
  return visible.map(entry => ({
    entry,
    candidate: {
      name: entry.name,
      label: entry.title,
      description: entry.description || entry.hint || undefined,
      icon: entry.icon,
      section: query ? undefined : t(addOrder.includes(entry.name) ? 'plus.add' : 'plus.commands'),
    },
  }))
}
