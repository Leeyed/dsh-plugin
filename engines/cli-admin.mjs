import { execFile } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)

export const claudeExternalAuthEnvKeys = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_FILE_DESCRIPTOR', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_USE_GATEWAY', 'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_HOST_CREDS_FILE',
  'CLAUDE_CODE_HOST_AUTH_ENV_VAR', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CCR_OAUTH_TOKEN_FILE',
]

export function parseSemver(text) {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(text || ''))
  return match ? match[1] : undefined
}

export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  const [aMain] = pa.split('-', 1)
  const [bMain] = pb.split('-', 1)
  const aParts = aMain.split('.').map(Number)
  const bParts = bMain.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

async function execCli(bin, args, { cwd = homedir(), timeout = 8_000, signal, env } = {}) {
  const safeCwd = typeof cwd === 'string' && existsSync(cwd) ? cwd : homedir()
  return execute(bin, args, {
    cwd: safeCwd,
    timeout,
    maxBuffer: 512 * 1024,
    signal,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
}

async function fetchNpmLatest(pkg, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return undefined
    const data = await res.json()
    return parseSemver(data?.version)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function codexDirectory(env) {
  const effective = { ...process.env, ...env }
  return effective.CODEX_HOME || join(effective.HOME || homedir(), '.codex')
}

function readCodexCachedLatest(env) {
  try {
    const dir = codexDirectory(env)
    const raw = readFileSync(join(dir, 'version.json'), 'utf8')
    const parsed = JSON.parse(raw)
    return parseSemver(parsed?.latest_version)
  } catch {
    return undefined
  }
}

function readCodexChatGptAccount(env) {
  try {
    const dir = codexDirectory(env)
    const raw = readFileSync(join(dir, 'auth.json'), 'utf8')
    const data = JSON.parse(raw)
    const idToken = data?.tokens?.id_token
    if (typeof idToken === 'string' && idToken.includes('.')) {
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
      const email = payload?.email || payload?.preferred_username
      if (email) return { account: data?.auth_mode ? `${email} (${data.auth_mode})` : String(email), identity: accountEmail(email) }
    }
  } catch {}
  return undefined
}

function readClaudeAccount(env) {
  try {
    const effective = { ...process.env, ...env }
    const file = join(effective.CLAUDE_CONFIG_DIR || effective.HOME || homedir(), '.claude.json')
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return data?.oauthAccount?.emailAddress || data?.oauthAccount?.organizationName || undefined
  } catch {
    return undefined
  }
}

function accountEmail(email) {
  if (typeof email === 'string' && email.length <= 254 && /^[^\s@\p{C}]+@[^\s@\p{C}]+\.[^\s@\p{C}]+$/u.test(email)) return email
}

function agyStoredAuth(data, token) {
  const expires = token?.expiry_date ?? Date.parse(token?.expiry)
  if (agyTokenField(token?.refresh_token) ||
      (agyTokenField(token?.access_token) && (!Number.isFinite(expires) || expires > Date.now()))) {
    return { authenticated: true, account: accountEmail(data?.id_token_email) || 'Google OAuth' }
  }
}

const agyTokenField = value => typeof value === 'string' && value.length > 0
const agyTokenFile = 'antigravity-oauth-token'
const agyLegacyCredentialFiles = ['oauth_creds.json', 'credentials.json']

function agyOAuthDirectory(env) {
  const effective = { ...process.env, ...env }
  return join(effective.ANTIGRAVITY_GEMINI_DIR || join(effective.HOME || homedir(), '.gemini'),
    effective.ANTIGRAVITY_APP_DATA_DIR || 'antigravity-cli')
}

function readAgyFileAuth(directory, legacy = false) {
  const files = [agyTokenFile, ...(legacy ? agyLegacyCredentialFiles : [])]
  for (const name of files) {
    try {
      const data = JSON.parse(readFileSync(join(directory, name), 'utf8'))
      const token = name === agyTokenFile ? data.token : (data.token || data)
      const auth = agyStoredAuth(data, token)
      if (auth) return auth
    } catch {}
  }
}

function readAgyOAuthEmail(home) {
  const directory = home ? join(home, '.gemini', 'antigravity-cli') : agyOAuthDirectory()
  const account = readAgyFileAuth(directory)?.account
  return accountEmail(account)
}

const agyAuthStateFile = directory => join(directory, 'cache', 'acp-auth-state.json')

function agyNativeOAuthMarker(env) {
  const file = agyAuthStateFile(agyOAuthDirectory(env))
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).methodId === 'oauth-personal') {
      const info = statSync(file, { bigint: true })
      return `${info.ino}:${info.mtimeNs}`
    }
  } catch {}
}

