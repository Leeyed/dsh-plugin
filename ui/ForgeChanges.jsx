import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Button, IconChevronDownOutlineRegular, IconChevronsUpDownOutlineRegular, IconCompareSplitOutlineRegular,
  IconListPenOutlineRegular, IconNowrapFillRegular, IconWorkspaceTreeOutlineRegular, IconWrapFillRegular,
  Menu, PathLabel, StateDot, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { ChangedFilesMenu } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/ChangedFiles.tsx'
import { Counts, DiffFile } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/DiffFile.tsx'
import { FileTreePane } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/FileTreePane.tsx'
import { RefreshGlyph } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/RefreshGlyph.tsx'
import { HideTestsSwitch, LENSES, LensControl, LensMenu, ViewedProgress } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/ReviewControls.tsx'
import { ReviewThread, useFileReview } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/ReviewThread.tsx'
import { ViewOptionsMenu } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/ViewOptionsMenu.tsx'
import { drawnLines, matchesHunks, textLines } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/diff-rows.ts'
import { changedFileTree, filesInTreeOrder } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/file-tree.ts'
import { en, zh } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/locales.ts'
import { formatReviewComment } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/review.ts'
import { SectionReach } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/section-reach.ts'
import { observeToolbarFold } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/toolbar-fold.ts'
import { ViewedFiles, viewedStateOf } from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/viewed-files.ts'
import css from '@deepseek-ai/dsh-experimental-client-ui-forge/src/client/ChangesTab.module.css'
import { createForgeReviewDrafts, localDiffScopes } from './forge-review-drafts.mjs'

const emptyFiles = []
const noGaps = new Set()
const noContext = new Map()
const initialTree = { query: '', collapsed: {}, selected: null }
const largeFileLines = 1000
const initiallyOpenLines = 5000

export const forgeCopy = {
  en: { ...en, 'direct.chooseWorkspace': 'Choose a workspace or open a conversation to view local changes.',
    'direct.contextFailed': 'Could not load unchanged lines.', 'direct.contextTooLarge': 'The unchanged lines exceed the display limit.',
    'direct.copyFailed': 'Could not copy the path.', 'review.publish': 'Save draft', 'review.publishing': 'Saving draft…',
    'review.browserDraft': 'Local draft', 'review.unknown': 'Could not save the review draft.' },
  zh: { ...zh, 'direct.chooseWorkspace': '选择工作目录或打开会话后，可查看本地变更。',
    'direct.contextFailed': '无法读取未改动的行。', 'direct.contextTooLarge': '未改动的行超出显示上限。',
    'direct.copyFailed': '无法复制路径。', 'review.publish': '保存草稿', 'review.publishing': '正在保存草稿…',
    'review.browserDraft': '本地草稿', 'review.unknown': '无法保存评审草稿。' },
}

function ScopeMenu({ scope, choose, available, t }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal dense autoFocus selectedId={scope}
    items={localDiffScopes.map(id => ({ id, label: t(`diff.scope.${id}`) }))}
    onClose={() => setOpen(false)} onSelect={id => { setOpen(false); choose(id) }}
    anchor={<button type="button" className={css.select} disabled={!available} aria-haspopup="menu"
      aria-expanded={open} data-forge-scope={scope} onClick={() => setOpen(value => !value)}>
      {t(`diff.scope.${scope}`)}<IconChevronDownOutlineRegular size={12} />
    </button>} />
}

async function readChanges(id, action, parameters, signal) {
  const response = await fetch(`/api/direct-chat/sessions/${encodeURIComponent(id)}/${action}?${new URLSearchParams(parameters)}`, {
    signal, credentials: 'same-origin',
  })
  if (!response.ok) throw Object.assign(new Error('Could not read workspace changes'), { status: response.status })
  return response.json()
}

