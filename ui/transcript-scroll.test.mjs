import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranscriptFollow, isNearTranscriptBottom, transcriptTurnItems } from './transcript-scroll.mjs'

test('the turn rail keeps its numbering and previews when an earlier turn enters the transcript window', () => {
  const messages = [
    { role: 'assistant', text: 'An initial notice' },
    { role: 'user', text: ' First\n question ' },
    { role: 'assistant', text: 'First fragment' },
    { role: 'assistant', text: ' Final\t answer ' },
    { role: 'assistant', text: '   ' },
    { role: 'user', attachments: [{ name: 'log.txt' }] },
  ]
  const firstTurn = { turn: 1, prompt: 'First question', response: 'Final answer' }
  const secondTurn = { turn: 2, prompt: '', response: '', anchor: { kind: 'loaded', key: '5' } }
  assert.deepEqual(transcriptTurnItems(messages, 3), [
    { ...firstTurn, anchor: { kind: 'unloaded', seq: 1 } }, secondTurn,
  ])
  assert.deepEqual(transcriptTurnItems(messages, 1), [
    { ...firstTurn, anchor: { kind: 'loaded', key: '1' } }, secondTurn,
  ])
})

function transcript() {
  return {
    scrollHeight: 1000,
    clientHeight: 400,
    scrollTop: 600,
    scrollTo({ top, behavior }) {
      assert.equal(behavior, 'instant')
      this.scrollTop = top
    },
  }
}

test('following is sampled when scrolling settles, with the native 25px tolerance', () => {
  const node = transcript()
  const changes = []
  const follow = createTranscriptFollow(following => changes.push(following))
  node.scrollTop = 574
  follow.observe(node)
  assert.equal(follow.pending, true)
  assert.equal(follow.following, true)
  follow.settle(node)
  assert.deepEqual(changes, [false])

  node.scrollTop = 575
  assert.equal(isNearTranscriptBottom(node), true)
  follow.observe(node)
  follow.settle(node)
  assert.deepEqual(changes, [false, true])
})

test('reaching the floor or jumping there restores following and cancels the pending sample', () => {
  const node = transcript()
  const changes = []
  const follow = createTranscriptFollow(following => changes.push(following))
  follow.setFollowing(false)
  node.scrollTop = 200
  follow.observe(node)
  node.scrollHeight = 1100
  assert.equal(follow.toBottom(node), 700)
  assert.equal(node.scrollTop, 700)
  assert.equal(follow.pending, false)

  follow.setFollowing(false)
  node.scrollTop = 650
  follow.observe(node)
  node.scrollTop = 700
  follow.observe(node)
  assert.equal(follow.pending, false)
  assert.deepEqual(changes, [false, true, false, true])
})

test('the fallback samples after 500ms and cleanup cancels outstanding work', ({ mock }) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const node = transcript()
  const follow = createTranscriptFollow(() => {})
  node.scrollTop = 200
  follow.observe(node)
  mock.timers.tick(499)
  assert.equal(follow.following, true)
  mock.timers.tick(1)
  assert.equal(follow.following, false)

  node.scrollTop = 590
  follow.observe(node)
  follow.cancelSample()
  mock.timers.tick(500)
  assert.equal(follow.pending, false)
  assert.equal(follow.following, false)
})