function agyReceiptFile() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'direct-chat', 'agy-default-oauth.json')
}

function readAgyReceipt(marker) {
  if (!marker) return
  try {
    const receipt = JSON.parse(readFileSync(agyReceiptFile(), 'utf8'))
    if (receipt.marker === marker && accountEmail(receipt.account)) return receipt
  } catch {}
}

const agyKeyringAttributes = ['service', 'gemini', 'username', 'antigravity']
const agyKeyringOptions = ['--user', '--auto-start=no', '--json=short']
const agyKeyringDestination = 'org.freedesktop.secrets'
const agyKeyringPath = /^\/org\/freedesktop\/secrets\/collection\/(?:\w+\/)+\w+$/

function agyUsesNativeKeyring(env) {
  const effective = { ...process.env, ...env }
  return process.platform === 'linux' && !effective.ANTIGRAVITY_CREDENTIAL_SCOPE && !effective.AGY_ACCOUNT && !effective.AGY_ADC_AUTH
}

async function searchAgyKeyring({ signal, env }) {
  const { stdout } = await execCli('busctl', [...agyKeyringOptions, 'call', agyKeyringDestination, '/org/freedesktop/secrets',
    'org.freedesktop.Secret.Service', 'SearchItems', 'a{ss}', '2', ...agyKeyringAttributes], { signal, env, timeout: 1_500 })
  const [unlocked, locked] = JSON.parse(stdout).data
  if (![unlocked, locked].every(items => Array.isArray(items) &&
      items.every(path => typeof path === 'string' && agyKeyringPath.test(path)))) throw new Error('Invalid AGY keyring search')
  return { unlocked, locked }
}

async function agyKeyringItem({ signal, env }) {
  if (!agyUsesNativeKeyring(env)) return
  const matches = await searchAgyKeyring({ signal, env }).catch(() => undefined)
  if (!matches?.unlocked.length) return
  const { unlocked, locked } = matches
  if (unlocked.length !== 1 || locked.length) return { unique: false }
  const [item] = unlocked
  try {
    const times = await Promise.all(['Created', 'Modified'].map(field => execCli('busctl', [...agyKeyringOptions, 'get-property',
      agyKeyringDestination, item, 'org.freedesktop.Secret.Item', field], { signal, env, timeout: 1_500 })))
    const [created, modified] = times.map(({ stdout }) => [JSON.parse(stdout).data].flat()[0])
    if (Number.isSafeInteger(created) && Number.isSafeInteger(modified)) {
      return { path: item, marker: `${item}:${created}:${modified}`, unique: true }
    }
  } catch {}
  return { unique: false }
}

async function readAgyKeyringAuth(item, signal) {
  if (!item?.unique) return
  try {
    const { stdout } = await execCli('secret-tool', ['search', ...agyKeyringAttributes], { signal, timeout: 1_500 })
    const [header, ...lines] = stdout.split(/\r?\n/)
    const suffix = item.path.slice(item.path.lastIndexOf('/'))
    if (header !== `[${suffix}]` && header !== `[${item.path}]`) return
    const secret = 'secret = '
    const data = JSON.parse(lines.find(line => line.startsWith(secret))?.slice(secret.length))
    return agyStoredAuth(data, data?.token)
  } catch {}
}

const agyLogoutError = (message, code) => Object.assign(new Error(message), { status: 409, code })
const agyNativeLogoutError = () => agyLogoutError(
  'Open AGY in a terminal and run /logout to sign out of the native login.', 'agy_native_logout_manual')