export function ForgeChanges({ target, controller, onQuote, t }) {
  const [scope, setScope] = useState('uncommitted')
  const [revision, setRevision] = useState(0)
  const [loaded, setLoaded] = useState(null)
  const { id, cwd } = target ?? {}
  const available = Boolean(id && cwd)
  const current = loaded?.scope === scope ? loaded : null
  const reading = available && current?.revision !== revision
  const refresh = () => setRevision(value => value + 1)

  useEffect(() => {
    if (!available) return
    const request = new AbortController()
    readChanges(id, 'diff', { scope }, request.signal).then(value => {
      if (!Array.isArray(value.files)) throw new Error('Invalid workspace changes')
      if (!request.signal.aborted) setLoaded({ scope, revision, value, error: null })
    }).catch(error => {
      if (request.signal.aborted) return
      const notice = error.status === 422 ? 'checkout.none' : error.status === 413 ? 'diff.tooLarge' : 'diff.error'
      setLoaded(previous => ({ scope, revision, value: previous?.scope === scope ? previous.value : null, error: notice }))
    })
    return () => request.abort()
  }, [id, cwd, available, scope, revision])

  const [viewedFiles] = useState(() => new ViewedFiles(JSON.stringify([id, cwd])))
  const [drafts] = useState(() => createForgeReviewDrafts(id, cwd))
  return <div className={css.root} data-forge-changes="local" data-dchat-forge-changes="">
    <div className={css.header}>
      <IconListPenOutlineRegular size={16} className={css.headerIcon} />
      <span className={css.headerTitle}>{t('changes.local.title')}</span>
      {cwd && <PathLabel path={cwd} className="dchat-diff-workspace" />}
    </div>
    <ChangesBody key={scope} {...{ id, scope, setScope, current, reading, refresh, available, viewedFiles, drafts, onQuote, t }}
      openFile={path => controller.openFile(id, { path })} />
  </div>
}

function MissingFileDrafts({ path, review, t }) {
  const { threads, locked } = useFileReview(review, path)
  return <section className={css.file}>
    <div className={css.fileHeader}><strong className={css.fileTitle}>{path}</strong></div>
    {threads.map(thread => <ReviewThread key={thread.key} thread={thread} actions={review} locked={locked} outdated t={t} />)}
  </section>
}

