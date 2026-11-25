import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, test } from 'node:test';
import { startAgy } from '../server/agy.mjs';

const mock = String.raw`#!/usr/bin/env node
const assert = require('node:assert/strict');
const { createReadStream, existsSync, writeSync } = require('node:fs');
const { createInterface } = require('node:readline');
assert.deepEqual(process.argv.slice(2), ['acp']);

let sessionId;
let promptId;
let cancelled;
let promptText;
let delayedSteerId;
let deferredSteer;
const values = { model: 'gemini-4-neon', thought_level: 'high', mode: existsSync('agy-plan-mode') ? 'plan' : 'default' };
const profile = process.env.DSH_TEST_AGY_PROFILE;
const forkMode = process.env.DSH_TEST_AGY_FORK;
let models = profile === 'limited' ? ['gemini-4-neon']
  : profile === 'flash-only' ? ['gemini-3.8-flash'] : ['gemini-4-neon', 'gemini-3.8-flash'];
const modes = ['default', 'plan'];
const choices = configId => {
  if (configId === 'model') return models;
  if (configId === 'mode') return modes;
  return values.model === 'gemini-4-neon' ? ['high', 'xhigh'] : ['low', 'medium', 'high'];
};
const configOptions = () => Object.entries(values).map(([id, currentValue]) => {
  const options = choices(id).map(value => ({ value, name: value }));
  return { id, name: id, type: 'select', currentValue,
    options: profile === 'flash-only' && id === 'model' ? [{ name: 'Models', options }] : options,
  };
});
// Use the file descriptors directly when the sandbox prevents socket type inspection.
const send = message => writeSync(1, JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = data => send({ method: 'session/update', params: { sessionId, update: data } });
const finish = () => {
  if (!cancelled) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
  const usage = promptText === '/swarm worker task'
    ? { totalTokens: 85, inputTokens: 61, outputTokens: 11, cachedReadTokens: 13, cachedWriteTokens: 0, thoughtTokens: 3 }
    : undefined;
  send({ id: promptId, result: { stopReason: cancelled ? 'cancelled' : 'end_turn', usage } });
  promptId = undefined;
};

createInterface({ input: createReadStream(null, { fd: 0 }) }).on('line', line => {
  const { id, method, params, result } = JSON.parse(line);
  if (id === 'permission-rpc') {
    assert.deepEqual(result, cancelled
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    if (deferredSteer) {
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: deferredSteer.text } });
      send({ id: deferredSteer.id, result: { stopReason: 'end_turn' } });
      deferredSteer = undefined;
    }
    finish();
    return;
  }
  switch (method) {
    case 'initialize':
      assert.equal(params.protocolVersion, 1);
      send({ id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true },
          ...(forkMode ? { sessionCapabilities: { fork: {} } } : {}),
        },
      } });
      break;
    case 'session/new':
      assert.deepEqual(params, { cwd: process.cwd(), mcpServers: [] });
      sessionId = 'new-session';
      send({ id, result: { sessionId, configOptions: configOptions() } });
      break;
    case 'session/fork':
      assert.ok(forkMode, 'Unadvertised fork was requested');
      assert.deepEqual(params, { sessionId: 'existing-session', cwd: process.cwd(), mcpServers: [] });
      if (forkMode === 'unavailable') {
        send({ id, error: { code: -32601, message: 'Method not found' } });
        break;
      }
      sessionId = params.sessionId;
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'source-only' }] });
      if (forkMode === 'same-id') {
        send({ id, result: { sessionId, configOptions: configOptions() } });
        break;
      }
      sessionId = 'forked-session';
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Do not duplicate copied history' } });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'fork-command' }] });
      send({ id, result: { sessionId, configOptions: configOptions() } });
      break;
    case 'session/load': {
      assert.deepEqual(params, { sessionId: params.sessionId, cwd: process.cwd(), mcpServers: [] });
      sessionId = params.sessionId;
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Old question' } });
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Old thought' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Old ' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'old-read', title: 'read_file', kind: 'read', status: 'in_progress',
        locations: [{ uri: 'file:///workspace/README.md', line: 3 }] });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'old-read', status: 'completed', kind: null, locations: null });
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'swarm', description: 'Start a swarm' }] });
      if (sessionId === 'existing-session') update({ sessionUpdate: 'usage_update', used: 80, size: 1024 });
      if (sessionId === 'load-fails') send({ id, error: { code: -32601, message: 'Session load unavailable' } });
      else send({ id, result: { configOptions: configOptions() } });
      break;
    }
    case 'session/resume':
      assert.ok(['existing-session', 'load-fails'].includes(params.sessionId));
      assert.deepEqual(params, { sessionId: params.sessionId, cwd: process.cwd(), mcpServers: [] });
      sessionId = params.sessionId;
      if (profile === 'limited') values.model = 'gemini-3.8-flash';
      values.thought_level = 'xhigh';
      values.mode = 'plan';
      send({ id, result: { configOptions: configOptions() } });
      break;
    case 'session/set_config_option': {
      const { configId, value } = params;
      assert.equal(params.sessionId, sessionId);
      assert.ok(choices(configId).includes(value));
      values[configId] = value;
      if (configId === 'model') values.thought_level = value === 'gemini-4-neon' ? 'high' : 'medium';
      send({ id, result: { configOptions: configOptions() } });
      update({ sessionUpdate: 'config_option_update', configOptions: configOptions() });
      break;
    }
    case 'session/prompt':
      assert.equal(params.sessionId, sessionId);
      if (promptId !== undefined) {
        const text = params.prompt[0]?.text;
        if (text === 'queued follow-up') {
          if (delayedSteerId === undefined) {
            delayedSteerId = id;
            update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<USER_REQUEST>\nqueued ' } });
            update({ sessionUpdate: 'user_message_chunk', content: { type: 'text',
              text: 'follow-up\n</USER_REQUEST>\n<ADDITIONAL_METADATA>fixture</ADDITIONAL_METADATA>' } });
          } else {
            deferredSteer = { id, text };
            send({ id: delayedSteerId, result: { stopReason: 'cancelled' } });
            update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'waiting for permission' } });
          }
          break;
        }
        if (text === 'rejected follow-up') {
          send({ id, error: { code: -32603, message: 'could not accept follow-up' } });
          break;
        }
        if (text === 'acknowledged without echo') {
          send({ id, result: { stopReason: 'end_turn' } });
          break;
        }
        if (text === 'permission with delayed initial echo') {
          deferredSteer = { id, text };
          update({ sessionUpdate: 'user_message_chunk', content: params.prompt[0] });
          update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'initial echo received' } });
          break;
        }
        assert.deepEqual(params.prompt, [{ type: 'text', text: 'follow up' }]);
        update({ sessionUpdate: 'user_message_chunk', content: params.prompt[0] });
        send({ id, result: { stopReason: 'end_turn' } });
        break;
      }
      assert.ok(params.prompt.length > 0);
      assert.ok(models.includes(values.model));
      promptId = id;
      promptText = params.prompt[0].text;
      cancelled = false;
      if (promptText !== 'permission with delayed initial echo') {
        for (const content of params.prompt) update({ sessionUpdate: 'user_message_chunk', content });
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
      }
      if (promptText === 'remove the active model') {
        models = ['gemini-3.8-flash'];
        update({ sessionUpdate: 'config_option_update', configOptions: configOptions() });
      }
      if (promptText === 'file activity') update({ sessionUpdate: 'tool_call', toolCallId: 'new-write', title: 'Write fixture',
        kind: 'edit', status: 'completed', toolName: 'write_file', rawInput: { Path: 'notes.md', Content: 'Fixture content' } });
      if (promptText === 'command output') {
        update({ sessionUpdate: 'tool_call', toolCallId: 'command', title: 'Run fixture', toolName: 'run_command',
          status: 'in_progress', rawInput: { CommandLine: 'echo fixture', Env: { FIXTURE: 'private runtime data' } } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'command', rawOutput: { delta: 'first\n' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'command', rawOutput: { delta: 'second\n' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'command', status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'Command exited with code 0.\n\nfirst\nsecond\n' } }] });
      }
      if (!['permission', 'permission with delayed initial echo'].includes(promptText)) {
        finish();
        break;
      }
      send({ id: 'permission-rpc', method: 'session/request_permission', params: {
        sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Edit temporary file', kind: 'edit' },
        options: [
          { optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject-once', kind: 'reject_once', name: 'Reject once' },
        ],
      } });
      break;
    case 'session/cancel':
      assert.equal(params.sessionId, sessionId);
      assert.equal(id, undefined);
      cancelled = true;
      break;
    case 'session/close':
      assert.equal(params.sessionId, sessionId);
      send({ id, result: {} });
      break;
    default:
      assert.fail('Unexpected ACP message ' + method);
  }
});
`;

