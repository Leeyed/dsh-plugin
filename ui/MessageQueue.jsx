import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { attachmentKind } from './chat-state.mjs'

export function createQueueDockSource(ctx) {
  const slot = 'conversation.input.dock'
  return {
    subscribe: fn => ctx.slots.subscribe(slot, fn),
    getSnapshot: () => ctx.slots.entries(slot).find(entry => entry.options.id === 'queue')?.component,
    t: ctx.locale.bind('conversation'),
  }
}

function submissionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // Remote HTTP workspaces may expose getRandomValues without randomUUID.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function pendingQueueSubmission(text, files, capabilities) {
  const requestId = submissionId()
  const attachments = files.map(file => attachmentKind(file, capabilities) === 'image'
    ? { type: 'image', value: { previewUrl: URL.createObjectURL(file) } }
    : { type: 'file', value: { name: file.name, bytes: file.size } })
  return { requestId, placement: 'queued', text, attachments }
}

function nativeQueueRow(item) {
  const content = [{ type: 'text', text: item.text }]
  for (const [index, file] of (item.attachments ?? []).entries()) {
    if (file.type !== 'image' && file.bytes === undefined) {
      content.push({ type: 'text', text: ' ' + file.name })
    } else {
      content.push({
        type: file.type === 'image' ? 'image' : 'file',
        attachment: { ...file, attachmentId: item.id + '/' + index, itemId: item.id, index },
      })
    }
  }
  return { id: item.id, source: { kind: 'user', rpcId: item.clientRequestId }, content }
}

export function MessageQueue({ source, renderFactorySlot, id, queue, pending, canSteer, enabled, change, fallback }) {
  const Dock = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const inbox = useMemo(() => ({ 'next-turn': queue.map(nativeQueueRow) }), [queue])
  const pendingSubmissions = useMemo(() => pending ? [pending] : [], [pending])
  const loadImage = useCallback(async ({ itemId, index }) =>
    '/api/direct-chat/sessions/' + encodeURIComponent(id) + '/queue-image?' + new URLSearchParams({item:itemId, index}), [id])
  if (!Dock) return fallback
  const state = { pendingSubmissions, running: canSteer, subagent: enabled ? null : { address: { mode: 'readonly' } } }
  return <Dock renderFactorySlot={renderFactorySlot} useProjection={() => inbox} useSession={select => select(state)} t={source.t}
    loadImage={loadImage} notify={() => { /* perform already displays the specific host error. */ }}
    updateQueue={(itemId, action) => change(action.kind, itemId, action.kind === 'edit' ? action.content[0].text : undefined)} />
}
