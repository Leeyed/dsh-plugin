import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendFile, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { nativeCatalog, nativeId } from '../server/native-history.mjs'
import { createEngineRegistry } from '../registry.mjs'

const started = '2026-10-04T08:01:02.345Z'
const ended = '2026-10-04T08:04:02.345Z'
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + '\n'

async function testHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-native-history-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('finds Codex native spawn edges and reads CLI dates and messages', async t => {
  const home = await testHome(t)
  const codex = join(home, 'codex')
  const cwd = join(home, 'workspace')
  const runs = join(codex, 'sessions', '2026', '10', '04')
  const archive = join(codex, 'archived_sessions')
  for (const path of [runs, cwd, archive]) await mkdir(path, { recursive: true })
  const [parent, child, leaf, review, archived] = Array.from({ length: 5 }, randomUUID)
  for (const id of [parent, child, leaf, review, archived]) {
    const source = id === parent || id === archived ? 'cli'
      : id === child ? { subagent: { thread_spawn: { parent_thread_id: parent } } }
      : id === leaf ? { subagent: { thread_spawn: { parent_thread_id: child } } }
      : { subagent: 'review' }
    const file = join(id === archived ? archive : runs, 'rollout-' + id + '.jsonl' + (id === archived ? '.zst' : ''))
    const transcript = jsonl([
      { type: 'session_meta', timestamp: started, payload: { id, source, cwd } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: 'hidden' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Question' }] } },
      { type: 'response_item', payload: { type: 'agent_message', author: '/root/child', recipient: '/root', content: 'internal' } },
      { type: 'response_item', timestamp: ended, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] } },
    ])
    await writeFile(file, id === archived ? zstdCompressSync(transcript) : transcript)
    await utimes(file, new Date('2029-01-01'), new Date('2029-01-01'))
  }
  await writeFile(join(codex, 'session_index.jsonl'), jsonl([{ id: parent, thread_name: 'terminal title' }]))
  const db = new DatabaseSync(join(codex, 'state_5.sqlite'))
  db.exec(`CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,source TEXT,created_at INTEGER,updated_at_ms INTEGER,archived INTEGER);
    CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT,status TEXT)`)
  const addThread = db.prepare('INSERT INTO threads VALUES(?,?,?,?,?,?,?)')
  addThread.run(parent, cwd, 'Parent', 'cli', Date.parse(started) / 1000, Date.parse(ended), 0)
  addThread.run(child, cwd, 'Native worker', JSON.stringify({ subagent: { thread_spawn: {} } }), Date.parse(started) / 1000, Date.parse(ended), 0)
  db.prepare('INSERT INTO thread_spawn_edges VALUES(?,?,?)').run(parent, child, 'closed')
  db.close()
  const registry = createEngineRegistry({ engines: ['codex'] })
  const catalog = nativeCatalog({ registry, home, codex })
  const entries = await catalog.list()
  assert.equal(entries.size, 4)
  assert.equal(entries.get(nativeId('codex', parent)).title, 'terminal title')
  assert.equal(entries.get(nativeId('codex', archived)).archived, true)
  const [worker] = await catalog.children('codex', parent)
  assert.equal(worker.remoteId, child)
  assert.equal(worker.parentId, nativeId('codex', parent))
  assert.equal(worker.status, 'idle')
  const [nested] = await catalog.children('codex', child)
  assert.equal(nested.remoteId, leaf)
  for (const entry of entries.values()) {
    assert.equal(entry.cwd, cwd)
    assert.equal(entry.createdAt, Date.parse(started))
    assert.equal(entry.updatedAt, Date.parse(ended))
    assert.deepEqual(await catalog.messages(entry), [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }])
  }
  const refreshed = new DatabaseSync(join(codex, 'state_5.sqlite'))
  refreshed.exec('ALTER TABLE threads ADD COLUMN name TEXT; ALTER TABLE threads ADD COLUMN history_mode TEXT')
  refreshed.prepare('UPDATE threads SET name=?, history_mode=? WHERE id=?').run('Current native name', 'paginated', parent)
  refreshed.close()
  assert.equal((await catalog.list(true)).get(nativeId('codex', parent)).nativeTitle, 'Current native name')
})

