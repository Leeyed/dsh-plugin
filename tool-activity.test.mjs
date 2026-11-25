import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendExecutionText, commandExecution, completeExecution } from './tool-activity.mjs'

test('keeps bounded head and tail previews identical for streamed and final tool output', () => {
  const chunks = ['x'.repeat(8191) + '🌱', 'z'.repeat(10_000), 'example failure\n']
  const streamed = chunks.reduce((previous, chunk) => appendExecutionText(previous, 'output', chunk), undefined)
  const final = commandExecution({ output: chunks.join('') })
  assert.deepEqual(streamed, final)
  assert.deepEqual(commandExecution(streamed), streamed)
  assert.equal(final.output.length, 8191)
  assert.equal(final.outputTail.length, 8192)
  assert.ok(final.outputTail.endsWith('example failure\n'))
  assert.equal(final.outputTruncated, true)
})

test('replaces the live preview with the final native streams and keeps the command and input', () => {
  const live = commandExecution({ command: 'echo fixture', input: 'stdin', output: 'x'.repeat(20_000) })
  const result = commandExecution({ stdout: '', stderr: 'example failure', exitCode: 1, env: { SECRET: 'fixture' } })
  assert.deepEqual(completeExecution(live, result), {
    command: 'echo fixture', input: 'stdin', stdout: '', stderr: 'example failure', exitCode: 1,
  })
})
