const FOLLOW_THRESHOLD = 25
const SCROLL_SAMPLE_INTERVAL = 500

export function transcriptTurnItems(messages, hiddenMessageCount) {
  const items = []
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'user') {
      items.push({
        turn: items.length + 1,
        prompt: (message.text || '').trim().replace(/\s+/g, ' ').slice(0, 140),
        response: '',
        anchor: messageIndex < hiddenMessageCount
          ? { kind: 'unloaded', seq: messageIndex }
          : { kind: 'loaded', key: String(messageIndex) },
      })
    } else if (message.role === 'assistant' && items.length > 0 && message.text?.trim()) {
      items.at(-1).response = message.text.trim().replace(/\s+/g, ' ').slice(0, 240)
    }
  }
  return items
}

function transcriptFloor(node) {
  return Math.max(0, node.scrollHeight - node.clientHeight)
}

export function isNearTranscriptBottom(node) {
  return transcriptFloor(node) - node.scrollTop <= FOLLOW_THRESHOLD
}

export function createTranscriptFollow(onChange) {
  let following = true
  let sampleTimer = null

  function cancelSample() {
    if (sampleTimer === null) return
    clearTimeout(sampleTimer)
    sampleTimer = null
  }

  function setFollowing(next) {
    cancelSample()
    if (following === next) return
    following = next
    onChange(next)
  }

  function settle(node) {
    if (sampleTimer !== null) setFollowing(isNearTranscriptBottom(node))
  }

  return {
    get following() { return following },
    get pending() { return sampleTimer !== null },
    setFollowing,
    settle,
    cancelSample,
    observe(node) {
      if (Math.abs(transcriptFloor(node) - node.scrollTop) < 1) setFollowing(true)
      else sampleTimer ??= setTimeout(() => settle(node), SCROLL_SAMPLE_INTERVAL)
    },
    toBottom(node) {
      const top = transcriptFloor(node)
      if (node.scrollTop !== top) node.scrollTo({ top, behavior: 'instant' })
      setFollowing(true)
      return node.scrollTop
    },
  }
}