let cwd;
const originalPath = process.env.PATH;

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'dsh-direct-chat-agy-'));
  await writeFile(join(cwd, 'agy'), mock, { mode: 0o700 });
  process.env.PATH = `${cwd}${delimiter}${originalPath}`;
});

after(async () => {
  process.env.PATH = originalPath;
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function selected(options) {
  return Object.fromEntries(options.map(option => [option.id, option.currentValue]));
}

test('new sessions use Flash Low and publish dependent options in configuration order', { timeout: 5_000 }, async t => {
  const updates = [];
  const session = await startAgy({ cwd, signal: t.signal, emit: (_, params) => updates.push(params) });
  t.after(() => session.close());
  assert.equal(session.id, 'new-session');
  assert.deepEqual(selected(session.options), { model: 'gemini-3.8-flash', thought_level: 'low', mode: 'default' });

  const model = session.configure('model', 'gemini-4-neon');
  const effort = session.configure('thought_level', 'xhigh');
  const mode = session.configure('mode', 'plan');
  const turn = session.prompt('stream');
  const [modelOptions, effortOptions, finalOptions, result] = await Promise.all([model, effort, mode, turn]);
  assert.equal(selected(modelOptions).thought_level, 'high');
  assert.equal(selected(effortOptions).thought_level, 'xhigh');
  assert.deepEqual(selected(finalOptions), { model: 'gemini-4-neon', thought_level: 'xhigh', mode: 'plan' });
  assert.deepEqual(session.options, finalOptions);
  assert.equal(result.stopReason, 'end_turn');
  assert.ok(updates.some(params => params.update.sessionUpdate === 'config_option_update'));
});

test('new sessions preserve the permission mode returned by AGY ACP', { timeout: 5_000 }, async t => {
  const directory = join(cwd, 'effective-permissions');
  await mkdir(directory);
  await writeFile(join(directory, 'agy-plan-mode'), '');
  const updates = [];
  const session = await startAgy({ cwd: directory, signal: t.signal, emit: (_, params) => updates.push(params.update) });
  t.after(() => session.close());
  assert.deepEqual(selected(session.options), { model: 'gemini-3.8-flash', thought_level: 'low', mode: 'plan' });
  assert.ok(updates.every(update => !update?.configOptions || selected(update.configOptions).mode === 'plan'));
});

test('resume uses the existing session with its returned settings', { timeout: 5_000 }, async t => {
  const session = await startAgy({ cwd, resumeId: 'existing-session', signal: t.signal, emit() {} });
  t.after(() => session.close());
  assert.equal(session.id, 'existing-session');
  assert.deepEqual(selected(session.options), { model: 'gemini-4-neon', thought_level: 'xhigh', mode: 'plan' });
  assert.equal((await session.prompt('stream')).stopReason, 'end_turn');
});

test('fork uses the advertised ACP method and keeps updates scoped to the independent session', { timeout: 5_000 }, async t => {
  const events = [];
  const session = await startAgy({ cwd, forkFrom: 'existing-session', env: { DSH_TEST_AGY_FORK: 'supported' },
    signal: t.signal, emit: (type, data) => events.push([type, data]) });
  t.after(() => session.close());
  assert.equal(session.id, 'forked-session');
  assert.equal(session.capabilities.fork, true);
  assert.deepEqual(selected(session.options), { model: 'gemini-4-neon', thought_level: 'high', mode: 'default' });
  assert.deepEqual(events, [['update', { sessionId: 'forked-session',
    update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'fork-command' }] },
  }]]);
  assert.equal((await session.prompt('stream')).stopReason, 'end_turn');
  assert.ok(events.every(([, data]) => data.sessionId === 'forked-session'));
});

