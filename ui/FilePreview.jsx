import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Button, CodeBlock, FileTypeIcon, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,
  IconNowrapFillRegular, IconRefreshOutlineRegular, IconWrapFillRegular, MarkdownText, PathLabel, StateDot, Tooltip, languageForPath,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { PdfPreview, TextDocumentPreview } from './DocumentPreview.jsx'
import { SpreadsheetPreview } from './SpreadsheetPreview.jsx'
import { previewAttachment, previewFile } from './chat-state.mjs'

const imageTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/x-icon']
const loadErrors = { 403: 'file.denied', 404: 'file.missing', 413: 'file.unsupported', 415: 'file.unsupported' }
const maxLines = 4000

class PreviewErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return <div className="dchat-preview-status" role="alert" style={{ flexDirection: 'column', gap: 8 }}>
        <span>{this.props.fallbackMessage}</span>
        {this.props.onBrowse && <Button size="sm" variant="outline" onClick={this.props.onBrowse}>{this.props.browseLabel}</Button>}
      </div>
    }
    return this.props.children
  }
}

export function WorkspaceFiles({ target, selected, controller, t }) {
  const [revision, refresh] = useState(0)
  const [expanded, setExpanded] = useState(() => new Set())
  const id = target?.id
  if (!id || !target.cwd) return <p className="dchat-preview-status" role="status">{t('files.noWorkspace')}</p>
  const files = {
    id, revision, expanded, visible: !selected, t,
    open: path => controller.openFile(id, { path }),
    toggle(path) {
      setExpanded(previous => {
        const next = new Set(previous)
        if (!next.delete(path)) next.add(path)
        return next
      })
    },
  }
  return <>
    {selected && <PreviewErrorBoundary key={JSON.stringify([selected.path, selected.line, selected.attachmentId])}
      fallbackMessage={t('file.failed')} browseLabel={t('files.title')} onBrowse={controller.browseFiles}>
      <FilePreview id={id} requested={selected} browse={controller.browseFiles} t={t} />
    </PreviewErrorBoundary>}
    <div className="dchat-files-pane" hidden={Boolean(selected)}>
      <div className="dchat-preview-toolbar">
        <PathLabel path={target.cwd} className="dchat-preview-path" />
        <Tooltip label={t('diff.refresh')} side="bottom">
          <Button size="sm" className="dchat-diff-icon" aria-label={t('diff.refresh')} onClick={() => refresh(value => value + 1)}>
            <IconRefreshOutlineRegular size={15} />
          </Button>
        </Tooltip>
      </div>
      <div className="dchat-files-content">
        <WorkspaceDirectory files={files} path="" />
      </div>
    </div>
  </>
}

function WorkspaceDirectory({ files, path }) {
  const { id, revision, expanded, visible, t } = files
  const [read, setRead] = useState(null)
  const result = read?.revision === revision ? read.value : null
  useEffect(() => {
    if (!visible || result) return
    const request = new AbortController()
    const settle = value => {
      if (!request.signal.aborted) setRead({ revision, value })
    }
    const query = new URLSearchParams({ path })
    fetch(`/api/direct-chat/sessions/${encodeURIComponent(id)}/files?${query}`, { signal: request.signal, credentials: 'same-origin' })
      .then(async response => {
        if (response.status === 403) return { error: 'files.denied' }
        if (response.status === 404) return { error: 'files.missing' }
        if (!response.ok) throw new Error('Could not list workspace files')
        const data = await response.json()
        if (!Array.isArray(data.entries)) throw new Error('Invalid workspace file listing')
        return data
      }).then(settle, () => settle({ error: 'files.failed' }))
    return () => request.abort()
  }, [id, path, revision, visible, result])

  if (!result) return <p className="dchat-files-note" role="status"><StateDot state="ongoing" />{t('files.loading')}</p>
  if (result.error) return <p className="dchat-files-note" role="alert">{t(result.error)}</p>
  if (!result.entries.length) return <p className="dchat-files-note" role="status">{t('files.empty')}</p>
  return <>
    <ul className="dchat-files-list">
      {result.entries.map(entry => {
        const open = entry.directory && expanded.has(entry.path)
        return <li key={entry.path} className="dchat-files-entry">
          <button type="button" className="dchat-files-row" title={entry.path}
            aria-expanded={entry.directory ? open : undefined}
            onClick={() => entry.directory ? files.toggle(entry.path) : files.open(entry.path)}>
            <span className="dchat-files-chevron" aria-hidden="true">
              {entry.directory && <IconChevronRightOutlineRegular size={12} />}
            </span>
            {entry.directory ? (open ? <IconFolderOpenRegular size={16} /> : <IconFolderCloseRegular size={16} />)
              : <FileTypeIcon path={entry.path} size={16} />}
            <span className="dchat-files-name">{entry.name}</span>
          </button>
          {open && <WorkspaceDirectory files={files} path={entry.path} />}
        </li>
      })}
    </ul>
    {result.truncated && <p className="dchat-files-note" role="status">{t('files.truncated')}</p>}
  </>
}

