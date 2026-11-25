import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

test('AGY default OAuth identifies a native keyring login across plugin restarts', { skip: process.platform !== 'linux' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'direct-chat-agy-default-'))
  const home = join(dir, 'home')
  const markerDir = join(home, '.gemini', 'antigravity-cli', 'cache')
  const marker = join(markerDir, 'acp-auth-state.json')
  const item = join(dir, 'keyring-item')
  const secret = join(dir, 'keyring-secret')
  const multipleItems = join(dir, 'keyring-multiple')
  const secretRead = join(dir, 'keyring-secret-read')
  const receipt = join(dir, 'direct-chat', 'agy-default-oauth.json')
  const overrides = { HOME: home, DSH_HOME: dir, PATH: dir + ':' + process.env.PATH,
    ANTIGRAVITY_GEMINI_DIR: undefined, ANTIGRAVITY_APP_DATA_DIR: undefined,
    ANTIGRAVITY_CREDENTIAL_SCOPE: undefined, AGY_ACCOUNT: undefined, AGY_ADC_AUTH: undefined }
  const oldEnv = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]))
  function setEnv(values) {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  setEnv(overrides)
  let dispose
  t.after(async () => {
    dispose?.()
    setEnv(oldEnv)
    await rm(dir, { recursive: true, force: true })
  })

  await mkdir(markerDir, { recursive: true })
  await writeFile(join(dir, 'agy'), '#!/bin/sh\n' + String.raw`
case "$1 $2" in
  '--version ') echo 1.5.15; exit ;;
  '--print /logout') echo '/logout is not available in print mode' >&2; exit 2 ;;
  'acp --login') ;;
  *) exit 3 ;;
esac
echo 'https://accounts.google.com/o/oauth2/auth?state=default-fixture'
IFS= read -r code
if [ "$code" = fixture-keyring ]; then
  printf '%s' '{"methodId":"oauth-personal"}' > "$HOME/.gemini/antigravity-cli/cache/acp-auth-state.json"
  printf '%s\n' 100 > "$DSH_HOME/keyring-item"
fi
printf 'Logged in as '
printf 'native@example.test.\n'
`, { mode: 0o700 })
  await writeFile(join(dir, 'busctl'), '#!/bin/sh\n' + String.raw`
[ "$1 $2 $3" = '--user --auto-start=no --json=short' ] || exit 3
shift 3
path='/org/freedesktop/secrets/collection/login/item1'
if [ "$1" = call ] && [ "$5" = SearchItems ]; then
  if [ -f "$DSH_HOME/keyring-item" ]; then
    if [ -f "$DSH_HOME/keyring-multiple" ]; then
      printf '{"type":"aoao","data":[["%s","%s"],[]]}\n' "$path" '/org/freedesktop/secrets/collection/other/item2'
    else
      printf '{"type":"aoao","data":[["%s"],[]]}\n' "$path"
    fi
  else
    printf '{"type":"aoao","data":[[],[]]}\n'
  fi
elif [ "$1" = call ] && [ "$3" = "$path" ] && [ "$4 $5" = 'org.freedesktop.Secret.Item Delete' ]; then
  rm -f "$DSH_HOME/keyring-item"
  printf '{"type":"o","data":["/"]}\n'
elif [ "$1" = get-property ] && [ -f "$DSH_HOME/keyring-item" ]; then
  case "$5" in
    Created) echo '{"type":"t","data":100}' ;;
    Modified) printf '{"type":"t","data":%s}\n' "$(cat "$DSH_HOME/keyring-item")" ;;
    *) exit 4 ;;
  esac
else
  exit 4
fi
`, { mode: 0o700 })
  await writeFile(join(dir, 'secret-tool'), '#!/bin/sh\n' + String.raw`
[ "$*" = 'search service gemini username antigravity' ] || exit 3
[ -f "$DSH_HOME/keyring-secret" ] || exit 4
touch "$DSH_HOME/keyring-secret-read"
printf '[/item1]\nsecret = %s\n' "$(cat "$DSH_HOME/keyring-secret")"
`, { mode: 0o700 })

  const { apply } = await import('../index.mjs')
  let handler
  function startPlugin() {
    dispose?.()
    apply({
      effect(fn) { dispose = fn() },
      connection: { admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
      webServer: { register(route) { handler = route.handler; return () => {} } },
    }, { engines: ['agy'] })
  }
  async function call(method, suffix = '', data, expected = 200) {
    const req = Readable.from(data ? [Buffer.from(JSON.stringify(data))] : [])
    Object.assign(req, { url: '/api/direct-chat/engines' + suffix, method, headers: { 'content-type': 'application/json' } })
    const res = Object.assign(new EventEmitter(), {
      writeHead(status) { this.status = status },
      end(body) { this.data = JSON.parse(body) },
    })
    await handler(req, res)
    assert.equal(res.status, expected, JSON.stringify(res.data))
    return res.data
  }
  async function waitFor(id, expected) {
    let login
    for (let i = 0; i < 100; i++) {
      login = await call('GET', '/agy/login/' + id)
      if (login.status === expected) return login
      if (login.status === 'error') break
      await delay(20)
    }
    assert.equal(login?.status, expected, login?.error)
  }
  async function logIn(code, status) {
    const { loginId } = await call('POST', '/agy/login/start', { profileId: 'default' })
    await waitFor(loginId, 'waiting_auth')
    await call('POST', '/agy/login/' + loginId + '/code', { code })
    return waitFor(loginId, status)
  }
  const profile = async () => (await call('GET', '/agy/profiles')).profiles[0]
  const engineProfile = async () => (await call('GET')).engines[0].profiles[0]
  const binding = async () => (await engineProfile()).name

  startPlugin()
  await writeFile(marker, '{"methodId":"oauth-personal"}')
  assert.equal((await profile()).authenticated, false)
  assert.equal(await binding(), 'Default')
  assert.equal((await logIn('unchanged-marker', 'error')).errorCode, 'engineSettings.oauthMissing')

  await writeFile(item, '99\n')
  await writeFile(secret, '{"token":{"refresh_token":"fixture"},"id_token_email":"terminal@example.test"}')
  assert.equal((await engineProfile()).account, 'terminal@example.test')
  assert.equal((await profile()).account, 'terminal@example.test')
  const { agyCliAdmin } = await import('../engines/cli-admin.mjs')
  assert.deepEqual(await agyCliAdmin.authStatus({ env: { HOME: join(dir, 'unsigned-profile') } }), { authenticated: false })
  await assert.rejects(readFile(receipt), { code: 'ENOENT' })
  await rm(secretRead)
  await writeFile(multipleItems, '')
  assert.equal((await engineProfile()).account, undefined)
  assert.equal((await profile()).account, 'Google OAuth')
  await assert.rejects(readFile(secretRead), { code: 'ENOENT' })
  const ambiguousLogout = await call('POST', '/agy/logout', { profileId: 'default' }, 409)
  assert.equal(ambiguousLogout.code, 'agy_native_logout_manual')
  assert.equal(await readFile(item, 'utf8'), '99\n')
  await rm(multipleItems)
  await rm(secret)
  await rm(item)

  assert.equal((await logIn('fixture-keyring', 'done')).account, 'native@example.test')
  assert.equal((await profile()).account, 'native@example.test')
  assert.equal(await binding(), 'native@example.test')
  assert.deepEqual(Object.keys(JSON.parse(await readFile(receipt, 'utf8'))).sort(), ['account', 'item', 'marker'])
  const legacyFile = join(markerDir, '..', 'oauth_creds.json')
  await writeFile(legacyFile, '{"access_token":"fixture","id_token_email":"legacy@example.test"}')
  assert.equal((await profile()).account, 'native@example.test')
  await rm(legacyFile)

  startPlugin()
  assert.equal((await profile()).account, 'native@example.test')
  assert.equal(await binding(), 'native@example.test')
  await writeFile(item, '101\n')
  assert.equal((await profile()).account, 'Google OAuth')
  assert.equal(await binding(), 'Default')

  const isolatedDirectory = join(dir, 'direct-chat', 'profiles', 'agy', 'other', '.gemini', 'antigravity-cli')
  await mkdir(isolatedDirectory, { recursive: true })
  const isolatedCredential = join(isolatedDirectory, 'antigravity-oauth-token')
  const isolatedSignIn = '{"token":{"refresh_token":"isolated-fixture"},"id_token_email":"native@example.test"}'
  await writeFile(isolatedCredential, isolatedSignIn)
  await writeFile(join(dir, 'direct-chat', 'profiles.json'), JSON.stringify({
    agy: { defaultProfileId: 'other', list: [{ id: 'other', name: 'Isolated', kind: 'isolated' }] },
  }))
  await writeFile(legacyFile, '{"refresh_token":"legacy-fixture","id_token_email":"legacy@example.test"}')
  const clientConfig = join(markerDir, '..', 'credentials.json')
  await writeFile(clientConfig, '{"installed":{"client_id":"client-fixture"}}')
  assert.equal((await engineProfile()).account, undefined)

  await call('POST', '/agy/logout', { profileId: 'default' })
  assert.equal((await profile()).authenticated, false)
  assert.equal(await readFile(isolatedCredential, 'utf8'), isolatedSignIn)
  await assert.rejects(readFile(item), { code: 'ENOENT' })
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await assert.rejects(readFile(legacyFile), { code: 'ENOENT' })
  assert.equal(await readFile(clientConfig, 'utf8'), '{"installed":{"client_id":"client-fixture"}}')
  await assert.rejects(readFile(receipt), { code: 'ENOENT' })
  await writeFile(legacyFile, '{"installed":{"client_id":"fixture"}}')
  assert.equal((await profile()).authenticated, false)
  await writeFile(legacyFile, '{"access_token":"fixture","expiry_date":1}')
  assert.equal((await profile()).authenticated, false)
  await writeFile(legacyFile, '{"refresh_token":"fixture","id_token_email":"legacy@example.test"}')
  assert.equal((await profile()).account, 'legacy@example.test')
})
