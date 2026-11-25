// Codex stores replies from its question picker as a whole user message.
export function questionReply(text) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('<send_user_message_question_reply>')) return
  const match = /^\s*<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>\s*$/.exec(text)
  if (!match) return
  let replies
  try { replies = JSON.parse(match[1]) } catch { return }
  if (!Array.isArray(replies) || !replies.length) return
  const result = []
  for (const entry of replies) {
    if (typeof entry?.question !== 'string' || !entry.question.trim()) return
    const answers = Array.isArray(entry.answer) ? entry.answer : [entry.answer]
    if (!answers.length || !answers.every(answer => typeof answer === 'string')) return
    result.push({question:entry.question, answer:answers.join('、')})
  }
  return result
}
