import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, CodeBlock, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'

export const DocumentModulesContext = createContext(null)
const previewModule = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
const noRetain = () => {}
const defaultView = { page: 1 }
const documentByteLimit = 64 * 1024 * 1024
const documentErrors = { 403: 'file.denied', 404: 'file.missing', 409: 'document.changed', 413: 'document.tooLarge', 415: 'file.unsupported', 503: 'document.converterUnavailable' }

function useDocumentBytes(url) {
  const [result, setResult] = useState(null)
  useEffect(() => {
    const request = new AbortController()
    fetch(url, { signal: request.signal })
      .then(response => {
        if (!response.ok) throw Object.assign(new Error('Document request failed'), { status: response.status })
        if (Number(response.headers.get('Content-Length')) > documentByteLimit) {
          throw Object.assign(new Error('Document exceeds preview size'), { status: 413 })
        }
        return response.arrayBuffer()
      })
      .then(bytes => {
        if (!request.signal.aborted) setResult(bytes.byteLength > documentByteLimit
          ? { url, error: 'document.tooLarge' } : { url, data: new Uint8Array(bytes) })
      }, error => {
        if (!request.signal.aborted) setResult({ url, error: documentErrors[error.status] ?? 'file.failed' })
      })
    return () => request.abort()
  }, [url])
  return result?.url === url ? result : null
}

function PreviewStatus({ error, t }) {
  return error ? <p className="dchat-preview-status" role="alert">{t(error)}</p>
    : <p className="dchat-preview-status" role="status"><StateDot state="ongoing" />{t('file.loading')}</p>
}

function htmlText(data) {
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
    : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8'
  return new TextDecoder(encoding).decode(data)
}

const staticPolicy = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"

function staticHtml(text) {
  const template = document.createElement('template')
  template.innerHTML = text
  const fragment = template.content
  for (const element of fragment.querySelectorAll('script,iframe,frame,frameset,object,embed,base,meta,link,form,template')) element.remove()
  for (const element of fragment.querySelectorAll('[href],[xlink\\:href],[ping]')) {
    element.removeAttribute('href')
    element.removeAttribute('xlink:href')
    element.removeAttribute('ping')
  }
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${staticPolicy}">${template.innerHTML}`
}

export function TextDocumentPreview({ url, path, mode, t }) {
  const result = useDocumentBytes(url)
  const text = useMemo(() => result?.data && htmlText(result.data), [result])
  const document = useMemo(() => mode === 'preview' && text !== undefined ? staticHtml(text) : undefined, [mode, text])
  if (text === undefined) return <PreviewStatus error={result?.error} t={t} />
  if (mode === 'code') return <div className="dchat-preview-scroll">
    <CodeBlock lang={/\.html?$/i.test(path) ? 'html' : 'text'} code={text} lineNumbers copyLabel={t('copy')} copiedLabel={t('copied')} />
  </div>
  return <iframe className="dchat-document-html" title={path} sandbox="" referrerPolicy="no-referrer" srcDoc={document} />
}