function FilePreview({ id, requested, browse, t }) {
  const [state, setState] = useState({ loading: true })
  const [revision, refresh] = useState(0)
  const [wrap, setWrap] = useState(false)
  const [imageFailed, setImageFailed] = useState(false)
  const viewer = useRef(null)
  const { path, line, attachmentId } = requested
  const isMarkdown = typeof path === 'string' && /\.(?:md|markdown)$/i.test(path)
  const isTextDocument = /\.(?:html?|csv|tsv)$/i.test(path)
  const [viewMode, setViewMode] = useState(() => ((isMarkdown || isTextDocument) && !line ? 'preview' : 'code'))

  useEffect(() => {
    const request = new AbortController()
    const read = attachmentId ? previewAttachment(id, attachmentId, request.signal) : previewFile(id, path, request.signal)
    read.then(file => {
      if (request.signal.aborted) return
      const image = (file.mediaKind === 'image' || imageTypes.includes(file.mimeType))
        && typeof file.data === 'string' && /^[a-z\d+/]+=*$/i.test(file.data)
      const video = file.mediaKind === 'video'
      const audio = file.mediaKind === 'audio'
      const document = ['pdf', 'html', 'spreadsheet'].includes(file.documentKind)
      setState(image || video || audio || document || typeof file.text === 'string' ? { file, image, video, audio } : { error: 'file.unsupported' })
    }, error => {
      if (!request.signal.aborted) setState({ error: loadErrors[error.status] ?? 'file.failed' })
    })
    return () => request.abort()
  }, [id, path, attachmentId, revision])

  const { file, image, video, audio, loading, error } = state
  const isMedia = Boolean(image || video || audio)
  const displayPath = file?.path ?? path
  const mediaUrl = useMemo(() => {
    if (!id || !displayPath || (!video && !audio)) return ''
    const query = new URLSearchParams(attachmentId ? { attachment: attachmentId } : { path: displayPath })
    query.set('v', String(revision))
    return `/api/direct-chat/sessions/${encodeURIComponent(id)}/media?${query}`
  }, [id, displayPath, attachmentId, video, audio, revision])
  const kind = file?.documentKind
  const documentUrl = useMemo(() => {
    if (!kind) return ''
    const query = new URLSearchParams(attachmentId ? { attachment: attachmentId } : { path })
    query.set('v', String(revision))
    return `/api/direct-chat/sessions/${encodeURIComponent(id)}/document?${query}`
  }, [kind, attachmentId, path, revision, id])
  const text = useMemo(() => file?.text?.replace(/\r\n?/g, '\n') ?? '', [file])
  const lines = useMemo(() => text ? text.replace(/\n$/, '').split('\n') : [], [text])
  const requestedLine = Number.isSafeInteger(line) && line > 0 ? line : undefined
  const selectedLine = requestedLine <= lines.length ? requestedLine : undefined
  const firstLine = Math.max(0, Math.min((selectedLine ?? 1) - 101, lines.length - maxLines))
  const cut = lines.length > maxLines
  const code = useMemo(() => cut ? `${lines.slice(firstLine, firstLine + maxLines).join('\n')}\n` : text, [cut, lines, firstLine, text])

  useLayoutEffect(() => {
    const container = viewer.current
    if (!container || selectedLine === undefined) return
    let positioned = false
    const reveal = () => {
      const row = container.querySelectorAll('pre code > .line')[selectedLine - firstLine - 1]
      if (!row) return
      row.dataset.dchatFileLine = ''
      if (!positioned) {
        container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - 48
        positioned = true
      }
    }
    reveal()
    const observer = new MutationObserver(reveal)
    observer.observe(container, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [code, firstLine, selectedLine])

  const reload = () => {
    setImageFailed(false)
    setState({ loading: true })
    refresh(value => value + 1)
  }
  const wrapLabel = t(wrap ? 'file.unwrap' : 'file.wrap')
  const refreshLabel = t('diff.refresh')
  const filesLabel = t('files.title')
  const markdownPreview = isMarkdown && viewMode === 'preview'
  const markdownLabels = useMemo(() => ({
    footnotes: t('footnotes'),
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
  }), [t])
  return <>
    <div className="dchat-preview-toolbar">
      <PathLabel path={displayPath} className="dchat-preview-path" />
      {file && !isMedia && (isMarkdown || isTextDocument) && <Button size="sm" className="dchat-diff-select"
        onClick={() => setViewMode(current => current === 'preview' ? 'code' : 'preview')}>
        {t(viewMode === 'preview' ? 'file.code' : 'files.preview')}
      </Button>}
      {file && !isMedia && !markdownPreview && lines.length > 0 && <Tooltip label={wrapLabel} side="bottom">
        <Button size="sm" className="dchat-diff-icon" aria-label={wrapLabel} aria-pressed={wrap} onClick={() => setWrap(value => !value)}>
          {wrap ? <IconNowrapFillRegular size={15} /> : <IconWrapFillRegular size={15} />}
        </Button>
      </Tooltip>}
      <Tooltip label={refreshLabel} side="bottom">
        <Button size="sm" className="dchat-diff-icon" disabled={loading} aria-label={refreshLabel} onClick={reload}>
          <IconRefreshOutlineRegular size={15} />
        </Button>
      </Tooltip>
      <Tooltip label={filesLabel} side="bottom">
        <Button size="sm" className="dchat-diff-icon" aria-label={filesLabel} onClick={browse}>
          <IconFolderCloseRegular size={15} />
        </Button>
      </Tooltip>
    </div>
    <div className="dchat-preview-content" aria-busy={loading || undefined}>
      {loading && <p className="dchat-preview-status" role="status"><StateDot state="ongoing" />{t('file.loading')}</p>}
      {(error || imageFailed) && <p className="dchat-preview-status" role="alert">{t(error ?? 'file.unsupported')}</p>}
      {file && image && !imageFailed && <div className="dchat-preview-image-scroll">
        <img src={`data:${file.mimeType};base64,${file.data}`} alt={displayPath} onError={() => setImageFailed(true)} />
      </div>}
      {file && video && !imageFailed && <div className="dchat-preview-media-scroll">
        <video key={mediaUrl} controls preload="metadata" className="dchat-preview-video" src={mediaUrl} onError={() => setImageFailed(true)} />
      </div>}
      {file && audio && !imageFailed && <div className="dchat-preview-media-scroll">
        <audio key={mediaUrl} controls preload="metadata" className="dchat-preview-audio" src={mediaUrl} onError={() => setImageFailed(true)} />
      </div>}
      {kind === 'pdf' && <PdfPreview key={documentUrl} url={documentUrl} t={t} />}
      {kind === 'spreadsheet' && !(isTextDocument && viewMode === 'code') &&
        <SpreadsheetPreview key={documentUrl} url={documentUrl} path={displayPath} t={t} />}
      {(kind === 'html' || (kind === 'spreadsheet' && isTextDocument && viewMode === 'code')) &&
        <TextDocumentPreview url={documentUrl} path={displayPath} mode={viewMode} t={t} />}
      {file && !isMedia && !kind && <>
        {markdownPreview ? <div className="dchat-preview-markdown"><MarkdownText text={text} labels={markdownLabels} /></div>
          : lines.length ? <div className="dchat-preview-scroll" role="region" aria-label={t('file.code')}
          style={{ '--dchat-file-first-line': firstLine, '--dchat-file-number-width': `${Math.max(2, String(firstLine + Math.min(lines.length, maxLines)).length)}ch` }}>
          <CodeBlock code={code} lang={languageForPath(displayPath)} lineNumbers contentRef={viewer} wrap={wrap}
            copyLabel={t('copy')} copiedLabel={t('copied')}
            toolbarLabels={{ codeLabel: t('file.code'), wrapLabel: t('file.wrap'), unwrapLabel: t('file.unwrap') }} />
        </div> : <p className="dchat-preview-status" role="status">{t('file.empty')}</p>}
        {(file.truncated || cut) && <p className="dchat-preview-notice" role="status">{t('file.truncated')}</p>}
        {requestedLine !== undefined && selectedLine === undefined && <p className="dchat-preview-notice" role="status">
          {t('file.lineMissing', { line: requestedLine })}
        </p>}
      </>}
    </div>
  </>
}

export const filesCopy = {
  en: {
    'files.title': 'Workspace files', 'files.noWorkspace': 'Choose a workspace or open a conversation to browse files.',
    'files.loading': 'Reading files…', 'files.failed': 'Could not list workspace files.',
    'files.denied': 'The directory is outside the conversation’s workspace or cannot be accessed.',
    'files.missing': 'The directory could not be found.', 'files.empty': 'This directory is empty.',
    'files.truncated': 'Showing part of this directory.', 'files.preview': 'Preview', 'files.sidebar': 'Toggle right sidebar',
    'files.openTab': 'Open file tab',
  },
  zh: {
    'files.title': '工作区文件', 'files.noWorkspace': '选择工作目录或打开会话后，可浏览文件。',
    'files.loading': '正在读取文件…', 'files.failed': '无法读取工作区文件。',
    'files.denied': '此目录不在会话工作区内，或无法访问。',
    'files.missing': '找不到此目录。', 'files.empty': '此目录为空。',
    'files.truncated': '当前仅显示此目录的一部分。', 'files.preview': '预览', 'files.sidebar': '切换右侧边栏',
    'files.openTab': '打开文件标签页',
  },
}