test('imports Codex tool locations from completed items and older patch events', async t => {
  const home = await testHome(t)
  const file = join(home, 'rollout.jsonl')
  const response = payload => ({ type: 'response_item', payload })
  const event = payload => ({ type: 'event_msg', payload })
  await writeFile(file, jsonl([
    response({ type: 'message', role: 'user', content: 'Inspect files' }),
    response({ type: 'function_call', name: 'exec_command', call_id: 'read', arguments: '{"cmd":"cat docs/README.md"}' }),
    event({ type: 'item_completed', item: {
      type: 'CommandExecution', id: 'read', status: 'completed', command: ['cat', 'docs/README.md'],
      cwd: 'file:///workspace/subdir', parsed_cmd: [{ type: 'read', path: 'docs/README.md' }],
      aggregated_output: 'fixture read result\n', exit_code: 0,
    } }),
    event({ type: 'item_completed', item: {
      type: 'CommandExecution', id: 'unknown', status: 'completed', command: ['echo', 'fake/path.md'],
      cwd: '/workspace', parsed_cmd: [{ type: 'unknown' }],
    } }),
    event({ type: 'item_completed', item: {
      type: 'FileChange', id: 'add', status: 'completed', changes: { 'new.txt': { type: 'add', content: 'fixture' } },
    } }),
    event({ type: 'patch_apply_end', call_id: 'move', success: true,
      changes: { 'old.txt': { type: 'update', move_path: 'renamed.txt' } } }),
    response({ type: 'custom_tool_call', name: 'apply_patch', call_id: 'delete', input: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch' }),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['codex'] }), home })
  const messages = await catalog.messages({ engine: 'codex', file })
  assert.deepEqual(messages.map(({ role, text }) => [role, text]), [['user', 'Inspect files'], ['assistant', '']])
  assert.deepEqual(messages[1].tools.map(({ toolCallId, kind, locations }) => [toolCallId, kind, locations]), [
    ['read', 'read', [{ path: '/workspace/subdir/docs/README.md' }]],
    ['unknown', 'execute', undefined],
    ['add', 'write', [{ path: 'new.txt' }]],
    ['move', 'move', [{ path: 'old.txt' }, { path: 'renamed.txt' }]],
    ['delete', 'delete', [{ path: 'gone.txt' }]],
  ])
  assert.deepEqual(messages[1].tools[0].execution, {
    command: 'cat docs/README.md', output: 'fixture read result\n', exitCode: 0,
  })
  assert.deepEqual(messages[1].steps[0].tool.execution, messages[1].tools[0].execution)
  assert.deepEqual(messages[1].tools[1].execution, { command: 'echo fake/path.md' })
})

test('imports prior Codex shell result envelopes and skips wrapper process results', async t => {
  const home = await testHome(t)
  const file = join(home, 'rollout.jsonl')
  const response = payload => ({ type: 'response_item', payload })
  await writeFile(file, jsonl([
    response({ type: 'message', role: 'user', content: 'Run two tools' }),
    response({ type: 'function_call', name: 'write_stdin', call_id: 'stdin', arguments: '{"chars":"test input"}' }),
    response({ type: 'function_call_output', call_id: 'stdin',
      output: 'Chunk ID: fixture\nWall time: 0.1 seconds\nProcess exited with code 2\nOutput:\nlast line\n' }),
    response({ type: 'custom_tool_call', name: 'exec', call_id: 'wrapper', input: 'fixture script' }),
    response({ type: 'custom_tool_call_output', call_id: 'wrapper',
      output: 'Wall time: 0.5 seconds\nProcess exited with code 0\nOutput:\nwrapper process log' }),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['codex'] }), home })
  const [, assistant] = await catalog.messages({ engine: 'codex', file })
  assert.deepEqual(assistant.tools[0].execution, { input: 'test input', output: 'last line\n', exitCode: 2 })
  assert.equal(assistant.tools[0].status, 'failed')
  assert.equal(assistant.tools[1].execution, undefined)
})

test('keeps Codex tools at their first appearance when they finish after a progress update', async t => {
  const home = await testHome(t)
  const file = join(home, 'rollout.jsonl')
  const event = payload => ({ type: 'event_msg', payload })
  const command = (id, status) => ({ type: 'CommandExecution', id, status, command: ['echo', id] })
  await writeFile(file, jsonl([
    event({ type: 'user_message', message: 'Inspect' }),
    event({ type: 'item_started', item: command('first', 'in_progress') }),
    event({ type: 'agent_message', phase: 'commentary', message: 'Checking' }),
    event({ type: 'item_completed', item: command('first', 'completed') }),
    event({ type: 'item_completed', item: command('second', 'completed') }),
    event({ type: 'agent_message', phase: 'final_answer', message: 'Done' }),
    event({ type: 'item_completed', item: command('trailing', 'completed') }),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['codex'] }), home })
  const messages = await catalog.messages({ engine: 'codex', file })
  assert.deepEqual(messages.map(message => [message.text, message.tools?.map(({ toolCallId, status }) => [toolCallId, status])]), [
    ['Inspect', undefined],
    ['Checking', [['first', 'completed']]],
    ['Done', [['second', 'completed']]],
    ['', [['trailing', 'completed']]],
  ])
})

test('preserves progress before the five commands in a mixed Codex rollout', async t => {
  const home = await testHome(t)
  const file = join(home, 'rollout.jsonl')
  const response = payload => ({ type: 'response_item', payload })
  const event = payload => ({ type: 'event_msg', payload })
  const item = payload => event({ type: 'item_completed', item: payload })
  const commands = Array.from({ length: 5 }, (_, index) => 'read-' + index)
  await writeFile(file, jsonl([
    event({ type: 'task_started', turn_id: 'older' }),
    event({ type: 'user_message', message: 'Older question' }),
    event({ type: 'agent_message', message: 'Older reply' }),
    event({ type: 'task_complete', turn_id: 'older' }),
    event({ type: 'task_started', turn_id: 'current' }),
    response({ type: 'message', id: 'input', role: 'user', content: 'Inspect' }),
    item({ type: 'UserMessage', id: 'user', content: [{ type: 'text', text: 'Inspect' }] }),
    item({ type: 'AgentMessage', id: 'progress', phase: 'commentary', content: [{ type: 'Text', text: 'Checking' }] }),
    response({ type: 'message', id: 'progress', role: 'assistant', phase: 'commentary', content: 'Checking' }),
    ...commands.flatMap(id => [
      response({ type: 'custom_tool_call', name: 'exec', call_id: 'wrapper-' + id, input: 'synthetic wrapper' }),
      item({ type: 'CommandExecution', id, status: 'completed', command: ['echo', id], source: 'unified_exec_startup' }),
      response({ type: 'custom_tool_call_output', call_id: 'wrapper-' + id }),
    ]),
    item({ type: 'AgentMessage', id: 'answer', phase: 'final_answer', content: [{ type: 'Text', text: 'Done' }] }),
    response({ type: 'message', id: 'answer', role: 'assistant', phase: 'final_answer', content: 'Done' }),
    response({ type: 'custom_tool_call', name: 'exec', call_id: 'standalone', input: 'synthetic standalone call' }),
    response({ type: 'custom_tool_call_output', call_id: 'standalone' }),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['codex'] }), home })
  const messages = await catalog.messages({ engine: 'codex', file })
  assert.deepEqual(messages.map(({ role, text, phase, steps }) => [role, text, phase, steps?.map(step => step.tool.toolCallId)]), [
    ['user', 'Older question', undefined, undefined],
    ['assistant', 'Older reply', undefined, undefined],
    ['user', 'Inspect', undefined, undefined],
    ['assistant', 'Checking', 'commentary', undefined],
    ['assistant', 'Done', 'final_answer', commands],
    ['assistant', '', undefined, ['standalone']],
  ])
})

test('finds AGY direct and indexed children and interprets nanosecond timestamps in UTC', async t => {
  const home = await testHome(t)
  const agy = join(home, 'agy')
  const cwd = join(home, 'workspace')
  for (const path of [agy, cwd]) await mkdir(path)
  const [parent, child, linked] = Array.from({ length: 3 }, randomUUID)
  const db = new DatabaseSync(join(agy, 'conversation_summaries.db'))
  db.exec(`CREATE TABLE conversation_summaries(conversation_id,title,last_modified_time,workspace_uris,step_count,parent_conversation_id,status,killed,not_fully_idle);
    CREATE TABLE conversation_parents(conversation_id,parent_id);
    CREATE TABLE conversations_fts(conversation_id,chunk_index,user_step_byte_offsets,agent_step_byte_offsets,user_body,agent_body)`)
  const add = db.prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?,?)')
  add.run(parent, 'Parent', '2026-10-04 16:01:02.345678901+08:00', JSON.stringify(['file://' + cwd]), 4, null, 'CASCADE_RUN_STATUS_IDLE', 0, 0)
  add.run(child, 'Child', '2026-10-04 08:04:02.345678901+00:00', JSON.stringify(['file://' + cwd]), 4, parent, 'CASCADE_RUN_STATUS_IDLE', 0, 0)
  add.run(linked, 'Running', '2026-10-04 08:04:02.345678901+00:00', null, 0, null, 'CASCADE_RUN_STATUS_IDLE', 0, 1)
  db.prepare('INSERT INTO conversation_parents VALUES(?,?)').run(linked, parent)
  db.prepare('INSERT INTO conversations_fts VALUES(?,?,?,?,?,?)').run(child, 0, '[[0,0],[2,4]]', '[[1,0]]', '问\n二', '答')
  db.close()
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['agy'] }), home, agy })
  const entries = await catalog.list()
  assert.equal(entries.get(nativeId('agy', parent)).updatedAt, Date.parse(started))
  assert.equal(entries.get(nativeId('agy', parent)).nativeTitle, 'Parent')
  const workers = await catalog.children('agy', parent)
  assert.deepEqual(workers.map(worker => [worker.remoteId, worker.status]), [[child, 'idle'], [linked, 'running']])
  for (const worker of workers) {
    assert.equal(worker.cwd, cwd)
    assert.equal(worker.parentId, nativeId('agy', parent))
    assert.equal(worker.updatedAt, Date.parse(ended))
  }
  assert.deepEqual(await catalog.messages(workers[0]), [
    { role: 'user', text: '问' }, { role: 'assistant', text: '答' }, { role: 'user', text: '二' },
  ])
})