async function clearAgyNativeKeyring(signal) {
  if (!agyUsesNativeKeyring()) throw agyNativeLogoutError()
  let matches
  try {
    matches = await searchAgyKeyring({ signal })
  } catch (error) {
    signal?.throwIfAborted()
    if (/Failed to connect to bus: (?:No medium found|No such file or directory|Connection refused)|Call failed: (?:The name is not activatable|The name .+ was not provided by any .service files|Name has no owner)/i
      .test(error.stderr)) return
    throw agyNativeLogoutError()
  }
  const { unlocked, locked } = matches
  if (locked.length || unlocked.length > 1) throw agyNativeLogoutError()
  if (!unlocked.length) return
  try {
    const { stdout } = await execCli('busctl', [...agyKeyringOptions, 'call', agyKeyringDestination, unlocked[0],
      'org.freedesktop.Secret.Item', 'Delete'], { signal, timeout: 1_500 })
    if ([JSON.parse(stdout).data].flat()[0] !== '/') throw agyNativeLogoutError()
  } catch {
    signal?.throwIfAborted()
    throw agyNativeLogoutError()
  }
}

function clearAgyFileCredentials(directory, home) {
  if (home) {
    for (const folder of [home, join(home, '.gemini'), directory, join(directory, 'cache')]) {
      const stat = lstatSync(folder, { throwIfNoEntry: false })
      if (stat && !stat.isDirectory()) throw new Error('Unexpected AGY profile directory')
    }
  }
  const files = [join(directory, agyTokenFile)]
  if (!home) {
    for (const name of agyLegacyCredentialFiles) {
      const file = join(directory, name)
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        const token = data?.token || data
        if (agyTokenField(token?.access_token) || agyTokenField(token?.refresh_token)) files.push(file)
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
    }
  }
  const state = agyAuthStateFile(directory)
  try {
    if (JSON.parse(readFileSync(state, 'utf8'))?.methodId === 'oauth-personal') files.push(state)
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
  for (const file of files) rmSync(file, { force: true })
}

export const agyCliAdmin = {
  loginCommand: 'agy acp --login',
  loginSpec: { bin: 'agy', args: ['acp', '--login'], needsCode: true, multiOAuth: true },
  readOAuthAccount: readAgyOAuthEmail,
  nativeOAuthMarker: agyNativeOAuthMarker,
  async finishDefaultOAuth({ output, previousMarker, signal, env }) {
    const line = output.trimEnd().split(/\r?\n/).at(-1)
    const account = line === 'Logged in.' ? 'Google OAuth' : accountEmail(/^Logged in as (.+)\.$/.exec(line)?.[1])
    const marker = agyNativeOAuthMarker(env)
    if (!account || !marker || marker === previousMarker) return { authenticated: false }
    const fileAuth = readAgyFileAuth(agyOAuthDirectory(env))
    const item = fileAuth?.account !== account ? await agyKeyringItem({ signal, env }) : undefined
    if (item?.marker && accountEmail(account)) {
      const file = agyReceiptFile()
      writeFileSync(file + '.tmp', JSON.stringify({ marker, item: item.marker, account }), { mode: 0o600 })
      renameSync(file + '.tmp', file)
    }
    return { authenticated: true, account }
  },
  async cliInfo({ signal, env } = {}) {
    const { stdout } = await execCli('agy', ['--version'], { signal, env })
    return { version: parseSemver(stdout) }
  },
  async checkUpdate({ signal, env } = {}) {
    const { stdout } = await execCli('agy', ['--version'], { signal, env })
    return { version: parseSemver(stdout) }
  },
  async updateCli({ signal, env } = {}) {
    const { stdout, stderr } = await execCli('agy', ['update'], { signal, timeout: 120_000, env })
    const { stdout: verOut } = await execCli('agy', ['--version'], { signal, env }).catch(() => ({ stdout: '' }))
    const text = [stdout, stderr].filter(Boolean).join('\n').trim()
    return {
      version: parseSemver(verOut),
      output: text.slice(0, 1000),
      restartSuggested: /restart|重启/i.test(text),
    }
  },
  async logoutCli({ signal, env } = {}) {
    // AGY only exposes its /logout command in the interactive CLI.
    signal?.throwIfAborted()
    if (!env) await clearAgyNativeKeyring(signal)
    try {
      if (env && !env.HOME) throw new Error('Missing AGY profile directory')
      const directory = env ? join(env.HOME, '.gemini', 'antigravity-cli') : agyOAuthDirectory()
      clearAgyFileCredentials(directory, env?.HOME)
      if (!env) rmSync(agyReceiptFile(), { force: true })
    } catch {
      throw agyLogoutError('AGY could not clear the selected profile’s local credentials.', 'agy_logout_storage')
    }
    if ((await agyCliAdmin.authStatus({ signal, env })).authenticated) {
      throw agyLogoutError('AGY still reports this account as signed in.', 'agy_logout_storage')
    }
    return { authenticated: false }
  },
  async authStatus({ signal, env } = {}) {
    if (!env) {
      const receipt = readAgyReceipt(agyNativeOAuthMarker())
      const item = await agyKeyringItem({ signal })
      if (item) {
        if (receipt && receipt.item === item.marker) return { authenticated: true, account: receipt.account }
        return await readAgyKeyringAuth(item, signal) || { authenticated: true, account: 'Google OAuth' }
      }
    }
    return readAgyFileAuth(agyOAuthDirectory(env), !env) || { authenticated: false }
  },
}

function parseTomlSections(raw) {
  const sections = new Map([['',{}]])
  let current = ''
  for (const rawLine of String(raw || '').split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const sec = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line)
    if (sec) {
      current = sec[1].trim()
      if (!sections.has(current)) sections.set(current, {})
      continue
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line)
    if (!kv) continue
    let val = kv[2].trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    sections.get(current)[kv[1]] = val
  }
  return sections
}

