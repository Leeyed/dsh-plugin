import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { claudeCliAdmin, codexCliAdmin, resolveCliCommand } from '../engines/cli-admin.mjs'

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'direct-chat-cli-auth-'))
  const env = {
    HOME: join(directory, 'home'),
    DSH_HOME: directory,
    PATH: `${directory}:${process.env.PATH}`,
    CODEX_HOME: undefined,
    CLAUDE_CONFIG_DIR: undefined,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    OPENAI_API_KEY: undefined,
  }
  await mkdir(env.HOME)
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, env }
}

test('Codex status recognizes a configured API key without returning its masked value', async t => {
  const { directory, env } = await fixture(t)
  await writeFile(join(directory, 'codex'), `#!/bin/sh
echo 'WARNING: test diagnostic' >&2
echo 'API key configured - fixture-***value' >&2
echo 'Authentication is checked when you send a request.' >&2
`, { mode: 0o700 })
  assert.deepEqual(await codexCliAdmin.authStatus({ env }), {
    authenticated: true, account: 'API Key', label: 'API key configured',
  })
})

test('Codex status exposes the ChatGPT email as the verified account identity', async t => {
  const { directory, env } = await fixture(t)
  const codexHome = join(env.HOME, '.codex')
  await mkdir(codexHome)
  const idClaims = Buffer.from(JSON.stringify({ email: 'codex@example.test' })).toString('base64url')
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `fixture.${idClaims}.fixture` } }))
  await writeFile(join(directory, 'codex'), '#!/bin/sh\necho "Logged in using ChatGPT"\n', { mode: 0o700 })
  assert.deepEqual(await codexCliAdmin.authStatus({ env }), {
    authenticated: true, account: 'codex@example.test (chatgpt)', label: 'Logged in using ChatGPT', identity: 'codex@example.test',
  })
})

test('Claude status reads JSON through a pipe and disregards diagnostics and stale OAuth metadata', async t => {
  const { directory, env } = await fixture(t)
  await writeFile(join(env.HOME, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'stale@example.test' } }))
  await writeFile(join(directory, 'claude'), `#!/bin/sh
if [ "$(uname -s)" = Linux ] && [ ! -p /dev/stdout ]; then exit 0; fi
echo 'WARNING: test diagnostic' >&2
echo '{"loggedIn":true,"authMethod":"api_key","apiProvider":"firstParty"}'
`, { mode: 0o700 })
  assert.deepEqual(await claudeCliAdmin.authStatus({ env }), {
    authenticated: true, account: 'API Key', label: 'api_key',
  })
  await writeFile(join(directory, 'claude'), '#!/bin/sh\necho \'{"loggedIn":true,"authMethod":"claude.ai","email":"active@example.test"}\'\n')
  assert.deepEqual(await claudeCliAdmin.authStatus({ env }), {
    authenticated: true, account: 'active@example.test', label: 'active@example.test', identity: 'active@example.test',
  })
  await writeFile(join(directory, 'claude'), '#!/bin/sh\necho "WARNING: test diagnostic" >&2\n')
  assert.deepEqual(await claudeCliAdmin.authStatus({ env }), { authenticated: false })
})