function PdfZoomViewport({ preference, intrinsicWidth, horizontalInset, labels, onPreference, onRenderZoom, scrollportRef, children }) {
  const scroll = useRef(null)
  const [width, setWidth] = useState(0)
  const bind = useCallback(node => { scroll.current = node; scrollportRef(node) }, [scrollportRef])
  useLayoutEffect(() => {
    const node = scroll.current
    if (!node) return
    const measure = () => setWidth(node.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const zoom = preference.kind === 'fit-width'
    ? (intrinsicWidth && width ? Math.max(0.1, (width - horizontalInset) / intrinsicWidth) : 1)
    : preference.scale
  useEffect(() => onRenderZoom(zoom), [zoom, onRenderZoom])
  const setZoom = value => onPreference({ kind: 'fixed', scale: Math.min(4, Math.max(0.2, value)) })
  return <div className="dchat-document-pdf">
    <div className="dchat-document-zoom" role="group" aria-label={labels.controls}>
      <Button size="sm" aria-label={labels.out} onClick={() => setZoom(zoom / 1.25)}>−</Button>
      <Button size="sm" onClick={() => onPreference({ kind: 'fit-width' })} title={labels.fitWidth}>
        {preference.kind === 'fit-width' ? labels.fitWidth : labels.value(Math.round(zoom * 100))}
      </Button>
      <Button size="sm" aria-label={labels.into} onClick={() => setZoom(zoom * 1.25)}>+</Button>
    </div>
    <div className="dchat-document-pdf-scroll" ref={bind} data-document-zoom-mode={preference.kind} style={{ '--dchat-document-zoom': zoom }}>{children}</div>
  </div>
}

export function PdfPreview({ url, t }) {
  const getModules = useContext(DocumentModulesContext)
  const result = useDocumentBytes(url)
  const [renderer, setRenderer] = useState(null)
  const [view, setView] = useState(defaultView)
  const tab = useMemo(() => ({ id: url, signal: new AbortController().signal }), [url])
  const actions = useMemo(() => ({
    page: (_id, page) => setView(previous => previous.page === page ? previous : { ...previous, page }),
    zoom: (_id, zoom) => setView(previous => ({ ...previous, zoom })),
  }), [])
  const useTabInfo = useCallback(() => ({ tab }), [tab])
  const useStore = selector => selector({ byTab: { [tab.id]: view } })
  const scrollportRef = useCallback(() => {}, [])
  useEffect(() => {
    let active = true
    Promise.resolve().then(() => getModules?.()?.importChunk(previewModule, 'client.pdf.js'))
      .then(module => {
        if (typeof module?.PdfBody !== 'function') throw new Error('PDF renderer unavailable')
        if (active) setRenderer({ Body: module.PdfBody })
      }).catch(() => { if (active) setRenderer({ error: 'document.rendererUnavailable' }) })
    return () => { active = false }
  }, [getModules])
  if (!result?.data || !renderer?.Body) return <PreviewStatus error={result?.error ?? renderer?.error} t={t} />
  return <renderer.Body content={{ kind: 'bytes', data: result.data }} useTabInfo={useTabInfo} useStore={useStore}
    actions={actions} retainTab={noRetain} ZoomViewport={PdfZoomViewport} zoomSurfaceClass="dchat-document-pdf-surface"
    scrollportRef={scrollportRef} loading={<PreviewStatus t={t} />} t={(key, values) => t(`document.pdf.${key}`, values)} />
}

export const documentCopy = {
  en: {
    'document.converterUnavailable': 'Office conversion is unavailable.',
    'document.rendererUnavailable': 'The document renderer could not be loaded.',
    'document.tooLarge': 'This document exceeds the preview limit.',
    'document.changed': 'The document changed. Refresh to see the latest version.',
    'document.pdf.zoomControls': 'PDF zoom', 'document.pdf.zoomOut': 'Zoom out', 'document.pdf.zoomIn': 'Zoom in',
    'document.pdf.zoomFitWidth': 'Fit width', 'document.pdf.zoomValue': '{percent}%',
    'document.pdf.pageImage': 'PDF page {page}', 'document.pdf.rendering': 'Rendering page…',
    'document.pdf.failed': 'Could not render the PDF.', 'document.pdf.password': 'This PDF requires a password.',
    'document.pdf.workerFailed': 'The PDF renderer stopped.', 'document.pdf.unsupported': 'PDF contents are unavailable.',
    'document.pdf.retry': 'Retry',
  },
  zh: {
    'document.converterUnavailable': 'Office 转换服务暂不可用。',
    'document.rendererUnavailable': '无法加载文档渲染器。',
    'document.tooLarge': '此文档超过预览大小限制。',
    'document.changed': '文档已更改，请刷新查看最新内容。',
    'document.pdf.zoomControls': 'PDF 缩放', 'document.pdf.zoomOut': '缩小', 'document.pdf.zoomIn': '放大',
    'document.pdf.zoomFitWidth': '适应宽度', 'document.pdf.zoomValue': '{percent}%',
    'document.pdf.pageImage': 'PDF 第 {page} 页', 'document.pdf.rendering': '正在渲染页面…',
    'document.pdf.failed': '无法渲染 PDF。', 'document.pdf.password': '此 PDF 需要密码。',
    'document.pdf.workerFailed': 'PDF 渲染进程已停止。', 'document.pdf.unsupported': '无法读取 PDF 内容。',
    'document.pdf.retry': '重试',
  },
}