test('reads the complete AGY transcript before the shortened log', async t => {
  const home = await testHome(t)
  const remoteId = randomUUID()
  const agy = join(home, 'agy')
  const logs = join(agy, 'brain', remoteId, '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const full = join(logs, 'transcript_full.jsonl')
  await writeFile(full, jsonl([
    { type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>Complete request</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Complete answer' },
  ]))
  await writeFile(join(logs, 'transcript.jsonl'), jsonl([
    { type: 'USER_INPUT', step_index: 0, content: 'Shortened request', truncated_fields: ['content'] },
    { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Shortened answer', truncated_fields: ['content'] },
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['agy'] }), home, agy })
  const entry = { engine: 'agy', remoteId, file: join(agy, 'conversation_summaries.db') }
  assert.deepEqual(await catalog.messages(entry), [
    { role: 'user', text: 'Complete request' }, { role: 'assistant', text: 'Complete answer' },
  ])
  await writeFile(full, 'invalid\n')
  assert.deepEqual(await catalog.messages(entry), [
    { role: 'user', text: 'Shortened request' }, { role: 'assistant', text: 'Shortened answer' },
  ])
})

test('keeps AGY planner messages and activity with their user turns', async t => {
  const home = await testHome(t)
  const remoteId = randomUUID()
  const agy = join(home, 'agy')
  const logs = join(agy, 'brain', remoteId, '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const tool = name => ({ name, args: { toolSummary: name } })
  await writeFile(join(logs, 'transcript.jsonl'), jsonl([
    { type: 'USER_INPUT', step_index: 0, content: '<USER_REQUEST>First</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', step_index: 1, content: 'Progress', tool_calls: [tool('Inspect')] },
    { type: 'GENERIC', step_index: 2 },
    { type: 'PLANNER_RESPONSE', step_index: 3, content: 'Answer', tool_calls: [tool('Check')] },
    { type: 'PLANNER_RESPONSE', step_index: 4, thinking: 'First thought', tool_calls: [tool('Verify')] },
    { type: 'USER_INPUT', step_index: 5, content: '<USER_REQUEST>Continue</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', step_index: 6, thinking: 'Second thought',
      tool_calls: [{ name: 'read_file', args: JSON.stringify({ toolSummary: 'Read', Path: 'notes.md', StartLine: 7 }) }] },
    { type: 'USER_INPUT', step_index: 7, content: '<USER_REQUEST>Continue</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', step_index: 8, tool_calls: [tool('List')] },
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['agy'] }), home, agy })
  const messages = await catalog.messages({ engine: 'agy', remoteId, file: join(agy, 'conversation_summaries.db') })
  assert.deepEqual(messages.map(({ role, text, phase, thought, tools }) => [role, text, phase, thought, tools?.map(tool => tool.title)]), [
    ['user', 'First', undefined, undefined, undefined],
    ['assistant', 'Progress', 'commentary', undefined, undefined],
    ['assistant', 'Answer', 'commentary', undefined, ['Inspect']],
    ['assistant', '', undefined, 'First thought', ['Check', 'Verify']],
    ['user', 'Continue', undefined, undefined, undefined],
    ['assistant', '', undefined, 'Second thought', ['Read']],
    ['user', 'Continue', undefined, undefined, undefined],
    ['assistant', '', undefined, undefined, ['List']],
  ])
  const toolIds = messages.flatMap(message => (message.tools ?? []).map(tool => tool.toolCallId))
  assert.equal(new Set(toolIds).size, 5)
  assert.equal(messages[5].tools[0].kind, 'read')
  assert.deepEqual(messages[5].tools[0].locations, [{ path: 'notes.md', line: 7 }])
})

test('imports only matched Antigravity command results from the planner batch', async t => {
  const home = await testHome(t)
  const remoteId = randomUUID()
  const agy = join(home, 'agy')
  const logs = join(agy, 'brain', remoteId, '.system_generated', 'logs')
  await mkdir(logs, { recursive: true })
  const command = CommandLine => ({ name: 'run_command', args: { CommandLine, toolSummary: 'Run command' } })
  const result = (step_index, content) => ({ type: 'GENERIC', source: 'MODEL', status: 'DONE', step_index, content })
  const timings = `Created At: ${started}\nCompleted At: ${ended}\n`
  await writeFile(join(logs, 'transcript_full.jsonl'), jsonl([
    { type: 'USER_INPUT', step_index: 0, content: 'Run both' },
    { type: 'PLANNER_RESPONSE', step_index: 1, tool_calls: [command('echo first'), command('echo second')] },
    result(2, timings.repeat(2) + 'Command exited with code 0.\n\nfirst\n'),
    result(3, timings.repeat(2) + 'Command exited with code 1.\n\nsecond\n'),
    { type: 'PLANNER_RESPONSE', step_index: 4, tool_calls: [command('echo incomplete'), command('echo unknown')] },
    result(6, 'Command exited with code 0.\n\nA result with no reliable association'),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['agy'] }), home, agy })
  const [, assistant] = await catalog.messages({ engine: 'agy', remoteId, file: join(agy, 'conversation_summaries.db') })
  assert.deepEqual(assistant.tools.map(tool => tool.execution), [
    { command: 'echo first', output: 'first\n', exitCode: 0 },
    { command: 'echo second', output: 'second\n', exitCode: 1 },
    { command: 'echo incomplete' },
    { command: 'echo unknown' },
  ])
  assert.equal(assistant.tools[1].status, 'failed')
})

test('preserves interleaved Claude text and tool blocks in the same stored message', async t => {
  const home = await testHome(t)
  const file = join(home, 'claude.jsonl')
  await writeFile(file, jsonl([
    { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'Inspect files' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { content: [
      { type: 'text', text: 'I’ll inspect the file.' },
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'notes.md' } },
      { type: 'text', text: 'Done.' },
    ] } },
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['claude'] }), home })
  const messages = await catalog.messages({ engine: 'claude', file })
  assert.deepEqual(messages.map(message => [message.text, message.tools?.map(tool => tool.toolCallId)]), [
    ['Inspect files', undefined],
    ['I’ll inspect the file.', undefined],
    ['Done.', ['read']],
  ])
})