test('fork rejects unadvertised, unimplemented, and non-independent ACP responses', { timeout: 5_000 }, async t => {
  const options = { cwd, forkFrom: 'existing-session', signal: t.signal, emit: () => assert.fail('Unexpected fork update') };
  await assert.rejects(startAgy(options), { status: 409, code: 'AGY_FORK_UNAVAILABLE' });
  await assert.rejects(startAgy({ ...options, env: { DSH_TEST_AGY_FORK: 'unavailable' } }), { status: 409, code: 'AGY_FORK_UNAVAILABLE' });
  await assert.rejects(startAgy({ ...options, env: { DSH_TEST_AGY_FORK: 'same-id' } }), /independent session/);
});

test('new sessions use the selected account catalog when Flash Low is unavailable', { timeout: 5_000 }, async t => {
  const session = await startAgy({ cwd, env: { DSH_TEST_AGY_PROFILE: 'limited' }, signal: t.signal, emit() {} });
  t.after(() => session.close());
  assert.deepEqual(selected(session.options), { model: 'gemini-4-neon', thought_level: 'high', mode: 'default' });
  assert.deepEqual(session.options.find(option => option.id === 'model').options.map(choice => choice.value), ['gemini-4-neon']);
});

test('resuming chooses an offered model if the native session still names an unavailable one', { timeout: 5_000 }, async t => {
  const session = await startAgy({ cwd, resumeId: 'existing-session', env: { DSH_TEST_AGY_PROFILE: 'limited' }, signal: t.signal, emit() {} });
  t.after(() => session.close());
  assert.equal(session.id, 'existing-session');
  assert.deepEqual(selected(session.options), { model: 'gemini-4-neon', thought_level: 'high', mode: 'plan' });
});

