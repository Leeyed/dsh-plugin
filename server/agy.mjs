import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { metricCount, totalInput } from './persisted-metrics.mjs';
import { agyCommandExecution, agyCommandResult, agyToolActivity, appendExecutionText, completeExecution } from './tool-activity.mjs';

const cancelledPermission = { outcome: { outcome: 'cancelled' } };
const replayUpdates = new Set(['available_commands_update', 'config_option_update', 'session_info_update', 'usage_update']);

function unwrapUserPrompt(text) {
  if (typeof text !== 'string') return '';
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (match) return match[1].trim();
  return text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '').trim() || text;
}

function chunkText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('');
  }
  if (content?.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

function selectableValues(option) {
  if (!Array.isArray(option?.options)) return [];
  return option.options.flatMap(choice => Array.isArray(choice?.options) ? choice.options : [choice])
    .map(choice => choice?.value).filter(value => typeof value === 'string' && value);
}

function toolUpdate(update, executions) {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return update;
  const { sessionUpdate, toolCallId, title, status, kind, locations, rawInput, rawOutput, content, outputDelta } = update;
  const name = update.toolName ?? rawInput?.toolName ?? rawInput?.tool_name ?? rawInput?.name ?? title;
  const args = rawInput?.arguments ?? rawInput;
  const metadata = agyToolActivity(name, args, kind, locations);
  const isCommand = metadata.kind === 'execute' || executions.has(toolCallId);
  const previous = executions.get(toolCallId);
  let execution;
  if (isCommand) {
    const invocation = agyCommandExecution(name, args) ?? agyCommandExecution('run_command', args);
    execution = completeExecution(previous, invocation);
    execution = appendExecutionText(execution, 'output', outputDelta ?? rawOutput?.delta);
    execution = completeExecution(execution, agyCommandResult(rawOutput, content));
    if (toolCallId) {
      executions.set(toolCallId, execution);
      if (executions.size > 128) executions.delete(executions.keys().next().value);
    }
  }
  return {
    sessionUpdate, toolCallId,
    ...(title !== undefined ? { title } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(sessionUpdate === 'tool_call' || typeof kind === 'string' || metadata.kind !== 'other'
      ? { kind: isCommand ? 'execute' : metadata.kind } : {}),
    ...(metadata.locations ? { locations: metadata.locations } : {}),
    ...(execution ? { execution } : {}),
  };
}

export async function startAgy({ cwd, env, resumeId, replayHistory, appDataDirectory, emit, signal }) {
  signal?.throwIfAborted();
  const directory = resolve(cwd);
  const args = ['acp'];
  if (appDataDirectory) {
    // AGY interprets --app-data-dir relative to the selected home’s .gemini directory.
    const gemini = join(env?.HOME || homedir(), '.gemini');
    args.push('--app-data-dir', relative(gemini, appDataDirectory));
  }
  const child = spawn('agy', args, {
    cwd: directory,
    ...(env ? { env: { ...process.env, ...env } } : {}),
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  const permissions = new Map();
  const executions = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let requestId = 0;
  let sessionId;
  let options = [];
  let capabilities;
  let history;
  let historyActivity;
  let historyAfterActivity = false;
  let turn;
  let steeringEcho;

  function markHistoryActivity() {
    const last = history.at(-1);
    if (last?.role === 'assistant' && last.text) {
      last.phase = 'commentary';
      historyAfterActivity = true;
    }
  }

  function flushHistoryActivity(target) {
    if (!historyActivity) return;
    const thought = historyActivity.thought.trim();
    const tools = [...historyActivity.tools.values()];
    const steps = historyActivity.steps
      .map(step => step.kind === 'thought' ? { kind: 'thought', text: step.text.trim() } : step)
      .filter(step => step.kind !== 'thought' || step.text);
    historyActivity = { thought: '', tools: new Map(), steps: [], toolStepById: new Map() };
    historyAfterActivity = false;
    if (!target && (thought || tools.length || steps.length)) {
      target = { role: 'assistant', text: '' };
      history.push(target);
    }
    if (!target) return;
    if (thought) target.thought = target.thought ? `${target.thought}\n\n${thought}` : thought;
    if (tools.length) target.tools = [...(target.tools || []), ...tools];
    if (steps.length) target.steps = [...(target.steps || []), ...steps];
  }
  let configuration = Promise.resolve();
  let transportError;
  let closing;

  const exited = new Promise(done => child.once('close', (code, exitSignal) => {
    failTransport(new Error(`AGY ACP exited (${exitSignal ?? code})`));
    done(true);
  }));
  child.on('error', failTransport);
  child.stdin.on('error', failTransport);
  lines.on('error', failTransport);
  lines.on('line', line => {
    if (!line.trim() || transportError) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failTransport(new Error('Invalid AGY ACP message'));
      return;
    }
    try {
      receive(message);
    } catch (error) {
      failTransport(error);
    }
  });
  signal?.addEventListener('abort', abort, { once: true });

  function send(message) {
    if (transportError) throw transportError;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    } catch (error) {
      failTransport(error);
      throw error;
    }
  }

  function request(method, params, timeout = 30_000) {
    if (transportError) return Promise.reject(transportError);
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timer = timeout && setTimeout(() => {
        pending.delete(id);
        reject(new Error(`AGY ACP timed out during ${method}`));
      }, timeout).unref();
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
  }

  function receive(message) {
    const { id, method, params, result, error } = message;
    if (method === 'session/update') {
      const expectedSession = sessionId ?? resumeId;
      if (expectedSession && params.sessionId !== expectedSession) return;
      const update = toolUpdate(params.update, executions);
      if (history && !replayUpdates.has(update.sessionUpdate)) {
        historyActivity ??= { thought: '', tools: new Map(), steps: [], toolStepById: new Map() };
        if (update.sessionUpdate === 'agent_thought_chunk') {
          const text = chunkText(update.content);
          if (text) {
            markHistoryActivity();
            historyActivity.thought += text;
            const last = historyActivity.steps.at(-1);
            if (last?.kind === 'thought') last.text += text;
            else historyActivity.steps.push({ kind: 'thought', text });
          }
          return;
        }
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          const { toolCallId } = update;
          if (toolCallId) {
            const current = historyActivity.tools.get(toolCallId);
            if (!current && update.sessionUpdate === 'tool_call_update') {
              const stored = history.findLast(message => message.tools?.some(tool => tool.toolCallId === toolCallId))
                ?.tools.find(tool => tool.toolCallId === toolCallId);
              if (stored) {
                Object.assign(stored, update);
                return;
              }
            }
            markHistoryActivity();
            const nextTool = { ...current, ...update };
            historyActivity.tools.set(toolCallId, nextTool);
            const existingStep = historyActivity.toolStepById.get(toolCallId);
            if (existingStep) existingStep.tool = nextTool;
            else {
              const step = { kind: 'tool', tool: nextTool };
              historyActivity.toolStepById.set(toolCallId, step);
              historyActivity.steps.push(step);
            }
          }
          return;
        }
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user'
          : update.sessionUpdate === 'agent_message_chunk' ? 'assistant'
          : undefined;
        const text = role ? chunkText(update.content) : '';
        if (role === 'user') {
          flushHistoryActivity();
        }
        if (role && text) {
          const last = history.at(-1);
          if (last?.role === role && !(role === 'assistant' && historyAfterActivity)) {
            last.text += text;
          } else {
            const message = { role, text };
            if (role === 'assistant') flushHistoryActivity(message);
            history.push(message);
          }
        }
        return;
      }
      if (!turn && !replayUpdates.has(update.sessionUpdate) && (!sessionId || closing)) return;
      if (steeringEcho && update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text' &&
          update.content.text === steeringEcho.text) {
        const { accepted } = steeringEcho;
        steeringEcho = undefined;
        accepted();
      }
      if (update.sessionUpdate === 'config_option_update') {
        if (!Array.isArray(update.configOptions)) return;
        options = update.configOptions;
      }
      emit('update', { ...params, update });
      return;
    }
    if (method === 'session/request_permission' && id != null) {
      const key = params.toolCall.toolCallId;
      if (!turn?.sent || turn.cancelled || closing || params.sessionId !== sessionId || permissions.has(key)) {
        send({ id, result: cancelledPermission });
      } else {
        permissions.set(key, { id, options: params.options });
        emit('permission', params);
      }
      return;
    }
    if (method && id != null) {
      send({ id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    if (method || !pending.has(id)) return;
    const entry = pending.get(id);
    pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(new Error(error.message ?? 'AGY ACP request failed'));
    else entry.resolve(result);
  }

  function requireOpen() {
    if (transportError) throw transportError;
    if (closing) throw new Error('AGY ACP session is closing');
  }

  async function selectAvailable(configId, preferred) {
    const option = options.find(option => option.id === configId);
    const choices = selectableValues(option);
    const value = [preferred, option?.currentValue].find(value => choices.includes(value)) ?? choices[0];
    if (configId === 'model' && !value) throw new Error('AGY did not report any available models for this account');
    if (value && value !== option.currentValue) await configure(configId, value);
  }

  async function configure(configId, value) {
    requireOpen();
    if (turn) throw new Error('Wait for the AGY turn to finish before changing options');
    const updated = configuration.then(async () => {
      requireOpen();
      if (configId === 'model' || configId === 'thought_level') {
        const option = options.find(option => option.id === configId);
        if (!selectableValues(option).includes(value)) {
          throw Object.assign(new Error(configId === 'model'
            ? 'This AGY model is unavailable for the selected account'
            : 'This AGY thinking level is unavailable for the current model'), { status: 409 });
        }
      }
      const reply = await request('session/set_config_option', { sessionId, configId, value });
      if (!Array.isArray(reply?.configOptions)) throw new Error('AGY ACP did not return session options');
      options = reply.configOptions;
      if (!options.some(option => option.id === configId && option.currentValue === value)) {
        throw new Error(`AGY did not confirm the ${configId} setting`);
      }
      return options;
    });
    configuration = updated.catch(() => {});
    return updated;
  }

  function promptContent(text, attachments) {
    const content = text ? [{ type: 'text', text }] : [];
    for (const { type, mimeType, data } of attachments) {
      if ((type !== 'image' && type !== 'audio') || !capabilities[type]) {
        throw new Error(`AGY ACP does not support ${type} attachments`);
      }
      content.push({ type, mimeType, data });
    }
    if (!content.length) throw new Error('Enter a message or attach a file');
    return content;
  }

  async function steer(text, attachments = [], accepted) {
    requireOpen();
    if (!turn?.sent || turn.cancelled) {
      throw Object.assign(new Error('The AGY turn is no longer accepting messages'), { status: 409 });
    }
    // AGY ACP steers an active turn with a second prompt on the same session.
    steeringEcho = accepted && { text, accepted };
    try {
      const result = await request('session/prompt', { sessionId, prompt: promptContent(text, attachments) }, 0);
      if (result?.stopReason === 'cancelled') throw Object.assign(new Error('AGY cancelled the follow-up'), { status: 409 });
    } finally { steeringEcho = undefined; }
  }

  async function prompt(text, attachments = []) {
    requireOpen();
    if (turn) throw new Error('An AGY turn is already running');
    const content = promptContent(text, attachments);
    turn = { sent: false, cancelled: false };
    try {
      await configuration;
      if (turn.cancelled) return { stopReason: 'cancelled' };
      requireOpen();
      const model = options.find(option => option.id === 'model');
      if (!selectableValues(model).includes(model?.currentValue)) {
        throw Object.assign(new Error('Select an AGY model available to this account before sending a message'), { status: 409 });
      }
      turn.sent = true;
      const result = await request('session/prompt', { sessionId, prompt: content }, 0);
      const { inputTokens: uncachedInput, outputTokens, cachedReadTokens: cacheReadTokens,
        cachedWriteTokens: cacheWriteTokens, thoughtTokens: reasoningTokens } = result?.usage ?? {};
      // AGY reports cached input separately and includes thoughts in outputTokens.
      const inputTokens = totalInput(uncachedInput, cacheReadTokens ?? 0, cacheWriteTokens ?? 0);
      const counts = Object.entries({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens })
        .filter(([, count]) => metricCount(count));
      if (counts.length) emit('usage', Object.fromEntries(counts));
      return result;
    } finally {
      clearTimeout(turn.timer);
      turn = undefined;
      cancelPermissions();
    }
  }

  function approve(id, optionId) {
    requireOpen();
    const permission = permissions.get(id);
    if (!permission) throw new Error('AGY permission request has expired');
    if (!permission.options.some(option => option.optionId === optionId)) {
      throw new Error('Unknown AGY permission option');
    }
    permissions.delete(id);
    send({ id: permission.id, result: { outcome: { outcome: 'selected', optionId } } });
  }

  function cancelPermissions() {
    for (const { id } of permissions.values()) send({ id, result: cancelledPermission });
    permissions.clear();
  }

  function cancel() {
    if (!turn || turn.cancelled || transportError) return;
    turn.cancelled = true;
    if (!turn.sent) return;
    send({ method: 'session/cancel', params: { sessionId } });
    cancelPermissions();
    turn.timer = setTimeout(() => {
      failTransport(new Error('AGY ACP did not finish the cancelled turn'));
    }, 15_000).unref();
  }

  function failTransport(error) {
    if (transportError) return;
    transportError = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    permissions.clear();
    void close().catch(() => {});
  }

  function abort() {
    if (!sessionId) failTransport(signal.reason);
    else void close().catch(() => {});
  }

  function waitForExit(timeout) {
    let timer;
    const elapsed = new Promise(done => { timer = setTimeout(() => done(false), timeout).unref(); });
    return Promise.race([exited, elapsed]).finally(() => clearTimeout(timer));
  }

  function close() {
    closing ??= Promise.resolve().then(async () => {
      signal?.removeEventListener('abort', abort);
      try {
        cancel();
        if (sessionId && !transportError) {
          await request('session/close', { sessionId }, 2_000);
        }
      } catch {
        // Closing the stdio transport also releases the ACP session.
      } finally {
        child.stdin.end();
      }
      if (await waitForExit(1_000)) return;
      child.kill('SIGTERM');
      if (await waitForExit(1_000)) return;
      child.kill('SIGKILL');
      if (!await waitForExit(1_000)) throw new Error('AGY ACP did not exit');
    });
    return closing;
  }

  try {
    const initialized = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'dsh-direct-chat', version: '0.1.0' },
    });
    if (initialized?.protocolVersion !== 1) throw new Error('Unsupported AGY ACP protocol version');
    const promptCapabilities = initialized.agentCapabilities?.promptCapabilities;
    capabilities = { image: promptCapabilities?.image === true, audio: promptCapabilities?.audio === true };
    const params = { cwd: directory, mcpServers: [] };
    let session;
    let replayed;
    if (resumeId) {
      const agent = initialized.agentCapabilities;
      if (replayHistory && (agent?.loadSession === true || agent?.sessionCapabilities?.load != null)) {
        history = [];
        historyActivity = { thought: '', tools: new Map(), steps: [], toolStepById: new Map() };
        try {
          session = await request('session/load', { ...params, sessionId: resumeId }, 90_000);
          flushHistoryActivity();
          replayed = history.map(msg =>
            msg.role === 'user' ? { ...msg, text: unwrapUserPrompt(msg.text) } : msg
          ).filter(msg => msg.text.trim() || msg.thought || msg.tools?.length);
        } catch {
          signal?.throwIfAborted();
          requireOpen();
        } finally {
          history = undefined;
          historyActivity = undefined;
        }
      }
      if (!replayed) session = await request('session/resume', { ...params, sessionId: resumeId });
    } else {
      session = await request('session/new', params);
    }
    sessionId = session?.sessionId ?? resumeId;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('AGY ACP did not return a session ID');
    if (resumeId && sessionId !== resumeId) throw new Error('AGY did not reopen the requested conversation');
    if (Array.isArray(session?.configOptions)) options = session.configOptions;
    await selectAvailable('model', resumeId ? undefined : 'gemini-3.8-flash');
    await selectAvailable('thought_level', resumeId ? undefined : 'low');
    signal?.throwIfAborted();
    requireOpen();
    if (replayed) emit('history', { messages: replayed });
    return { id: sessionId, get options() { return options; }, capabilities, prompt, steer, configure, approve, cancel, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