test('imports Claude file calls in a turn without assistant text', async t => {
  const home = await testHome(t)
  const file = join(home, 'claude.jsonl')
  await writeFile(file, jsonl([
    { type: 'user', uuid: 'u', parentUuid: null, message: { content: 'Inspect files' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { content: [
      { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'notes.md', offset: 5 } },
      { type: 'tool_use', id: 'write', name: 'Write', input: { file_path: 'new.txt', content: 'fixture' } },
      { type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'echo example.txt' } },
    ] } },
    { type: 'user', uuid: 'result', parentUuid: 'a', message: { content: [
      { type: 'tool_result', tool_use_id: 'bash', content: 'Exit code 7\nfixture error', is_error: true },
    ] } },
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['claude'] }), home })
  const [, assistant] = await catalog.messages({ engine: 'claude', file })
  assert.equal(assistant.text, '')
  assert.deepEqual(assistant.tools.map(({ kind, locations }) => [kind, locations]), [
    ['read', [{ path: 'notes.md', line: 5 }]],
    ['write', [{ path: 'new.txt' }]],
    ['execute', undefined],
  ])
  assert.deepEqual(assistant.tools[2].execution, { command: 'echo example.txt', output: 'fixture error', exitCode: 7 })
  assert.equal(assistant.tools[2].status, 'failed')
})

