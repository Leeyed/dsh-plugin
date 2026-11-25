import { pipeline } from 'node:stream/promises'
import { constants } from 'node:fs'
import { open, opendir, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const limit = 512 * 1024
const imageLimit = 8 * 1024 * 1024
const documentLimit = 32 * 1024 * 1024
const pdfMime = 'application/pdf'
const documentTypes = new Map(Object.entries({
  pdf: ['pdf', pdfMime],
  doc: ['pdf', pdfMime], docx: ['pdf', pdfMime],
  ppt: ['pdf', pdfMime], pptx: ['pdf', pdfMime],
  html: ['html', 'text/html'], htm: ['html', 'text/html'],
  xls: ['spreadsheet', 'application/vnd.ms-excel'],
  xlsx: ['spreadsheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['spreadsheet', 'text/csv'], tsv: ['spreadsheet', 'text/tab-separated-values'],
}))

export function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg'
  if (['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return 'image/gif'
  if (bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return 'image/webp'
}

const mediaExtensions = new Map(Object.entries({
  svg: { mimeType: 'image/svg+xml', mediaKind: 'image' },
  bmp: { mimeType: 'image/bmp', mediaKind: 'image' },
  ico: { mimeType: 'image/x-icon', mediaKind: 'image' },
  mp3: { mimeType: 'audio/mpeg', mediaKind: 'audio' },
  wav: { mimeType: 'audio/wav', mediaKind: 'audio' },
  ogg: { mimeType: 'audio/ogg', mediaKind: 'audio' },
  m4a: { mimeType: 'audio/mp4', mediaKind: 'audio' },
  flac: { mimeType: 'audio/flac', mediaKind: 'audio' },
  aac: { mimeType: 'audio/aac', mediaKind: 'audio' },
  opus: { mimeType: 'audio/opus', mediaKind: 'audio' },
  mp4: { mimeType: 'video/mp4', mediaKind: 'video' },
  m4v: { mimeType: 'video/mp4', mediaKind: 'video' },
  webm: { mimeType: 'video/webm', mediaKind: 'video' },
  mov: { mimeType: 'video/quicktime', mediaKind: 'video' },
}))

export function mediaTypeForPath(filePath) {
  if (typeof filePath !== 'string') return undefined
  const ext = /\.([a-z0-9]+)$/i.exec(filePath)?.[1]?.toLowerCase()
  return ext ? mediaExtensions.get(ext) : undefined
}
const fail = (status, message) => Object.assign(new Error(message), { status })

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

function normalizeRequestedPath(requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0')) {
    throw fail(400, 'Missing or invalid file path')
  }
  if (!requestedPath.startsWith('file://')) return requestedPath
  try {
    return fileURLToPath(requestedPath)
  } catch {
    throw fail(400, 'Invalid file URL')
  }
}

async function fileScope(cwd, { allowedRoots = [], privateRoot, privateDirectory } = {}) {
  const root = await realpath(cwd).catch(() => { throw fail(404, 'Workspace not found') })
  const extraRoots = (await Promise.all(
    (Array.isArray(allowedRoots) ? allowedRoots : [])
      .filter(dir => typeof dir === 'string' && dir)
      .map(dir => realpath(dir).catch(() => null))
  )).filter(Boolean)
  const insideAllowed = path => privateRoot && inside(privateRoot, path)
    ? Boolean(privateDirectory && inside(privateDirectory, path))
    : inside(root, path) || extraRoots.some(candidate => inside(candidate, path))
  return { root, insideAllowed }
}

async function openScopedFile(cwd, requestedPath, scope) {
  const targetPath = normalizeRequestedPath(requestedPath)
  const { root, insideAllowed } = await fileScope(cwd, scope)
  const requested = resolve(root, targetPath)
  if (!insideAllowed(requested)) throw fail(403, 'File is outside this workspace')
  let handle
  try {
    const canonical = await realpath(requested)
    if (!insideAllowed(canonical)) throw fail(403, 'File is outside this workspace')
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    // Recheck the file we actually opened if a directory or symlink changed during lookup.
    const actual = await realpath(process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : canonical)
    if (!insideAllowed(actual)) throw fail(403, 'File is outside this workspace')
    const stat = await handle.stat({ bigint: true })
    if (!stat.isFile()) throw fail(415, 'Choose a regular file')
    return { handle, path: actual, stat, size: Number(stat.size) }
  } catch (e) {
    await handle?.close().catch(() => {})
    if (e.status) throw e
    if (['ENOENT','ENOTDIR'].includes(e.code)) throw fail(404, 'File not found')
    if (['ELOOP','EACCES','EPERM'].includes(e.code)) throw fail(403, 'File is not accessible')
    throw e
  }
}

async function readPrefix(handle, size, signal) {
  const bytes = Buffer.alloc(size)
  let length = 0
  while (length < bytes.length) {
    signal?.throwIfAborted()
    const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
    if (!bytesRead) break
    length += bytesRead
  }
  return bytes.subarray(0, length)
}

function documentType(path) {
  const extension = extname(path).slice(1).toLowerCase()
  const type = documentTypes.get(extension)
  if (type) return { extension, documentKind: type[0], mimeType: type[1] }
}

export async function previewFile(cwd, requestedPath, scope) {
  const { handle, path, size } = await openScopedFile(cwd, requestedPath, scope)
  try {
    const document = documentType(path)
    if (document) return { path, documentKind: document.documentKind, mimeType: document.mimeType, size, truncated: false }
    const extMedia = mediaTypeForPath(path)
    if (extMedia && (extMedia.mediaKind === 'audio' || extMedia.mediaKind === 'video')) {
      return { path, mimeType: extMedia.mimeType, mediaKind: extMedia.mediaKind, size, truncated: false }
    }
    const mimeType = imageType(await readPrefix(handle, 12)) ?? (extMedia?.mediaKind === 'image' ? extMedia.mimeType : undefined)
    if (mimeType && size > imageLimit) throw fail(413, 'Image exceeds the 8 MiB preview limit')
    const buffer = await readPrefix(handle, Math.min(size, mimeType ? imageLimit : limit))
    if (mimeType) return { path, mimeType, mediaKind: 'image', data: buffer.toString('base64'), truncated: false }
    if (buffer.includes(0)) throw fail(415, 'Binary preview is unavailable')
    const truncated = size > limit
    let text
    try {
      text = new TextDecoder('utf-8', {fatal:true}).decode(buffer, {stream:truncated})
    } catch { throw fail(415,'This file is not UTF-8 text') }
    return { path, text, truncated }
  } finally { await handle.close() }
}

export async function openMediaFile(cwd, requestedPath, scope) {
  const { handle, path, size } = await openScopedFile(cwd, requestedPath, scope)
  try {
    const mimeType = imageType(await readPrefix(handle, 12)) ?? mediaTypeForPath(path)?.mimeType
    if (!mimeType) throw fail(415, 'Unsupported media format')
    return { handle, path, mimeType, size }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

function fileVersion({ dev, ino, size, mtimeNs, ctimeNs }) {
  return [dev, ino, size, mtimeNs, ctimeNs].join(':')
}

async function convertOfficeDocument(cwd, requestedPath, scope, file, extension, officeKit, sessionId, signal) {
  if (typeof officeKit?.convert !== 'function') throw fail(503, 'Office conversion is unavailable')
  const version = fileVersion(file.stat)
  const sameVersion = (path, stat) => {
    if (path !== file.path || fileVersion(stat) !== version) throw fail(409, 'The document changed during conversion')
  }
  try {
    const { pdf } = await officeKit.convert({
      extension,
      priority: 'foreground',
      source: {
        key: JSON.stringify([sessionId, file.path]),
        version,
        bytes: file.size,
        async read(upstream, maxBytes) {
          // Reauthorize and match the admitted file when the provider starts reading.
          upstream.throwIfAborted()
          const current = await openScopedFile(cwd, requestedPath, scope)
          try {
            sameVersion(current.path, current.stat)
            if (current.size > maxBytes) throw fail(413, 'The Office document exceeds the preview limit')
            const bytes = await readPrefix(current.handle, current.size, upstream)
            sameVersion(current.path, await current.handle.stat({ bigint: true }))
            upstream.throwIfAborted()
            return { bytes, version }
          } finally { await current.handle.close() }
        },
      },
    }, signal)
    if (!(pdf instanceof Uint8Array) || !pdfSignature(pdf)) throw fail(502, 'Office conversion produced an invalid PDF')
    return pdf
  } catch (error) {
    signal.throwIfAborted()
    if (error?.status) throw error
    switch (error?.code) {
      case 'input-too-large':
      case 'output-too-large': throw fail(413, 'The Office document exceeds the preview limit')
      case 'invalid-document':
      case 'unsupported-format': throw fail(415, 'This Office document could not be opened')
      case 'source-changed': throw fail(409, 'The document changed during conversion')
      case 'timeout': throw fail(504, 'Office conversion timed out')
      case 'busy': throw fail(503, 'Office conversion is busy')
      case 'unavailable': throw fail(503, 'Office conversion is unavailable')
      default: throw fail(502, 'Office conversion failed')
    }
  }
}

const pdfSignature = bytes => Buffer.from(bytes.subarray(0, 5)).toString('ascii') === '%PDF-'

export async function sendDocument(response, cwd, requestedPath, scope, { officeKit, sessionId, signal, range }) {
  signal.throwIfAborted()
  const file = await openScopedFile(cwd, requestedPath, scope)
  const headers = { 'X-Content-Type-Options': 'nosniff' }
  try {
    const document = documentType(file.path)
    if (!document) throw fail(415, 'Unsupported document type')
    let payload = file
    let mimeType = pdfMime
    if (document.documentKind !== 'pdf') {
      if (file.size > documentLimit) throw fail(413, 'The document exceeds the 32 MiB preview limit')
      mimeType = 'application/octet-stream'
      headers['Content-Disposition'] = 'attachment'
    } else if (document.extension === 'pdf') {
      if (!pdfSignature(await readPrefix(file.handle, 5, signal))) throw fail(415, 'This file is not a PDF')
    } else {
      await file.handle.close()
      const bytes = await convertOfficeDocument(cwd, requestedPath, scope, file, document.extension, officeKit, sessionId, signal)
      payload = { bytes, size: bytes.byteLength }
    }
    signal.throwIfAborted()
    await sendMedia(response, { ...payload, mimeType, headers }, range)
  } finally { await file.handle.close() }
}

export async function sendMedia(response, { handle, bytes, size, mimeType, headers: extraHeaders }, rangeHeader) {
  try {
    const headers = { 'Content-Type': mimeType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...extraHeaders }
    const range = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader ?? '')
    let start = 0
    let end = size - 1
    if (range) {
      if (range[1]) {
        start = Number(range[1])
        if (range[2]) end = Math.min(Number(range[2]), end)
      } else {
        start = Math.max(0, size - Number(range[2]))
      }
      if (!Number.isSafeInteger(start) || start > end) {
        response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` })
        response.end()
        return
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    }
    response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 })
    if (bytes) { response.end(bytes.subarray(start, end + 1)); return }
    if (!size) { response.end(); return }
    await pipeline(handle.createReadStream({ start, end }), response)
  } finally {
    await handle?.close()
  }
}

export async function listWorkspaceDirectory(cwd, path = '', { privateRoot } = {}) {
  if (typeof path !== 'string' || path.includes('\0') || isAbsolute(path)) throw fail(400, 'Invalid directory path')
  const root = await realpath(cwd).catch(() => { throw fail(404, 'Workspace not found') })
  const insideWorkspace = path => inside(root, path) && !(privateRoot && inside(privateRoot, path))
  const requested = resolve(root, path)
  if (!insideWorkspace(requested)) throw fail(403, 'Directory is outside this workspace')
  let handle
  try {
    const canonical = await realpath(requested)
    if (!insideWorkspace(canonical)) throw fail(403, 'Directory is outside this workspace')
    handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const descriptor = process.platform === 'linux' ? '/proc/self/fd/' + handle.fd : canonical
    if (!insideWorkspace(await realpath(descriptor))) throw fail(403, 'Directory is outside this workspace')
    const entries = []
    let truncated = false
    const directory = await opendir(descriptor)
    for await (const item of directory) {
      if (!item.isDirectory() && !item.isFile()) continue
      if (privateRoot && resolve(requested, item.name) === privateRoot) continue
      if (entries.length >= 2000) { truncated = true; break }
      entries.push({ name:item.name, path:relative(root, resolve(requested, item.name)), directory:item.isDirectory() })
    }
    entries.sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
    return { path:relative(root, requested), entries, truncated }
  } catch (error) {
    if (['ENOENT','ENOTDIR'].includes(error.code)) throw fail(404, 'Directory not found')
    if (['ELOOP','EACCES','EPERM'].includes(error.code)) throw fail(403, 'Directory is not accessible')
    throw error
  } finally { await handle?.close() }
}
