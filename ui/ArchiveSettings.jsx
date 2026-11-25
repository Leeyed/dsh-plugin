import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { archivedSessions } from './archive-settings.mjs'
import { engineLabel, sessionAction } from './chat-state.mjs'

export const archiveSettingsCopy = {
  en: {
    'archiveSettings.title': 'CLI session archive',
    'archiveSettings.convert': 'Archive in CLI',
    'archiveSettings.converted': 'Archived {name} in its CLI.',
    'archiveSettings.convertFailed': 'Could not archive {name} in its CLI.',
    'archiveSettings.loading': 'Loading archived CLI sessions…',
    'archiveSettings.empty': 'No archived CLI sessions.',
    'archiveSettings.loadFailed': 'Could not load the CLI session archive.',
    'archiveSettings.retry': 'Retry',
    'archiveSettings.restore': 'Restore',
    'archiveSettings.restoreNamed': 'Restore {name}',
    'archiveSettings.restoring': 'Restoring…',
    'archiveSettings.restored': 'Restored {name}.',
    'archiveSettings.restoreFailed': 'Could not restore {name}.',
    'archiveSettings.legacy': 'Old DSH archive',
    'archiveSettings.unavailable': 'Restore unavailable',
  },
  zh: {
    'archiveSettings.title': 'CLI 会话归档',
    'archiveSettings.convert': '转为原生归档',
    'archiveSettings.converted': '已将 {name} 转为原生归档。',
    'archiveSettings.convertFailed': '无法将 {name} 转为原生归档。',
    'archiveSettings.loading': '正在加载已归档的 CLI 会话…',
    'archiveSettings.empty': '暂无已归档的 CLI 会话。',
    'archiveSettings.loadFailed': '无法加载 CLI 会话归档。',
    'archiveSettings.retry': '重试',
    'archiveSettings.restore': '恢复',
    'archiveSettings.restoreNamed': '恢复 {name}',
    'archiveSettings.restoring': '正在恢复…',
    'archiveSettings.restored': '已恢复 {name}。',
    'archiveSettings.restoreFailed': '无法恢复 {name}。',
    'archiveSettings.legacy': '旧版 DSH 归档',
    'archiveSettings.unavailable': '无法恢复',
  },
}

export function ArchiveSettings({ history, engineSource, t }) {
  const { byCwd, pending, error } = useSyncExternalStore(history.subscribe, history.getSnapshot)
  const { engines } = useSyncExternalStore(engineSource.subscribe, engineSource.getSnapshot)
  const rows = useMemo(() => archivedSessions(byCwd), [byCwd])
  const heading = useRef(null)
  const headingId = useId()
  const restoringId = useRef(null)
  const [restoring, setRestoring] = useState(null)
  const [notice, setNotice] = useState(null)

  useEffect(() => {
    if (!history.getSnapshot().pending) void history.refresh()
  }, [history])

  async function changeArchive(row, name, button, archived) {
    if (restoringId.current !== null) return
    restoringId.current = row.id
    setRestoring({ id:row.id, archived })
    setNotice(null)
    const wasFocused = document.activeElement === button
    try {
      await sessionAction(row.id, 'archive', { archived })
      if (wasFocused && (document.activeElement === button || document.activeElement === document.body)) {
        heading.current?.focus({ preventScroll: true })
      }
      setNotice({ name, success: true, key: archived ? 'archiveSettings.converted' : 'archiveSettings.restored' })
      await history.refresh()
    } catch {
      setNotice({ name, success: false, key: archived ? 'archiveSettings.convertFailed' : 'archiveSettings.restoreFailed' })
    } finally {
      restoringId.current = null
      setRestoring(null)
    }
  }

  return <section className="dchat-archive-settings" aria-labelledby={headingId}>
    <h2 ref={heading} id={headingId} tabIndex={-1}>{t('archiveSettings.title')}</h2>
    {error && <div className="dchat-archive-load-error">
      <span role="alert">{t('archiveSettings.loadFailed')}</span>
      <Button variant="outline" size="sm" onClick={() => void history.refresh()}>{t('archiveSettings.retry')}</Button>
    </div>}
    {notice && <p role={notice.success ? 'status' : 'alert'} className={notice.success ? undefined : 'dchat-archive-error'}>
      {t(notice.key, { name: notice.name })}
    </p>}
    {rows.length > 0 ? <ul className="dchat-archive-rows">
      {rows.map(row => {
        const engine = engineLabel(engines, row.engine)
        const name = row.title || row.id
        const canRestore = row.archiveMode === 'native' || row.archiveMode === 'legacy'
        return <li className="dchat-archive-row" key={row.id}>
          <div className="dchat-archive-detail">
            <span className="dchat-archive-title" title={name}>{name}</span>
            <div className="dchat-archive-meta">
              <span className="dchat-archive-engine">{engine}</span>
              {row.archiveMode === 'legacy' && <span>{t('archiveSettings.legacy')}</span>}
              {row.cwd && <span className="dchat-archive-path" title={row.cwd}>{row.cwd}</span>}
            </div>
          </div>
          {row.archiveMode === 'legacy' && row.canNativeArchive && <Button variant="outline" size="sm" disabled={restoring !== null}
            onClick={event => void changeArchive(row, name, event.currentTarget, true)}>{t('archiveSettings.convert')}</Button>}
          {canRestore ? <Button variant="outline" size="sm"
            aria-label={t('archiveSettings.restoreNamed', { name })} aria-disabled={restoring !== null || undefined}
            onClick={event => void changeArchive(row, name, event.currentTarget, false)}>
            {t(restoring?.id === row.id && !restoring.archived ? 'archiveSettings.restoring' : 'archiveSettings.restore')}
          </Button> : <span className="dchat-archive-unavailable">{t('archiveSettings.unavailable')}</span>}
        </li>
      })}
    </ul> : !error && <p role="status">{t(pending ? 'archiveSettings.loading' : 'archiveSettings.empty')}</p>}
  </section>
}