test('opens Claude task sidechains with native parent IDs and retains active-branch history', async t => {
  const home = await testHome(t)
  const claude = join(home, 'claude')
  const cwd = join(home, 'workspace')
  const [parent, teammate] = Array.from({ length: 2 }, randomUUID)
  const project = join(claude, 'projects', 'example')
  const agents = join(project, parent, 'subagents')
  const team = join(claude, 'teams', 'example')
  for (const path of [agents, team, cwd]) await mkdir(path, { recursive: true })
  await writeFile(join(team, 'config.json'), JSON.stringify({ name: 'example', leadSessionId: parent }))
  for (const id of [parent, teammate]) {
    await writeFile(join(project, id + '.jsonl'), jsonl([
      {
        type: 'user', uuid: 'u', parentUuid: null, sessionId: id, cwd, timestamp: started, message: { content: 'Question' },
        ...id === teammate ? { teamName: 'example', agentName: 'Independent teammate' } : {},
      },
      { type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: started, message: { content: [{ type: 'text', text: 'Previous branch' }] } },
      { type: 'assistant', uuid: 'b', parentUuid: 'u', timestamp: ended, message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Answer' }] } },
    ]))
  }
  for (const agentId of ['aWorker', 'aNested', 'aOther']) {
    const base = join(agents, 'agent-' + agentId)
    const metadata = { isSidechain: true, agentId, sessionId: agentId === 'aOther' ? teammate : parent }
    await writeFile(base + '.jsonl', jsonl([
      { ...metadata, type: 'user', uuid: 'u', parentUuid: null, cwd, timestamp: started, message: { content: 'Worker task' } },
      { ...metadata, type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: ended, message: { content: [{ type: 'text', text: 'Worker result' }] } },
    ]))
    await writeFile(base + '.meta.json', JSON.stringify({
      description: 'Worker name',
      finished: true,
      ...agentId === 'aNested' ? { parentAgentId: 'aWorker' } : {},
    }))
  }
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['claude'] }), home, claude })
  const entries = await catalog.list()
  assert.equal(entries.size, 4)
  const root = entries.get(nativeId('claude', parent))
  assert.deepEqual(await catalog.messages(root), [
    { role: 'user', text: 'Question' },
    { role: 'assistant', text: 'Answer', thought: 'hidden', steps: [{ kind: 'thought', text: 'hidden' }] },
  ])
  const children = await catalog.children('claude', parent)
  assert.equal(children.find(entry => entry.remoteId === teammate).title, 'Independent teammate')
  const worker = children.find(entry => entry.agentId === 'aWorker')
  assert.equal(worker.id, nativeId('claude', parent + '/aWorker'))
  assert.equal(worker.resumable, false)
  const [nested] = await catalog.children('claude', worker.remoteId)
  assert.equal(nested.parentId, worker.id)
  assert.deepEqual(await catalog.messages(nested), [{ role: 'user', text: 'Worker task' }, { role: 'assistant', text: 'Worker result' }])
  for (const entry of entries.values()) {
    assert.equal(entry.createdAt, Date.parse(started))
    assert.equal(entry.updatedAt, Date.parse(ended))
  }
})