test('validates model choices and thinking levels against the selected account catalog', { timeout: 5_000 }, async t => {
  const session = await startAgy({ cwd, resumeId: 'existing-session', env: { DSH_TEST_AGY_PROFILE: 'flash-only' },
    signal: t.signal, emit() {} });
  t.after(() => session.close());
  assert.equal(selected(session.options).model, 'gemini-3.8-flash');
  assert.deepEqual(session.options.find(option => option.id === 'model').options, [
    { name: 'Models', options: [{ value: 'gemini-3.8-flash', name: 'gemini-3.8-flash' }] },
  ]);
  await assert.rejects(session.configure('model', 'gemini-4-neon'), { status: 409, message: /available.*account/i });
  await assert.rejects(session.configure('thought_level', 'xhigh'), { status: 409, message: /available.*model/i });
  assert.equal((await session.prompt('stream')).stopReason, 'end_turn');
});

test('rechecks the active model after a live catalog change', { timeout: 5_000 }, async t => {
  const session = await startAgy({ cwd, signal: t.signal, emit() {} });
  t.after(() => session.close());
  await session.configure('model', 'gemini-4-neon');
  await session.prompt('remove the active model');
  assert.deepEqual(session.options.find(option => option.id === 'model').options.map(choice => choice.value), ['gemini-3.8-flash']);
  await assert.rejects(session.prompt('stream'), { status: 409, message: /available.*account/i });
  await session.configure('model', 'gemini-3.8-flash');
  assert.equal((await session.prompt('stream')).stopReason, 'end_turn');
});

