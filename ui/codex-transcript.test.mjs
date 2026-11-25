import assert from 'node:assert/strict'
import {test} from 'node:test'
import {questionReply} from './codex-transcript.mjs'
import {inlineFileReference} from './chat-state.mjs'

test('only a whole Codex protocol reply is displayed as questions and answers',()=>{
  const body=JSON.stringify([{question:'何时出现？',answer:'只是点开已有会话',questionItemId:'private-id'}])
  const message='<send_user_message_question_reply>\n'+body+'\n</send_user_message_question_reply>'
  assert.deepEqual(questionReply(message),[{question:'何时出现？',answer:'只是点开已有会话'}])
  for (const text of ['用户引用\n'+message,message+'\n补充','<send_user_message_question_reply>invalid</send_user_message_question_reply>']) assert.equal(questionReply(text),undefined)
  assert.equal(inlineFileReference('thread/resume'),undefined)
  assert.equal(inlineFileReference('./thread/resume').path,'./thread/resume')
})