test('loads a new engine from configured local ESM and delegates history without changing core', async t => {
  const home = await testHome(t)
  const provider = join(home, 'external-engine.mjs')
  await writeFile(provider, `
    export const engine = {
      id: 'fixture', label: 'Fixture Engine', start: ({ cwd }) => ({ id: cwd }),
      history: {
        list: ({ home }) => [{ remoteId: 'example', cwd: home, title: 'External conversation', updatedAt: '${ended}' }],
        messages: ({ remoteId }) => [{ role: 'assistant', text: remoteId }]
      }
    }
  `)
  const registry = createEngineRegistry({ engines: [], engineModules: [provider] })
  await registry.ready
  assert.deepEqual(registry.list().map(({ id, label }) => [id, label]), [['fixture', 'Fixture Engine']])
  assert.deepEqual(await registry.get('fixture').start({ cwd: home }), { id: home })
  const catalog = nativeCatalog({ registry, home })
  const entry = (await catalog.list()).get(nativeId('fixture', 'example'))
  assert.equal(entry.updatedAt, Date.parse(ended))
  assert.deepEqual(await catalog.messages(entry), [{ role: 'assistant', text: 'example' }])
  const dispose = registry.register({ id: 'another', label: 'Another', start() {} })
  assert.ok(registry.has('another'))
  dispose()
  assert.ok(!registry.has('another'))
  assert.throws(() => registry.register(registry.get('fixture')), /already registered/)
})

