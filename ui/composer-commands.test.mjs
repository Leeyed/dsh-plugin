import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commandEntries, composerMenuEntries, filterCommandEntries, replaceSlashCommand, slashCommandAt } from './composer-commands.mjs'
import { codexPromptCommand, reviewDraft } from './review-command.mjs'

test('the first slash token opens the command chooser without claiming links or paths', () => {
  assert.deepEqual(slashCommandAt('  /mo  keep this', 5, 5), { start: 2, end: 5, query: 'mo' })
  assert.deepEqual(slashCommandAt('/', 1, 1), { start: 0, end: 1, query: '' })
  assert.equal(slashCommandAt('/tmp/project', 4, 4), null)
  assert.equal(slashCommandAt('show /model', 11, 11), null)
  assert.equal(slashCommandAt('/mo arguments', 9, 9), null)
  assert.equal(slashCommandAt('/mo', 1, 3), null)
})

test('selecting a slash command replaces the typed token and preserves trailing text', () => {
  const original = '  /mo  keep this'
  const range = slashCommandAt(original, 5, 5)
  assert.deepEqual(replaceSlashCommand(original, range, 'model'), { text: '  /model  keep this', caret: 9 })
  assert.deepEqual(replaceSlashCommand('/c', slashCommandAt('/c', 2, 2), 'compact'), { text: '/compact ', caret: 9 })
})

test('the picker uses only advertised commands and still accepts real commands such as /model', () => {
  const entries = commandEntries([
    { name: 'model', description: 'CLI model setting' },
    { name: 'plugin:plan', description: '编写计划', input: { hint: 'goal' } },
    { name: 'plugin:plan', description: 'duplicate' },
    { name: '/bad/path' },
    { name: 'two words' },
  ])
  assert.deepEqual(entries.map(item => item.id), ['cli:model', 'cli:plugin:plan'])
  assert.deepEqual(filterCommandEntries(entries, '计划').map(item => item.name), ['plugin:plan'])
  assert.deepEqual(filterCommandEntries(entries, 'goal').map(item => item.name), ['plugin:plan'])
  assert.deepEqual(filterCommandEntries(entries, '/resume'), [])
  assert.deepEqual(filterCommandEntries([{ id: 'ui:model', name: 'model', title: '模型' }], '模型').map(item => item.name), ['model'])
  assert.deepEqual(commandEntries([]), [])
})

test('the native menu keeps attachment and engine actions wired to their original entries', () => {
  const attachment = { id: 'ui:attachment', name: 'file', title: '文件', icon: () => {}, onSelect: () => {} }
  const parallel = { id: 'ui:parallel', name: 'parallel', title: '并行', onSelect: () => {} }
  const entries = commandEntries([{ name: 'review' }, { name: 'compact' }, { name: 'plan' }, { name: 'model' }])
  const uiModel = { id: 'ui:model', name: 'model', title: '模型', onSelect: () => {} }
  const t = key => ({ 'plus.add': '添加', 'plus.commands': '指令' })[key]
  const openMenu = composerMenuEntries([uiModel, ...entries], [attachment, parallel], '', t)
  assert.deepEqual(openMenu.map(({ candidate }) => [candidate.name, candidate.section]), [
    ['file', '添加'], ['plan', '添加'], ['parallel', '添加'], ['compact', '指令'],
    ['model', '指令'], ['model', '指令'], ['review', '指令'],
  ])
  assert.equal(openMenu[0].entry, attachment)
  assert.equal(openMenu[0].candidate.label, '文件')
  assert.equal(openMenu[0].candidate.icon, attachment.icon)
  assert.equal(openMenu[4].entry, uiModel)
  assert.equal(openMenu[5].entry.id, 'cli:model')

  const filtered = composerMenuEntries([uiModel, ...entries], [], '模型', t)
  assert.deepEqual(filtered.map(({ entry, candidate }) => [entry.id, candidate.name, candidate.section]), [
    ['ui:model', 'model', undefined],
  ])
})

test('a review draft requires an explicit valid target and preserves custom instructions', () => {
  assert.equal(reviewDraft(null, ''), undefined)
  assert.equal(reviewDraft('uncommitted', ''), '/review uncommitted')
  assert.equal(reviewDraft('base', ' feature/work '), '/review base feature/work')
  assert.equal(reviewDraft('base', 'ambiguous target'), undefined)
  assert.equal(reviewDraft('base', '-not-a-branch'), undefined)
  assert.equal(reviewDraft('commit', 'd34db33f'), '/review commit d34db33f')
  assert.equal(reviewDraft('commit', 'main'), undefined)
  assert.equal(reviewDraft('custom', ' Check tests.\nLook for regressions. '), '/review custom Check tests.\nLook for regressions.')
  assert.equal(reviewDraft('custom', '   '), undefined)
  assert.equal(codexPromptCommand('  /review base main '), 'review')
  assert.equal(codexPromptCommand('/compact'), 'compact')
  assert.equal(codexPromptCommand('/review/file'), undefined)
})