function ChangesBody({ id, scope, setScope, current, reading, refresh, available, viewedFiles, drafts, onQuote, openFile, t }) {
  const data = current?.value ?? null
  const [lens, setLens] = useState('all')
  const [hideTests, setHideTests] = useState(false)
  const [split, setSplit] = useState(true)
  const [wrap, setWrap] = useState(true)
  const [treeState, setTreeState] = useState(initialTree)
  const [treePosition, setTreePosition] = useState('left')
  const [treeWidth, setTreeWidth] = useState(240)
  const [chosen, setChosen] = useState(new Map())
  const [revealed, setRevealed] = useState(new Set())
  const [wanted, setWanted] = useState(null)
  const [notice, setNotice] = useState(null)
  const [expandedContext, setExpandedContext] = useState(null)
  const treeId = useId()
  const toolbar = useRef(null)
  const viewport = useRef(null)
  const sections = useRef(new Map())
  const contextRequests = useRef(new Set())
  const [reach] = useState(() => new SectionReach())
  const attachViewport = useCallback(node => { viewport.current = node; reach.attach(node) }, [reach])

  const source = useMemo(() => ({ kind: 'local', scope, base: null, baseRef: null, commits: null }), [scope])
  const marksKey = JSON.stringify(['local', scope, null, null])
  const marks = useSyncExternalStore(viewedFiles.subscribe, () => viewedFiles.marksOf(marksKey))
  const draftState = useSyncExternalStore(drafts.subscribe, drafts.getSnapshot)
  const allFiles = useMemo(() => filesInTreeOrder(changedFileTree(data?.files ?? emptyFiles)), [data])
  const scopedFiles = useMemo(() => hideTests ? allFiles.filter(file => file.layer !== 'test') : allFiles, [allFiles, hideTests])
  const files = useMemo(() => lens === 'all' ? scopedFiles : scopedFiles.filter(file => file.layer === lens), [scopedFiles, lens])
  const filePaths = useMemo(() => new Set(allFiles.map(file => file.path)), [allFiles])
  const orphanPaths = [...new Set(draftState.threads.filter(({ selection }) => selection.source.scope === scope &&
    !filePaths.has(selection.comment.path)).map(({ selection }) => selection.comment.path))]
  const counts = useMemo(() => Object.fromEntries(LENSES.map(layer => [layer, layer === 'all' ? scopedFiles.length :
    scopedFiles.filter(file => file.layer === layer).length])), [scopedFiles])
  const initial = useMemo(() => {
    const paths = new Set()
    let lines = 0
    for (const file of allFiles) {
      if (lines > initiallyOpenLines) break
      if (viewedStateOf(marks, file.path, file.digest) === 'viewed') continue
      paths.add(file.path)
      lines += drawnLines(file)
    }
    return paths
  }, [allFiles, marks])
  const isExpanded = file => chosen.get(file.path) ?? initial.has(file.path)
  const anyExpanded = files.some(isExpanded)

  useLayoutEffect(() => observeToolbarFold(toolbar.current), [])
  useLayoutEffect(() => {
    if (wanted === null) return
    const section = sections.current.get(wanted)
    const scrollport = viewport.current
    if (section && scrollport) scrollport.scrollTop += section.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
    setWanted(null)
  }, [wanted])
  useLayoutEffect(() => () => {
    for (const request of contextRequests.current) request.abort()
    contextRequests.current.clear()
  }, [data])

  const context = expandedContext?.owner === data ? expandedContext.entries : noContext
  const setGap = (path, entry) => setExpandedContext(previous => {
    const entries = new Map(previous?.owner === data ? previous.entries : undefined)
    if (entry) entries.set(path, entry)
    else entries.delete(path)
    return { owner: data, entries }
  })
  const expandGap = (file, index) => {
    const previous = context.get(file.path)
    const open = new Set([...(previous?.open ?? []), index])
    if (previous) { setGap(file.path, { ...previous, open }); return }
    const request = new AbortController()
    contextRequests.current.add(request)
    setGap(file.path, { text: 'loading', open })
    setNotice(null)
    void readChanges(id, 'diff-text', { scope, path: file.path, digest: file.digest }, request.signal)
      .then(({ text }) => {
        if (request.signal.aborted) return
        const lines = typeof text === 'string' ? textLines(text) : undefined
        if (!lines || !matchesHunks(lines, file.hunks)) {
          setGap(file.path, null)
          setNotice({ key: 'toast.expandStale' })
          return
        }
        setGap(file.path, { text: lines, open })
      }).catch(error => {
        if (request.signal.aborted) return
        setGap(file.path, null)
        setNotice({ key: error.status === 409 ? 'toast.expandStale' : error.status === 413 ? 'direct.contextTooLarge' : 'direct.contextFailed' })
      }).finally(() => contextRequests.current.delete(request))
  }
  const choose = (path, expand) => setChosen(current => new Map(current).set(path, expand))
  const jump = path => {
    setTreeState(value => ({ ...value, selected: path }))
    choose(path, true)
    setWanted(path)
  }
  const markViewed = (file, viewed) => {
    if (!viewedFiles.mark(marksKey, allFiles, file.path, viewed)) {
      setNotice({ key: 'viewed.saveFailed' })
      return
    }
    setChosen(current => {
      const next = new Map(current)
      if (viewed) next.delete(file.path)
      else next.set(file.path, true)
      return next
    })
    const section = sections.current.get(file.path)
    if (viewed && section && viewport.current && section.getBoundingClientRect().top < viewport.current.getBoundingClientRect().top) {
      setWanted(file.path)
    }
  }
  const fileActions = file => {
    const copy = { label: 'diff.copyPath', run: async () => {
      const copied = await writeClipboard(file.path).catch(() => false)
      setNotice({ key: copied ? 'toast.pathCopied' : 'direct.copyFailed' })
    } }
    return file.status === 'deleted' ? [copy] : [copy, { label: 'diff.openFileInSidebar', run: () => openFile(file.path) }]
  }
  // Native file sections keep their reach observer and ref callback stable across panel changes.
  const live = useRef(null)
  live.current = { isExpanded, expandGap, fileActions, markViewed }
  const handlers = useMemo(() => ({
    toggle: file => choose(file.path, !live.current.isExpanded(file)),
    reveal: path => setRevealed(previous => new Set([...previous, path])),
    expand: (file, index) => live.current.expandGap(file, index),
    view: (file, viewed) => live.current.markViewed(file, viewed),
    actions: file => live.current.fileActions(file),
    section: (path, element) => { if (element) sections.current.set(path, element); else sections.current.delete(path) },
    reach,
  }), [reach])
  const review = useMemo(() => ({
    source,
    records: drafts,
    addToInput: selection => onQuote(index => formatReviewComment(selection, index)),
    // This destination is rendered by the native editor. The local copy labels it as a draft save.
    publish: async selection => drafts.save(selection) ? undefined : t('review.saveFailed'),
  }), [source, drafts, onQuote, t])

  const keyboard = event => {
    const element = event.target
    const port = viewport.current
    if (!port || event.defaultPrevented || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
      element.closest?.('input, textarea, select, [contenteditable], [data-forge-comment], [role="menu"]') ||
      window.getSelection()?.isCollapsed === false) return
    const currentPath = element.closest?.('[data-forge-diff-file]')?.dataset.forgeDiffFile
    const top = port.getBoundingClientRect().top
    const selected = files.findIndex(file => file.path === currentPath)
    const atTop = files.findIndex(file => sections.current.get(file.path)?.getBoundingClientRect().bottom > top + 1)
    const index = selected >= 0 ? selected : atTop >= 0 ? atTop : files.length - 1
    if (event.key.toLowerCase() === 'v' && files[index]) {
      event.preventDefault()
      const file = files[index]
      markViewed(file, viewedStateOf(marks, file.path, file.digest) !== 'viewed')
    } else if (!event.shiftKey && port.contains(element) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const next = files[index + (event.key === 'ArrowRight' ? 1 : -1)]
      if (next) { event.preventDefault(); port.focus({ preventScroll: true }); jump(next.path) }
    }
  }
  const navigatorProps = { files, state: treeState, t, jump,
    filter: query => setTreeState(value => ({ ...value, query })),
    toggle: path => setTreeState(value => ({ ...value, collapsed: { ...value.collapsed, [path]: value.collapsed[path] !== true } })),
  }
  const lensProps = { lens, counts, hideTests, choose: setLens, t }
  const toggleExpansion = () => setChosen(previous => new Map([...previous, ...files.map(file => [file.path, !anyExpanded])]))
  const toggleSplit = () => setSplit(value => !value)
  const toggleWrap = () => setWrap(value => !value)
  const toggleTests = () => setHideTests(value => !value)
  const expansionLabel = t(anyExpanded ? 'diff.collapseAll' : 'diff.expandAll')
  const treeAction = treePosition === 'left' ? 'diff.moveFileTreeRight' : treePosition === 'right' ? 'diff.hideFileTree' : 'diff.showFileTreeLeft'
  const total = files.reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 })
  const viewedCount = files.filter(file => viewedStateOf(marks, file.path, file.digest) === 'viewed').length
  const tree = allFiles.length ? treePosition : 'hidden'
  const message = !available ? 'direct.chooseWorkspace' : current?.error && !reading ? current.error :
    data && !files.length ? (!allFiles.length ? 'diff.empty' : 'lens.empty') : null

  return <div className="dchat-forge-body" onKeyDown={keyboard}>
    <div className={css.toolbar} data-tree={tree} style={{ '--forge-tree-width': `${treeWidth}px` }}>
      {tree !== 'hidden' && <div className={css.lensCell}><LensControl {...lensProps} /></div>}
      <div ref={toolbar} className={css.toolbarMain}>
        <ScopeMenu scope={scope} choose={setScope} available={available} t={t} />
        <span className={css.filesSlot}><ChangedFilesMenu {...navigatorProps} visible /></span>
        {allFiles.length > 0 && <span className={css.lensMenu}><LensMenu {...lensProps} visible /></span>}
        {allFiles.length > 0 && <span className={css.foldTests}><HideTestsSwitch hidden={hideTests} toggle={toggleTests} t={t} /></span>}
        <span className={css.spacer} data-fold-spacer="" />
        <span className={css.progressSlot}><ViewedProgress viewed={viewedCount} total={files.length} t={t} /></span>
        {files.length > 0 && <span className={`${css.totals} ${css.foldViews}`}><Counts file={total} t={t} /></span>}
        <span className={css.tools}>
          <Tool className={css.foldRefresh} label={t('diff.refresh')} disabled={!available} onClick={refresh}>
            <RefreshGlyph busy={reading} size={16} />
          </Tool>
          <Tool className={css.foldViews} label={expansionLabel} disabled={!files.length} data-expanded={anyExpanded ? '' : undefined}
            onClick={toggleExpansion}><IconChevronsUpDownOutlineRegular /></Tool>
          <Tool className={css.foldViews} label={t('diff.splitAria')} aria-pressed={split} onClick={toggleSplit}>
            <IconCompareSplitOutlineRegular className={css.compareIcon} />
          </Tool>
          <Tool className={css.foldViews} label={t('diff.wrapAria')} aria-pressed={wrap} onClick={toggleWrap}>
            {wrap ? <IconNowrapFillRegular /> : <IconWrapFillRegular />}
          </Tool>
          {allFiles.length > 0 && <span className={css.treeToggle}>
            <Tool label={t(treeAction)} aria-expanded={treePosition !== 'hidden'} aria-controls={treeId}
              onClick={() => setTreePosition(value => value === 'left' ? 'right' : value === 'right' ? 'hidden' : 'left')}>
              <IconWorkspaceTreeOutlineRegular />
            </Tool>
          </span>}
          <ViewOptionsMenu visible options={{ anyExpanded, hasFiles: Boolean(files.length), toggleExpansion, split, toggleSplit, wrap,
            toggleWrap, hideTests: allFiles.length ? hideTests : undefined, toggleTests, refresh }} t={t} />
        </span>
      </div>
    </div>
    {draftState.error && <div className={css.notice} role="alert">{t(draftState.error === 'load' ? 'review.loadFailed' : 'review.saveFailed')}</div>}
    {notice && <div className={css.notice} role="status">{t(notice.key)}
      <Button className={css.noticeAction} size="sm" onClick={() => setNotice(null)}>{t('review.close')}</Button>
    </div>}
    {data?.omitted > 0 && <div className={css.notice} role="status">{t('diff.omitted', { count: data.omitted })}</div>}
    <div className={css.body}>
      <div className={css.files} ref={attachViewport} role="region" aria-busy={reading} aria-keyshortcuts="ArrowLeft ArrowRight V"
        aria-label={t('diff.allFiles', { count: files.length })} data-forge-changes-scroll="" tabIndex={0}>
        {message && <div className={css.centered} role="status">{t(message)}</div>}
        {!data && reading && <div className={css.centered}><StateDot state="ongoing" /></div>}
        {files.map(file => {
          const { path, digest, previousPath } = file
          const state = context.get(path)
          const renamed = file.status === 'renamed' && previousPath !== null
          const badge = file.status === 'added' ? t('diff.newFile') : file.status === 'deleted' ? t('diff.deletedFile') :
            renamed ? t('diff.renamed', { from: previousPath }) : ''
          return <DiffFile key={JSON.stringify([path, digest])} {...{ file, t, handlers, review, split, wrap, badge }} visible
            expanded={isExpanded(file)} large={drawnLines(file) > largeFileLines} revealed={revealed.has(path)}
            text={state?.text} open={state?.open ?? noGaps} tooltip={renamed ? t('diff.renamedPath', { from: previousPath, path }) : path}
            viewed={viewedStateOf(marks, path, digest)} viewedNote={t('viewed.hint')} viewedDisabled={false} />
        })}
        {orphanPaths.map(path => <MissingFileDrafts key={path} {...{ path, review, t }} />)}
      </div>
      {allFiles.length > 0 && <FileTreePane {...navigatorProps} id={treeId} position={treePosition} onWidth={setTreeWidth} />}
    </div>
  </div>
}

function Tool({ label, className = '', children, ...props }) {
  return <Tooltip label={label} side="bottom"><button type="button" className={`${css.tool} ${className}`} aria-label={label} {...props}>
    {children}
  </button></Tooltip>
}
