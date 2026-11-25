import { sidebarTime } from './sidebar-history.mjs'

export function archivedSessions(byCwd) {
  const recency = row => sidebarTime(row.updatedAt) || sidebarTime(row.createdAt)
  return [...byCwd.values()].flat().filter(row => row.archived)
    .sort((a, b) => recency(b) - recency(a))
}