test('uses Claude native title metadata and skips transcripts containing only local commands', async t => {
  const home = await testHome(t)
  const claude = join(home, 'claude')
  const cwd = join(home, 'workspace')
  const project = join(claude, 'projects', 'example')
  await mkdir(project, { recursive: true })
  await mkdir(cwd)
  const [recap, named, unnamed] = Array.from({ length: 3 }, randomUUID)
  const user = (sessionId, uuid, parentUuid, content) => ({
    type: 'user', sessionId, uuid, parentUuid, cwd, timestamp: started, message: { content },
  })
  const command = '<command-name>/recap</command-name>\n<command-message>recap</command-message>'
  await writeFile(join(claude, 'history.jsonl'), jsonl([recap, named, unnamed].map(sessionId => ({ sessionId, display: '/recap' }))))
  await writeFile(join(project, recap + '.jsonl'), jsonl([
    { ...user(recap, 'caveat', null, '<local-command-caveat>Local command</local-command-caveat>'), isMeta: true },
    user(recap, 'command', 'caveat', command),
    { type: 'system', subtype: 'local_command', uuid: 'notice', parentUuid: 'command', sessionId: recap, timestamp: ended },
  ]))
  const namedFile = join(project, named + '.jsonl')
  await writeFile(namedFile, jsonl([
    user(named, 'command', null, command),
    user(named, 'actual', 'command', 'Build a native project'),
    { type: 'summary', summary: 'Older summary', sessionId: named },
    { type: 'ai-title', aiTitle: 'Generated title', sessionId: named },
    { type: 'custom-title', customTitle: 'Original native name', sessionId: named },
    { type: 'ai-title', aiTitle: 'Newer generated title', sessionId: named },
    { type: 'assistant', uuid: 'large', parentUuid: 'actual', sessionId: named, timestamp: ended, message: { content: 'x'.repeat(160 * 1024) } },
  ]))
  await writeFile(join(project, unnamed + '.jsonl'), jsonl([
    user(unnamed, 'command', null, command),
    user(unnamed, 'output', 'command', '<local-command-stdout>Command message</local-command-stdout>'),
    user(unnamed, 'actual', 'output', 'First actual request'),
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['claude'] }), home, claude })
  const rows = await catalog.list()
  assert.equal(rows.has(nativeId('claude', recap)), false)
  assert.equal(rows.get(nativeId('claude', unnamed)).title, 'First actual request')
  assert.equal(rows.get(nativeId('claude', named)).title, 'Original native name')
  await appendFile(namedFile, jsonl([{ type: 'custom-title', customTitle: 'Renamed in Claude', sessionId: named }]))
  assert.equal((await catalog.list(true)).get(nativeId('claude', named)).nativeTitle, 'Renamed in Claude')
})