test('loads transcript chunks separately from live updates and forwards native slash prompts and per-turn usage', { timeout: 5_000 }, async t => {
  const events = [];
  const session = await startAgy({ cwd, resumeId: 'existing-session', replayHistory: true, signal: t.signal,
    emit: (type, data) => events.push([type, data]),
  });
  t.after(() => session.close());
  assert.deepEqual(events, [
    ['update', { sessionId: 'existing-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'swarm', description: 'Start a swarm' }] } }],
    ['update', { sessionId: 'existing-session', update: { sessionUpdate: 'usage_update', used: 80, size: 1024 } }],
    ['history', { messages: [{ role: 'user', text: 'Old question' }, {
      role: 'assistant', phase: 'commentary', text: 'Old answer', thought: 'Old thought',
      steps: [{ kind: 'thought', text: 'Old thought' }],
    }, {
      role: 'assistant', text: '', tools: [{
        sessionUpdate: 'tool_call_update', toolCallId: 'old-read', title: 'read_file', kind: 'read', status: 'completed',
        locations: [{ path: 'file:///workspace/README.md', line: 3 }],
      }], steps: [
        { kind: 'tool', tool: {
          sessionUpdate: 'tool_call_update', toolCallId: 'old-read', title: 'read_file', kind: 'read', status: 'completed',
          locations: [{ path: 'file:///workspace/README.md', line: 3 }],
        } },
      ],
    }] }],
  ]);
  events.length = 0;
  const text = '/swarm worker task';
  for (let turn = 0; turn < 2; turn++) assert.equal((await session.prompt(text)).stopReason, 'end_turn');
  assert.deepEqual(events.filter(([type]) => type === 'usage').map(([, data]) => data), [
    { inputTokens: 74, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 0, reasoningTokens: 3 },
    { inputTokens: 74, outputTokens: 11, cacheReadTokens: 13, cacheWriteTokens: 0, reasoningTokens: 3 },
  ]);
  const received = events.filter(([, data]) => data.update?.sessionUpdate === 'user_message_chunk');
  assert.deepEqual(received.map(([, data]) => data.update.content.text), [text, text]);
  assert.equal((await session.prompt('file activity')).stopReason, 'end_turn');
  const tool = events.map(([, data]) => data.update).find(update => update?.toolCallId === 'new-write');
  assert.equal(tool.kind, 'write');
  assert.deepEqual(tool.locations, [{ path: 'notes.md' }]);
});

test('streams Antigravity command snapshots and accepts an explicit zero exit code', { timeout: 5_000 }, async t => {
  const updates = [];
  const session = await startAgy({ cwd, signal: t.signal, emit: (_type, { update }) => {
    if (update?.toolCallId === 'command') updates.push(update);
  } });
  t.after(() => session.close());
  await session.prompt('command output');
  assert.deepEqual(updates.map(update => update.execution), [
    { command: 'echo fixture' },
    { command: 'echo fixture', output: 'first\n' },
    { command: 'echo fixture', output: 'first\nsecond\n' },
    { command: 'echo fixture', output: 'first\nsecond\n', exitCode: 0 },
  ]);
  assert.equal(JSON.stringify(updates).includes('private runtime data'), false);
});

test('a failed ACP history load discards its partial transcript and resumes the original session', { timeout: 5_000 }, async t => {
  const events = [];
  const session = await startAgy({ cwd, resumeId: 'load-fails', replayHistory: true, signal: t.signal,
    emit: (type, data) => events.push([type, data]),
  });
  t.after(() => session.close());
  assert.equal(session.id, 'load-fails');
  assert.equal(selected(session.options).mode, 'plan');
  assert.equal(events.some(([type, data]) => type === 'history' || data.update?.content), false);
  assert.equal((await session.prompt('stream')).stopReason, 'end_turn');
});

test('uses the negotiated attachment capabilities for mixed and image-only prompts', { timeout: 5_000 }, async t => {
  const received = [];
  const session = await startAgy({ cwd, signal: t.signal, emit(type, params) {
    if (type === 'update' && params.update.sessionUpdate === 'user_message_chunk') received.push(params.update.content);
  } });
  t.after(() => session.close());
  assert.deepEqual(session.capabilities, { image: true, audio: false });
  const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' };
  assert.equal((await session.prompt('Describe this', [image])).stopReason, 'end_turn');
  assert.deepEqual(received.splice(0), [{ type: 'text', text: 'Describe this' }, image]);
  assert.equal((await session.prompt('', [image])).stopReason, 'end_turn');
  assert.deepEqual(received.splice(0), [image]);
  await assert.rejects(session.prompt('', [{ type: 'audio', mimeType: 'audio/wav', data: 'YXVkaW8=' }]), /AGY ACP does not support audio attachments/);
  assert.deepEqual(received, []);
});

test('streams ACP updates and resolves permissions with the chosen option', { timeout: 5_000 }, async t => {
  const permission = Promise.withResolvers();
  const updates = [];
  const session = await startAgy({ cwd, signal: t.signal, emit(type, params) {
    if (type === 'permission') permission.resolve(params);
    else updates.push(params);
  } });
  t.after(() => session.close());
  const turn = session.prompt('permission');
  const params = await Promise.race([permission.promise, turn.then(() => assert.fail('Expected a permission request'))]);
  assert.equal(params.sessionId, session.id);
  assert.equal(params.toolCall.toolCallId, 'tool-1');
  let accepted = 0;
  await session.steer('follow up', [], () => { accepted++ });
  assert.equal(accepted, 1);
  await assert.rejects(session.prompt('another turn'), /already running/);
  assert.throws(() => session.approve('tool-1', 'unoffered'), /Unknown AGY permission option/);
  const allow = params.options.find(option => option.kind === 'allow_once');
  session.approve(params.toolCall.toolCallId, allow.optionId);
  assert.equal((await turn).stopReason, 'end_turn');
  assert.deepEqual(updates.slice(-3).map(params => params.update), [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'follow up' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'answer' } },
  ]);
});