export function readCodexConfigProfiles(env) {
  try {
    const dir = codexDirectory(env)
    const raw = readFileSync(join(dir, 'config.toml'), 'utf8')
    const sections = parseTomlSections(raw)
    const profiles = []
    const providers = new Map()
    for (const [secName, fields] of sections.entries()) {
      if (secName.startsWith('model_providers.')) {
        const name = secName.slice('model_providers.'.length)
        providers.set(name, {
          name,
          baseUrl: fields.base_url || '',
          envKey: fields.env_key || '',
          hasInlineKey: Boolean(fields.experimental_bearer_token || fields.api_key),
        })
      } else if (secName.startsWith('profiles.')) {
        const name = secName.slice('profiles.'.length)
        profiles.push({ name, fields })
      }
    }
    return [
      ...profiles.map(({ name, fields }) => {
        const prov = fields.model_provider ? providers.get(fields.model_provider) : undefined
        return {
          id: `config:${name}`,
          name,
          kind: 'config',
          configProfile: name,
          modelProvider: fields.model_provider || undefined,
          envKey: prov?.envKey || '',
          defaultBaseUrl: prov?.baseUrl || '',
          hasInlineKey: Boolean(prov?.hasInlineKey || fields.experimental_bearer_token || fields.api_key),
        }
      }),
      ...[...providers.values()].map(prov => ({
        id: `provider:${prov.name}`,
        name: `${prov.name} (Provider)`,
        kind: 'config',
        modelProvider: prov.name,
        envKey: prov.envKey,
        defaultBaseUrl: prov.baseUrl,
        hasInlineKey: prov.hasInlineKey,
      })),
    ]
  } catch {
    return []
  }
}

export const codexCliAdmin = {
  loginCommand: 'codex login',
  loginSpec: { bin: 'codex', args: ['login'], needsCode: false, multiOAuth: true },
  configProfiles: readCodexConfigProfiles,
  defaultModelProvider(env, profileName) {
    const directory = codexDirectory(env)
    try {
      const sections=parseTomlSections(readFileSync(join(directory,'config.toml'),'utf8'))
      const root=sections.get('')
      const selected=profileName || root.profile
      return (selected && sections.get(`profiles.${selected}`)?.model_provider) || root.model_provider || 'openai'
    } catch { return 'openai' }
  },
  async cliInfo({ signal, env } = {}) {
    const { stdout } = await execCli('codex', ['--version'], { signal, env })
    return { version: parseSemver(stdout), latestVersion: readCodexCachedLatest(env) }
  },
  async checkUpdate({ signal, remote = false, env } = {}) {
    const { stdout } = await execCli('codex', ['--version'], { signal, env })
    const version = parseSemver(stdout)
    const latestVersion = remote
      ? (await fetchNpmLatest('@openai/codex', signal)) ?? readCodexCachedLatest(env)
      : readCodexCachedLatest(env) ?? (await fetchNpmLatest('@openai/codex', signal))
    return { version, latestVersion }
  },
  async updateCli({ signal, env } = {}) {
    const { stdout, stderr } = await execCli('codex', ['update'], { signal, timeout: 120_000, env })
    const { stdout: verOut } = await execCli('codex', ['--version'], { signal, env }).catch(() => ({ stdout: '' }))
    return {
      version: parseSemver(verOut),
      output: [stdout, stderr].filter(Boolean).join('\n').trim().slice(0, 1000),
    }
  },
  async logoutCli({ signal, env } = {}) {
    await execCli('codex', ['logout'], { signal, env })
    return { authenticated: false }
  },
  async authStatus({ signal, env } = {}) {
    const apiKey = env?.OPENAI_API_KEY
    if (typeof apiKey === 'string' && apiKey.trim()) {
      return { authenticated: true, account: 'API Key', label: 'OPENAI_API_KEY' }
    }
    try {
      const { stdout, stderr } = await execCli('codex', ['login', 'status'], { signal, env })
      const lines = [stdout, stderr].flatMap(output => output.split(/\r?\n/)).map(line => line.trim())
      if (lines.some(line => /^(?:API key configured|Logged in using an? API key)(?:\s+-\s+.*)?$/i.test(line))) {
        return { authenticated: true, account: 'API Key', label: 'API key configured' }
      }
      const label = lines.find(line => /^Logged in(?: using .+)?$/i.test(line))
      if (label) {
        const chatgpt = /^Logged in using ChatGPT$/i.test(label) ? readCodexChatGptAccount(env) : undefined
        return { authenticated: true, account: chatgpt?.account || label.slice(0, 120), label: label.slice(0, 120),
          ...(chatgpt?.identity ? { identity: chatgpt.identity } : {}) }
      }
    } catch {
      return { authenticated: false }
    }
    return { authenticated: false }
  },
}