test('reads AGY history from both antigravity-cli and antigravity IDE directories', async t => {
  const home = await testHome(t)
  const cliDir = join(home, '.gemini', 'antigravity-cli')
  const ideDir = join(home, '.gemini', 'antigravity')
  const cwd = join(home, 'workspace')
  await mkdir(cwd, { recursive: true })
  const [sharedId, ideOnlyId] = Array.from({ length: 2 }, randomUUID)
  const uri = JSON.stringify([pathToFileURL(cwd).href])
  for (const dir of [cliDir, ideDir]) {
    await mkdir(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'conversation_summaries.db'))
    db.exec(`CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT, created_at TEXT, last_modified_time TEXT,
      workspace_uris TEXT, step_count INTEGER, status TEXT
    )`)
    db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      sharedId, dir === cliDir ? 'CLI summary only' : 'IDE full session', started, ended, uri, 2, 'CASCADE_RUN_STATUS_IDLE'
    )
    if (dir === ideDir) {
      db.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        ideOnlyId, 'IDE only session', started, ended, uri, 2, 'CASCADE_RUN_STATUS_IDLE'
      )
    }
    db.close()
  }
  const sharedLogs = join(ideDir, 'brain', sharedId, '.system_generated', 'logs')
  await mkdir(sharedLogs, { recursive: true })
  await writeFile(join(sharedLogs, 'transcript.jsonl'), jsonl([
    { type: 'USER_INPUT', step_index: 1, content: '<USER_REQUEST>\nHello IDE\n</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', step_index: 2, content: 'Hi from IDE' },
  ]))
  const ideOnlyLogs = join(ideDir, 'brain', ideOnlyId, '.system_generated', 'logs')
  await mkdir(ideOnlyLogs, { recursive: true })
  await writeFile(join(ideOnlyLogs, 'transcript.jsonl'), jsonl([
    { type: 'USER_INPUT', step_index: 1, content: '<USER_REQUEST>\nOnly IDE\n</USER_REQUEST>' },
    { type: 'PLANNER_RESPONSE', step_index: 2, content: 'Reply' },
  ]))
  const catalog = nativeCatalog({ registry: createEngineRegistry({ engines: ['agy'] }), home })
  const rows = await catalog.list()
  assert.equal(rows.size, 2)
  const shared = rows.get(nativeId('agy', sharedId))
  assert.equal(shared.title, 'IDE full session')
  assert.deepEqual(await catalog.messages(shared), [
    { role: 'user', text: 'Hello IDE' },
    { role: 'assistant', text: 'Hi from IDE' },
  ])
  assert.equal(rows.get(nativeId('agy', ideOnlyId)).title, 'IDE only session')
})
