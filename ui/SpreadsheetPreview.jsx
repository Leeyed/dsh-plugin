import { Component, useContext, useEffect, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { DocumentModulesContext } from './DocumentPreview.jsx'

const nativePlugin = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
const loadErrors = { 403: 'file.denied', 404: 'file.missing', 413: 'spreadsheet.tooLarge', 415: 'file.unsupported' }
const defaults = { maxBytes: 16 * 1024 * 1024, maxCells: 250_000, timeoutMs: 15_000 }

async function loadWorkbook(getModules) {
  // The native Excel slot needs a DSH session. Its lazy body accepts bytes directly.
  const { ExcelBody } = await getModules()?.importChunk?.(nativePlugin, 'client.excel.js') ?? {}
  if (typeof ExcelBody !== 'function') throw new Error('Spreadsheet renderer unavailable')
  return ExcelBody
}

async function readWorkbook(url, limits, signal) {
  const response = await fetch(url, { credentials: 'same-origin', signal })
  if (!response.ok) throw new Error(loadErrors[response.status] ?? 'file.failed')
  if (Number(response.headers.get('Content-Length')) > limits.maxBytes) throw new Error('spreadsheet.tooLarge')
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength > limits.maxBytes) throw new Error('spreadsheet.tooLarge')
  return { kind: 'bytes', data }
}

export function SpreadsheetPreview({ url, path, t }) {
  const getModules = useContext(DocumentModulesContext)
  const [limits] = useState(() => ({ ...defaults, ...globalThis.__DSH_DOCUMENT_PREVIEW_CONFIG__?.excel }))
  const [loaded, setLoaded] = useState(null)
  const format = /\.(xlsx?|[ct]sv)$/i.exec(path)?.[1].toLowerCase()

  useEffect(() => {
    if (!url || !format || !getModules) return
    const request = new AbortController()
    const settle = result => {
      if (request.signal.aborted) return
      setLoaded({ url, format, ...result })
      request.abort()
    }
    const bytes = readWorkbook(url, limits, request.signal).catch(error => {
      throw new Error(Object.values(loadErrors).includes(error.message) ? error.message : 'file.failed')
    })
    const render = loadWorkbook(getModules).catch(() => { throw new Error('spreadsheet.unavailable') })
    Promise.all([render, bytes]).then(
      ([Workbook, content]) => settle({ Workbook, content }),
      error => settle({ error: error.message }),
    )
    return () => request.abort()
  }, [url, format, getModules, limits])

  const loading = <p className="dchat-preview-status" role="status"><StateDot state="ongoing" />{t('spreadsheet.loading')}</p>
  if (!url || !format || !getModules) {
    return <p className="dchat-preview-status" role="alert">{t('file.unsupported')}</p>
  }
  if (loaded?.url !== url || loaded.format !== format) return loading
  if (loaded.error) return <p className="dchat-preview-status" role="alert">{t(loaded.error)}</p>
  const { Workbook, content } = loaded
  return <SpreadsheetErrorBoundary key={url} t={t}>
    <Workbook content={content} format={format} limits={limits} loading={loading}
      t={(key, params) => t(`spreadsheet.${key}`, params)} />
  </SpreadsheetErrorBoundary>
}

class SpreadsheetErrorBoundary extends Component {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <p className="dchat-preview-status" role="alert">{this.props.t('spreadsheet.invalid')}</p>
    return this.props.children
  }
}

export const spreadsheetCopy = {
  en: {
    'spreadsheet.title': 'Spreadsheet', 'spreadsheet.language': 'en', 'spreadsheet.loading': 'Loading spreadsheet…',
    'spreadsheet.unavailable': 'Could not load the spreadsheet viewer.',
    'spreadsheet.invalid': 'Could not open this spreadsheet. Check its format, contents, or password protection.',
    'spreadsheet.tooLarge': 'This workbook exceeds the preview size limit.',
    'spreadsheet.timeout': 'Opening this workbook timed out. Try a smaller file.',
    'spreadsheet.encoding': 'Could not read this text encoding. Save the file as UTF-8 or UTF-16 with a BOM and try again.',
    'spreadsheet.formulaWarning': 'This workbook contains formulas. Some results may be missing or inaccurate.',
    'spreadsheet.unsupportedNotice': 'This preview cannot display {features}. Open the workbook in a spreadsheet app to see them.',
    'spreadsheet.charts': 'charts', 'spreadsheet.images': 'images', 'spreadsheet.shapes': 'shapes',
    'spreadsheet.conditionalFormatting': 'conditional formatting', 'spreadsheet.featureSeparator': ', ', 'spreadsheet.retry': 'Retry',
  },
  zh: {
    'spreadsheet.title': '表格', 'spreadsheet.language': 'zh', 'spreadsheet.loading': '正在加载表格…',
    'spreadsheet.unavailable': '无法加载表格预览组件。',
    'spreadsheet.invalid': '无法打开此表格。请检查文件格式、内容或密码保护。',
    'spreadsheet.tooLarge': '此工作簿超过预览大小限制。',
    'spreadsheet.timeout': '打开表格超时。请缩小文件后重试。',
    'spreadsheet.encoding': '无法识别此文本文件的编码。请另存为 UTF-8 或带 BOM 的 UTF-16 后重试。',
    'spreadsheet.formulaWarning': '此工作簿包含公式，显示结果可能缺失或不准确。',
    'spreadsheet.unsupportedNotice': '当前预览无法显示{features}。请在表格应用中打开工作簿。',
    'spreadsheet.charts': '图表', 'spreadsheet.images': '图片', 'spreadsheet.shapes': '形状',
    'spreadsheet.conditionalFormatting': '条件格式', 'spreadsheet.featureSeparator': '、', 'spreadsheet.retry': '重试',
  },
}
