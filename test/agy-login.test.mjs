import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

test('AGY OAuth resumes one isolated login and keeps only successful accounts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'direct-chat-oauth-'))
  // This fixture exercises file credentials. Keep the user's Secret Service out of it.
  await writeFile(join(dir, 'busctl'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  const oldPath = process.env.PATH
  const oldDsh = process.env.DSH_HOME
  const oldXdgConfig = process.env.XDG_CONFIG_HOME
  const oldHome = process.env.HOME
  process.env.PATH = `${dir}:${oldPath}`
  process.env.DSH_HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, 'default-config')
  process.env.HOME = join(dir, 'default-home')
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false })
  let dispose
  t.after(async () => {
    dispose?.()
    globalThis.fetch = originalFetch
    process.env.PATH = oldPath
    if (oldDsh === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldDsh
    if (oldXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = oldXdgConfig
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(join(dir, 'default-config', 'antigravity'), { recursive: true })
  const defaultScope = join(dir, 'default-config', 'antigravity', 'credential-user-scope')
  await writeFile(defaultScope, 'default fixture')
  const defaultCredentials = join(process.env.HOME, '.gemini', 'antigravity-cli')
  await mkdir(defaultCredentials, { recursive: true })
  const defaultToken = join(defaultCredentials, 'antigravity-oauth-token')
  const defaultSignIn = JSON.stringify({
    token: { access_token: 'fixture-access', refresh_token: 'fixture-refresh' },
    id_token_email: 'primary@example.test',
  })
  await writeFile(defaultToken, defaultSignIn)
  await writeFile(join(dir, 'agy'), `#!/bin/sh
if [ "$1" = --version ]; then echo 1.0.0; exit; fi
if [ "$1 $2" = '--print /logout' ]; then echo '/logout is not available in print mode' >&2; exit 2; fi
[ "$1 $2" = 'acp --login' ] || exit 3
[ "$(uname -s)" != Linux ] || [ "$DBUS_SESSION_BUS_ADDRESS" = unix:path=/dev/null/dsh-agy-private-bus ] || exit 8
printf '%s\\n' "$HOME" >> "$DSH_HOME/attempts"
[ "$HOME" != "$DSH_HOME" ] && [ "$XDG_CONFIG_HOME" = "$HOME/.config" ] || exit 4
sleep 0.3
echo 'Documentation at https://example.test/help'
echo 'Open this URL in your local browser to sign in:'
echo 'https://accounts.google.com/o/oauth2/auth?state=fixture'
IFS= read -r code
[ "$code" != no-credentials ] || exit 0
if [ "$code" = rejected-code ]; then echo 'Failed to exchange: invalid_grant' >&2; exit 1; fi
[ "$code" = fixture-code ] || exit 5
mkdir -p "$HOME/.gemini/antigravity-cli"
printf '%s' '{"token":{"access_token":"fixture-access","refresh_token":"fixture-refresh"},"id_token_email":"isolated@example.test"}' > "$HOME/.gemini/antigravity-cli/antigravity-oauth-token"
`, { mode: 0o700 })
  await writeFile(join(dir, 'codex'), `#!/bin/sh
if [ "$1" = --version ]; then echo 1.0.0; exit; fi
case "$1 $2" in
  'login status') [ -f "$CODEX_HOME/fixture-credentials" ] && echo 'Logged in using ChatGPT' ;;
  'login ')
    [ -d "$CODEX_HOME" ] || exit 2
    echo 'https://auth.openai.com/oauth/authorize?state=fixture'
    sleep 0.2
    touch "$CODEX_HOME/fixture-credentials"
    ;;
esac
`, { mode: 0o700 })
  await writeFile(join(dir, 'claude'), `#!/bin/sh
if [ "$1" = --version ]; then echo 1.0.0; exit; fi
case "$1 $2" in
  'auth status')
    if [ -f "$CLAUDE_CONFIG_DIR/fixture-credentials" ]; then echo '{"loggedIn":true,"email":"test@example.test"}'
    else echo '{"loggedIn":false}'; fi
    ;;
  'auth login')
    [ -d "$CLAUDE_CONFIG_DIR" ] || exit 2
    echo 'https://claude.ai/oauth/authorize?state=fixture'
    IFS= read -r code
    if [ "$code" = fixture-code ]; then touch "$CLAUDE_CONFIG_DIR/fixture-credentials"; fi
    ;;
esac
`, { mode: 0o700 })

  const { apply } = await import('../index.mjs')
  let handler
  apply({
    effect(fn) { dispose = fn() },
    connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }, { engines: ['agy', 'codex', 'claude'] })

  async function call(method, suffix, data, expected = 200) {
    const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : [])
    Object.assign(req, { url: `/api/direct-chat/engines${suffix ? `/${suffix}` : ''}`, method, headers: { 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), {
      writeHead(status) { this.status = status },
      end(body) { this.data = JSON.parse(body) },
    })
    await handler(req, res)
    assert.equal(res.status, expected, JSON.stringify(res.data))
    return res.data
  }

  async function waitFor(id, status, engine = 'agy') {
    let login
    for (let i = 0; i < 100; i++) {
      login = await call('GET', `${engine}/login/${id}`)
      if (login.status === status) return login
      if (login.status === 'error') break
      await delay(20)
    }
    assert.equal(login?.status, status, login?.error)
  }

  const start = () => call('POST', 'agy/login/start', { createProfile: true })
  const [login, duplicate] = await Promise.all([start(), start()])
  assert.equal(login.status, 'waiting_url')
  assert.equal(duplicate.loginId, login.loginId)
  assert.equal((await call('GET', 'all/login/active')).login.loginId, login.loginId)
  const profiles = () => call('GET', 'agy/profiles').then(result => result.profiles)
  assert.deepEqual((await profiles()).map(profile => profile.id), ['default'])
  assert.equal((await profiles())[0].account, 'primary@example.test')
  const authorized = await waitFor(login.loginId, 'waiting_auth')
  assert.equal(authorized.authUrl, 'https://accounts.google.com/o/oauth2/auth?state=fixture')
  assert.equal((await start()).loginId, login.loginId)
  const invalid = await call('POST', `agy/login/${login.loginId}/code`, { code: 'https://antigravity.google/oauth-callback?code=fixture&state=old' }, 400)
  assert.equal(invalid.code, 'oauth_callback_invalid')
  await call('POST', `agy/login/${login.loginId}/code`, { code: 'fixture-code' })
  assert.equal((await waitFor(login.loginId, 'done')).account, 'isolated@example.test')
  assert.equal((await call('GET', 'all/login/active')).login, null)
  const list = await profiles()
  assert.equal(list.length, 2)
  assert.equal(list[1].id, login.profileId)
  assert.equal(list[1].kind, 'isolated')
  assert.equal(list[1].authenticated, true)
  if (process.platform === 'linux') assert.match(list[1].loginCommand, /DBUS_SESSION_BUS_ADDRESS='unix:path=\/dev\/null\/dsh-agy-private-bus'/)
  assert.equal(list[1].account, 'isolated@example.test')
  assert.equal(list[1].name, 'isolated@example.test')
  const renamed = await call('POST', 'agy/profiles', { action: 'update', profileId: login.profileId, name: 'Work Google account' })
  assert.equal(renamed.profiles[1].name, 'Work Google account')
  const engineProfiles = (await call('GET', '')).engines.find(engine => engine.id === 'agy').profiles
  assert.deepEqual(engineProfiles.find(profile => profile.id === login.profileId), {
    id: login.profileId, kind: 'isolated', name: 'Work Google account', account: 'isolated@example.test',
  })

  const cancelled = await start()
  await waitFor(cancelled.loginId, 'waiting_auth')
  await call('POST', `agy/login/${cancelled.loginId}/cancel`, {})
  await waitFor(cancelled.loginId, 'cancelled')
  assert.equal((await call('GET', 'all/login/active')).login, null)
  assert.equal((await profiles()).length, 2)
  const attempts = (await readFile(join(dir, 'attempts'), 'utf8')).trim().split('\n')
  assert.deepEqual(attempts, [login, cancelled].map(job => join(dir, 'direct-chat', 'profiles', 'agy', job.profileId)))
  assert.equal(await readFile(defaultScope, 'utf8'), 'default fixture')

  const missingCredentials = await start()
  await waitFor(missingCredentials.loginId, 'waiting_auth')
  await call('POST', `agy/login/${missingCredentials.loginId}/code`, { code: 'no-credentials' })
  const failedAgy = await waitFor(missingCredentials.loginId, 'error')
  assert.match(failedAgy.error, /without saving OAuth credentials for this account/)
  assert.equal(failedAgy.account, undefined)
  assert.equal(failedAgy.errorCode, 'engineSettings.oauthMissing')
  const rejected = await start()
  await waitFor(rejected.loginId, 'waiting_auth')
  await call('POST', `agy/login/${rejected.loginId}/code`, {code:'rejected-code'})
  assert.equal((await waitFor(rejected.loginId, 'error')).errorCode, 'engineSettings.oauthRejected')
  assert.equal((await profiles()).length, 2)

  const isolatedDir = join(attempts[0], '.gemini', 'antigravity-cli')
  await mkdir(join(isolatedDir, 'cache'), { recursive: true })
  const marker = join(isolatedDir, 'cache', 'acp-auth-state.json')
  const settings = join(isolatedDir, 'settings.json')
  await writeFile(marker, '{"methodId":"oauth-personal"}')
  await writeFile(settings, '{"keep":"settings"}')
  await call('POST', 'agy/profiles', { action: 'setDefault', profileId: login.profileId })
  await call('POST', 'agy/logout', { profileId: login.profileId })
  const signedOut = await profiles()
  assert.equal(signedOut[0].authenticated, true)
  assert.equal(signedOut[1].authenticated, false)
  assert.equal(signedOut[1].account, undefined)
  assert.equal(signedOut[1].name, 'Work Google account')
  assert.equal(signedOut[1].isDefault, true)
  assert.equal(await readFile(defaultToken, 'utf8'), defaultSignIn)
  assert.equal(await readFile(defaultScope, 'utf8'), 'default fixture')
  assert.equal(await readFile(settings, 'utf8'), '{"keep":"settings"}')
  await assert.rejects(readFile(join(isolatedDir, 'antigravity-oauth-token')), { code: 'ENOENT' })
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await call('POST', 'agy/logout', { profileId: login.profileId })
  const movedDirectory = isolatedDir + '.saved'
  await rename(isolatedDir, movedDirectory)
  await symlink(defaultCredentials, isolatedDir, 'dir')
  const unsafeLogout = await call('POST', 'agy/logout', { profileId: login.profileId }, 409)
  assert.equal(unsafeLogout.code, 'agy_logout_storage')
  assert.equal(await readFile(defaultToken, 'utf8'), defaultSignIn)
  await rm(isolatedDir)
  await rename(movedDirectory, isolatedDir)

  for (const engine of ['codex', 'claude']) {
    const list = () => call('GET', `${engine}/profiles`).then(result => result.profiles.filter(profile => profile.kind === 'isolated'))
    await call('POST', `${engine}/login/start`, { profileId: 'missing' }, 409)
    const login = await call('POST', `${engine}/login/start`, { createProfile: true })
    assert.equal((await list()).length, 0)
    await waitFor(login.loginId, 'waiting_auth', engine)
    if (engine === 'claude') await call('POST', `${engine}/login/${login.loginId}/code`, { code: 'fixture-code' })
    await waitFor(login.loginId, 'done', engine)
    assert.equal((await list())[0].id, login.profileId)
  }

  const failed = await call('POST', 'claude/login/start', { createProfile: true })
  await waitFor(failed.loginId, 'waiting_auth', 'claude')
  await call('POST', `claude/login/${failed.loginId}/code`, { code: 'wrong-code' })
  assert.match((await waitFor(failed.loginId, 'error', 'claude')).error, /without storing OAuth credentials/)
  const claude = await call('GET', 'claude/profiles')
  assert.equal(claude.profiles.filter(profile => profile.kind === 'isolated').length, 1)
})