test('isolated OAuth accounts use their own credential directories for status and logout', async t => {
  const { directory, env } = await fixture(t)
  const store = join(directory, 'direct-chat')
  const claudeDefault = join(env.HOME, '.claude')
  const claudeProfile = join(store, 'profiles', 'claude', 'other')
  const codexProfile = join(store, 'profiles', 'codex', 'other')
  const inherited = {
    ...env,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeDefault,
    CLAUDE_CODE_USE_MANTLE: '1',
    OPENAI_FEDERATION_RULE_ID: 'fixture',
  }
  const previous = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false })
  let dispose
  t.after(() => {
    dispose?.()
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  await Promise.all([claudeDefault, claudeProfile, codexProfile].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(claudeDefault, 'auth'), 'default@example.test')
  await writeFile(join(claudeProfile, 'auth'), 'isolated@example.test')
  await writeFile(join(store, 'profiles.json'), JSON.stringify({
    claude: { list: [{ id: 'other', kind: 'isolated', name: 'Claude other' }] },
    codex: { list: [{ id: 'other', kind: 'isolated', name: 'Codex other' }] },
  }))
  await writeFile(join(directory, 'claude'), `#!/bin/sh
credentials="$CLAUDE_SECURESTORAGE_CONFIG_DIR/auth"
[ -n "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ] || credentials="$CLAUDE_CONFIG_DIR/auth"
case "$1 $2" in
  '--version ') echo '2.1.330' ;;
  'auth status')
    if [ -n "$CLAUDE_CODE_USE_MANTLE" ]; then echo '{"loggedIn":true,"authMethod":"third_party","apiProvider":"mantle"}'
    elif [ -f "$credentials" ]; then printf '{"loggedIn":true,"email":"%s"}\\n' "$(cat "$credentials")"
    else echo '{"loggedIn":false}'; exit 1; fi ;;
  'auth logout') rm "$credentials" ;;
esac
`, { mode: 0o700 })
  await writeFile(join(directory, 'codex'), `#!/bin/sh
case "$1 $2" in
  '--version ') echo '0.171.0' ;;
  'login status')
    if [ -n "$OPENAI_FEDERATION_RULE_ID" ]; then echo 'Logged in using workload identity'
    else echo 'Not logged in'; exit 1; fi ;;
esac
`, { mode: 0o700 })

  const { apply } = await import(`../index.mjs?${directory}`)
  let handler
  apply({ effect(fn) { dispose = fn() }, connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    webServer: { register(route) { handler = route.handler; return () => {} } } }, { engines: ['claude', 'codex'] })
  async function call(method, path, input) {
    const req = Object.assign(Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []), {
      method, url: `/api/direct-chat/engines/${path}`, headers: { 'content-type': 'application/json' },
    })
    const res = { writeHead(status) { this.status = status }, end(body) { this.data = JSON.parse(body) } }
    await handler(req, res)
    assert.equal(res.status, 200, JSON.stringify(res.data))
    return res.data
  }
  const previousPath = process.env.PATH
  try {
    process.env.PATH = directory
    assert.equal((await call('POST', 'codex/check')).status.installed, true)
    await rm(join(directory, 'codex'))
    const missing = (await call('POST', 'codex/check')).status
    assert.equal(missing.installed, false)
    assert.equal(missing.version, undefined)
    await writeFile(join(directory, 'codex'), '#!/bin/sh\n[ "$1" = "--version" ] && echo 0.171.1\n', { mode: 0o700 })
    const restored = (await call('POST', 'codex/check')).status
    assert.equal(restored.version, '0.171.1')
    assert.equal(restored.installed, true)
  } finally { process.env.PATH = previousPath }
  const claude = (await call('GET', 'claude/profiles')).profiles.find(item => item.id === 'other')
  assert.equal(claude.account, 'isolated@example.test')
  assert.match(claude.loginCommand, /-u CLAUDE_CODE_USE_MANTLE\b/)
  assert.match(claude.loginCommand, /CLAUDE_SECURESTORAGE_CONFIG_DIR=/)
  const codex = (await call('GET', 'codex/profiles')).profiles.find(item => item.id === 'other')
  assert.equal(codex.authenticated, false)
  assert.match(codex.loginCommand, /-u OPENAI_FEDERATION_RULE_ID\b/)
  await call('POST', 'claude/logout', { profileId: 'other' })
  await assert.rejects(readFile(join(claudeProfile, 'auth')), { code: 'ENOENT' })
  assert.equal(await readFile(join(claudeDefault, 'auth'), 'utf8'), 'default@example.test')
})

test('resolveCliCommand resolves Windows .cmd and .exe binaries from PATH', async t => {
  const { directory } = await fixture(t)
  const npmDir = join(directory, 'npm')
  const binDir = join(directory, 'bin')
  await mkdir(npmDir)
  await mkdir(binDir)
  await writeFile(join(npmDir, 'agy.cmd'), '@echo off\r\n')
  await writeFile(join(npmDir, 'codex.cmd'), '@echo off\r\n')
  await writeFile(join(binDir, 'claude.exe'), 'exe')
  await writeFile(join(binDir, 'claude.cmd'), '@echo off\r\n')

  const env = { PATH: `${npmDir};${binDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const agy = resolveCliCommand('agy', env, 'win32')
  assert.equal(agy.isBatch, true)
  assert.equal(agy.resolvedPath, join(npmDir, 'agy.cmd'))
  assert.deepEqual(agy.argsPrefix, ['/d', '/c', join(npmDir, 'agy.cmd')])

  const codex = resolveCliCommand('codex', env, 'win32')
  assert.equal(codex.isBatch, true)
  assert.equal(codex.resolvedPath, join(npmDir, 'codex.cmd'))

  const claude = resolveCliCommand('claude', env, 'win32')
  assert.equal(claude.isBatch, false)
  assert.equal(claude.resolvedPath, join(binDir, 'claude.exe'))
  assert.equal(claude.command, join(binDir, 'claude.exe'))

  const linux = resolveCliCommand('agy', env, 'linux')
  assert.equal(linux.command, 'agy')
  assert.deepEqual(linux.argsPrefix, [])
})