test('steering finishes on its echoed input while native prompt responses are pending', { timeout: 5_000 }, async t => {
  const permission = Promise.withResolvers();
  const previousReply = Promise.withResolvers();
  const session = await startAgy({ cwd, signal: t.signal, emit(type, params) {
    if (type === 'permission') permission.resolve(params);
    if (params.update?.content?.text === 'waiting for permission') previousReply.resolve();
  } });
  t.after(() => session.close());
  const turn = session.prompt('permission');
  const params = await permission.promise;
  let accepted = 0;
  await session.steer('queued follow-up', [], () => { accepted++; });
  assert.equal(accepted, 1);

  const repeated = session.steer('queued follow-up', [], () => { accepted++; });
  await previousReply.promise;
  assert.equal(accepted, 1);
  session.approve(params.toolCall.toolCallId, 'allow-once');
  await repeated;
  assert.equal(accepted, 2);
  assert.equal((await turn).stopReason, 'end_turn');
});

test('steering propagates a request rejection and accepts a successful response without an echo', { timeout: 5_000 }, async t => {
  const permission = Promise.withResolvers();
  const session = await startAgy({ cwd, signal: t.signal, emit(type, params) {
    if (type === 'permission') permission.resolve(params);
  } });
  t.after(() => session.close());
  const turn = session.prompt('permission');
  const params = await permission.promise;
  let accepted = 0;
  const accept = () => { accepted++; };
  await assert.rejects(session.steer('rejected follow-up', [], accept), /could not accept follow-up/);
  assert.equal(accepted, 0);
  await session.steer('acknowledged without echo', [], accept);
  assert.equal(accepted, 0);
  session.approve(params.toolCall.toolCallId, 'allow-once');
  assert.equal((await turn).stopReason, 'end_turn');
});

test('a late initial prompt echo cannot acknowledge an identical steering request', { timeout: 5_000 }, async t => {
  const permission = Promise.withResolvers();
  const initialEcho = Promise.withResolvers();
  const session = await startAgy({ cwd, signal: t.signal, emit(type, params) {
    if (type === 'permission') permission.resolve(params);
    if (params.update?.content?.text === 'initial echo received') initialEcho.resolve();
  } });
  t.after(() => session.close());
  const text = 'permission with delayed initial echo';
  const turn = session.prompt(text);
  const params = await permission.promise;
  let accepted = false;
  const steer = session.steer(text, [], () => { accepted = true; });
  await initialEcho.promise;
  assert.equal(accepted, false);
  session.approve(params.toolCall.toolCallId, 'allow-once');
  await steer;
  assert.equal(accepted, true);
  assert.equal((await turn).stopReason, 'end_turn');
});

test('cancels outstanding approvals and keeps the ACP session usable', { timeout: 5_000 }, async t => {
  const permission = Promise.withResolvers();
  const session = await startAgy({ cwd, signal: t.signal, emit(type, params) {
    if (type === 'permission') permission.resolve(params);
  } });
  t.after(() => session.close());
  const turn = session.prompt('permission');
  await Promise.race([permission.promise, turn.then(() => assert.fail('Expected a permission request'))]);
  session.cancel();
  assert.equal((await turn).stopReason, 'cancelled');
  assert.throws(() => session.approve('tool-1', 'allow-once'), /permission request has expired/);
  assert.equal((await session.prompt('stream')).stopReason, 'end_turn');
});