export const claudeCliAdmin = {
  loginCommand: 'claude auth login',
  loginSpec: { bin: 'claude', args: ['auth', 'login'], needsCode: true, multiOAuth: true },
  async cliInfo({ signal, env } = {}) {
    const { stdout } = await execCli('claude', ['--version'], { signal, env })
    return { version: parseSemver(stdout) }
  },
  async checkUpdate({ signal, env } = {}) {
    const { stdout } = await execCli('claude', ['--version'], { signal, env })
    const version = parseSemver(stdout)
    const latestVersion = await fetchNpmLatest('@anthropic-ai/claude-code', signal)
    return { version, latestVersion }
  },
  async updateCli({ signal, env } = {}) {
    const { stdout, stderr } = await execCli('claude', ['update'], { signal, timeout: 120_000, env })
    const { stdout: verOut } = await execCli('claude', ['--version'], { signal, env }).catch(() => ({ stdout: '' }))
    return {
      version: parseSemver(verOut),
      output: [stdout, stderr].filter(Boolean).join('\n').trim().slice(0, 1000),
    }
  },
  async logoutCli({ signal, env } = {}) {
    await execCli('claude', ['auth', 'logout'], { signal, env })
    return { authenticated: false }
  },
  async authStatus({ signal, env } = {}) {
    const apiKey = env?.ANTHROPIC_API_KEY || env?.ANTHROPIC_AUTH_TOKEN
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const host = env?.ANTHROPIC_BASE_URL ? ` (${env.ANTHROPIC_BASE_URL})` : ''
      return { authenticated: true, account: `API Key${host}`, label: env?.ANTHROPIC_BASE_URL || 'API Key' }
    }
    try {
      const args = ['auth', 'status']
      // On Linux, the native CLI can exit before flushing JSON to Node's
      // stdout socket. Command substitution puts a pipe on the CLI's stdout.
      const { stdout } = process.platform === 'linux'
        ? await execCli('/bin/sh', ['-c', 'output=$("$@"); status=$?; printf "%s\\n" "$output"; exit "$status"', 'sh', 'claude', ...args], { signal, env })
        : await execCli('claude', args, { signal, env })
      const status = JSON.parse(stdout)
      if ((status?.loggedIn ?? status?.authenticated) !== true) return { authenticated: false }
      const fallbackEmail = status.authMethod === 'claude.ai' ? readClaudeAccount(env) : undefined
      const method = status.authMethod === 'api_key' ? 'API Key' : [status.authMethod, status.apiProvider].filter(Boolean).join(' · ')
      const identity = status.authMethod !== 'api_key' && accountEmail(status.email || fallbackEmail)
      return { authenticated: true, account: status.email || fallbackEmail || method || 'Signed in', label: status.email || status.authMethod,
        ...(identity ? { identity } : {}) }
    } catch {
      return { authenticated: false }
    }
  },
}
