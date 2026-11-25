import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { IconPlusOutlineMedium, isMobileDevice, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import composerCss from '@deepseek-ai/dsh-client-ui-conversation/src/client/skeleton/InputBar.module.css'
import { MenuView } from '@deepseek-ai/dsh-client-ui-input-trigger/src/client/MenuView.tsx'
import { stageCommand } from './chat-state.mjs'
import {
  atMentionAt, composerMenuEntries, filterMentionEntries, replaceAtMention,
  replaceSlashCommand, slashCommandAt, splitMentionQuery,
} from './composer-commands.mjs'

const noSubscription = () => () => {}
const emptyHeaders = new Map()

export function useComposerCommands({ input, draft, onDraft, onNativeChoice, entries, addItems, sessionId, disabled, t }) {
  const source = `direct-chat-command-${useId()}`
  const mentionSource = `direct-chat-mention-${useId()}`
  const caretAfterUpdate = useRef(null)
  const composing = useRef(false)
  const compositionEnded = useRef(false)
  const fileCache = useRef(new Map())
  const [selection, setSelection] = useState(null)
  const [dismissedDraft, setDismissedDraft] = useState(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [mentionState, setMentionState] = useState({ key: '', status: 'idle', entries: [] })
  const typedRange = selection && slashCommandAt(draft, selection.start, selection.end)
  const slashRange = !plusOpen && dismissedDraft !== draft ? typedRange : null
  const mentionRange = !disabled && !plusOpen && !slashRange && dismissedDraft !== draft && selection
    ? atMentionAt(draft, selection.start, selection.end)
    : null
  const mentionParts = mentionRange ? splitMentionQuery(mentionRange.query) : null
  const mentionKey = mentionParts && sessionId ? `${sessionId}:${mentionParts.dir}` : ''

  useEffect(() => {
    fileCache.current.clear()
  }, [sessionId])

  useEffect(() => {
    if (!mentionKey || !sessionId || !mentionParts) return
    const cached = fileCache.current.get(mentionKey)
    if (cached) {
      setMentionState({ key: mentionKey, status: 'ready', entries: cached })
      return
    }
    const controller = new AbortController()
    setMentionState({ key: mentionKey, status: 'pending', entries: [] })
    const query = new URLSearchParams({ path: mentionParts.dir }).toString()
    fetch(`/api/direct-chat/sessions/${encodeURIComponent(sessionId)}/files?${query}`, {
      signal: controller.signal,
      credentials: 'same-origin',
    }).then(async response => {
      if (!response.ok) return []
      const data = await response.json().catch(() => null)
      return Array.isArray(data?.entries) ? data.entries : []
    }).then(list => {
      if (controller.signal.aborted) return
      fileCache.current.set(mentionKey, list)
      setMentionState({ key: mentionKey, status: 'ready', entries: list })
    }).catch(() => {
      if (!controller.signal.aborted) setMentionState({ key: mentionKey, status: 'ready', entries: [] })
    })
    return () => controller.abort()
  }, [mentionKey, sessionId])

  const commandItems = !disabled && (plusOpen || slashRange)
    ? composerMenuEntries(entries, plusOpen ? addItems : [], slashRange?.query ?? '', t)
    : []
  const mentionPending = Boolean(mentionRange && (!sessionId || mentionState.key !== mentionKey || mentionState.status === 'pending'))
  const mentionEntries = mentionRange && mentionState.key === mentionKey
    ? filterMentionEntries(mentionState.entries, mentionParts?.needle ?? '')
    : []
  const mentionActive = Boolean(mentionRange && (mentionPending || mentionEntries.length > 0))
  const mode = commandItems.length > 0 ? 'command' : mentionActive ? 'mention' : null
  const allItems = mode === 'command'
    ? commandItems
    : mode === 'mention'
      ? mentionEntries.map(entry => ({
          entry: { id: `mention:${entry.path}`, mention: entry },
          candidate: {
            name: entry.name,
            label: entry.name,
            icon: entry.directory ? 'folder' : 'file',
            drill: entry.directory,
          },
        }))
      : []
  const open = mode !== null
  const activeSource = mode === 'mention' ? mentionSource : source
  const activeIndex = allItems.length > 0 ? Math.max(0, allItems.findIndex(({ entry }) => entry.id === selectedId)) : -1
  const highlight = allItems.length > 0 ? { source: activeSource, index: activeIndex } : null
  const mentionCrumbs = (() => {
    if (mode !== 'mention' || !mentionParts?.dir) return emptyHeaders
    const segments = mentionParts.dir.split('/').filter(Boolean)
    const trail = [
      { label: t('mention.root'), value: '' },
      ...segments.map((seg, i) => ({
        label: seg,
        value: segments.slice(0, i + 1).join('/'),
        current: i === segments.length - 1,
      })),
    ]
    return new Map([[mentionSource, trail]])
  })()
  const menuState = {
    open,
    hit: null,
    generation: 0,
    groups: open ? [{
      source: activeSource,
      status: mode === 'mention' && mentionPending ? 'pending' : 'ready',
      showGroupTitle: false,
      items: allItems.map(({ candidate }) => candidate),
    }] : [],
    highlight,
  }
  const menu = { subscribe: noSubscription, getSnapshot: () => menuState }
  const headers = { subscribe: noSubscription, getSnapshot: () => mentionCrumbs }

  const track = node => setSelection({ start: node.selectionStart, end: node.selectionEnd })
  const close = () => {
    setPlusOpen(false)
    setDismissedDraft(draft)
    setSelectedId(null)
  }
  const refocus = () => input.current?.focus({ preventScroll: true })
  const updateDraft = ({ text, caret }) => {
    const node = input.current
    onDraft(text)
    refocus()
    if (node?.value === text) node.setSelectionRange(caret, caret)
    else caretAfterUpdate.current = caret
  }

  useLayoutEffect(() => {
    if (caretAfterUpdate.current === null) return
    const caret = caretAfterUpdate.current
    caretAfterUpdate.current = null
    input.current?.setSelectionRange(caret, caret)
    setSelection({ start: caret, end: caret })
  }, [draft, input])

  useEffect(() => {
    if (disabled) setPlusOpen(false)
  }, [disabled])

  const choose = (entry, range = slashRange, action) => {
    if (!entry || disabled) return
    if (entry.mention && mentionRange) {
      const drill = action === 'drill' && entry.mention.directory
      if (!drill) close()
      else setSelectedId(null)
      updateDraft(replaceAtMention(draft, mentionRange, entry.mention.path, { drill }))
      return
    }
    const stripped = range
      ? `${draft.slice(0, range.start)}${draft.slice(range.end).replace(/^\s+/, '')}`
      : draft
    close()
    if (typeof entry.onSelect === 'function') {
      if (range) updateDraft({ text: stripped, caret: range.start })
      entry.onSelect()
      return
    }
    if (onNativeChoice?.(entry, stripped, range)) return
    if (range) {
      updateDraft(replaceSlashCommand(draft, range, entry.name))
    } else {
      const text = stageCommand(draft, entry.name, entries)
      updateDraft({ text, caret: entry.name.length + 2 })
    }
  }

  const imeGuard = event => {
    const ongoing = composing.current || event.nativeEvent.isComposing || event.keyCode === 229
    const ended = compositionEnded.current
    compositionEnded.current = false
    if (ended && !ongoing && event.key === 'Enter') event.preventDefault()
    return ongoing || ended
  }

  const handlePickerKey = event => {
    if (!open || event.ctrlKey || event.altKey || event.metaKey) return false
    if (event.key === 'Escape' || event.shiftKey && event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return true
    }
    if (event.shiftKey) return false
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setSelectedId(allItems[(activeIndex + step + allItems.length) % allItems.length].entry.id)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      if (allItems.length === 0) return false
      event.preventDefault()
      const picked = allItems[activeIndex]?.entry
      const action = event.key === 'Tab' && picked?.mention?.directory ? 'drill' : undefined
      if (!event.repeat) choose(picked, slashRange, action)
      return true
    }
    return false
  }

  const menuText = key => ({
    'suggestions.aria': t('composer.commandList'),
    'crumbs.aria': t('mention.crumbs'),
    loading: t('mention.loading'),
    'drill.hint': t('mention.drillHint'),
    'drill.key': t('mention.drillKey'),
    'drill.aria': t('mention.drillAria'),
  }[key] ?? key)

  return {
    dropdown: open && <div className={composerCss.overlayAnchor} data-composer-overlay>
      <MenuView menu={menu} headers={headers} t={menuText}
        onPick={(_, index, action) => choose(allItems[index]?.entry, slashRange, action)}
        onHover={(_, index) => setSelectedId(allItems[index]?.entry.id)}
        onCrumb={(_, index) => {
          const trail = mentionCrumbs.get(mentionSource)
          const crumb = trail?.[index]
          if (!crumb || !mentionRange) return
          const prefix = crumb.value ? `${crumb.value}/` : ''
          const before = draft.slice(0, mentionRange.start)
          const tail = draft.slice(mentionRange.end)
          updateDraft({ text: `${before}@${prefix}${tail}`, caret: before.length + 1 + prefix.length })
        }}
        onDismiss={close} />
    </div>,
    plus: (addItems.length > 0 || entries.length > 0) && <Tooltip label={t('plus.title')} side="top" delayMs={500} portal>
      <button type="button" className={composerCss.add} aria-label={t('plus.title')} aria-haspopup="listbox"
        aria-expanded={plusOpen && open} disabled={disabled}
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          if (!event.detail || !isMobileDevice()) refocus()
          if (plusOpen) return close()
          setSelectedId(null)
          setPlusOpen(true)
        }}>
        <IconPlusOutlineMedium size={14} />
      </button>
    </Tooltip>,
    stageText(text) {
      close()
      setDismissedDraft(text)
      updateDraft({ text, caret: text.length })
    },
    stageNative: name => choose(entries.find(entry => entry.name === name), null),
    handleInputKey(event) {
      return event.defaultPrevented || imeGuard(event) || handlePickerKey(event)
    },
    inputProps: {
      onCompositionStart: event => {
        composing.current = true
        compositionEnded.current = false
        event.currentTarget.dataset.composerComposing = ''
      },
      onCompositionEnd: event => {
        composing.current = false
        compositionEnded.current = true
        delete event.currentTarget.dataset.composerComposing
      },
      onKeyUp: () => { compositionEnded.current = false },
      onChange(event) {
        onDraft(event.currentTarget.value)
        track(event.currentTarget)
        setPlusOpen(false)
        setDismissedDraft(null)
        setSelectedId(null)
      },
      onFocus: event => track(event.currentTarget),
      onSelect: event => track(event.currentTarget),
      onBlur() {
        composing.current = false
        compositionEnded.current = false
        setPlusOpen(false)
        setSelection(null)
      },
      'aria-autocomplete': 'list',
      'aria-activedescendant': highlight ? `dsh-slash-option-${source}-${activeIndex}` : undefined,
    },
  }
}
