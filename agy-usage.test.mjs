import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agyAccountUsage, agyUsageReport } from './agy-usage.mjs'
import { accountLimitGroups } from './ui/session-status.mjs'

test('AGY account usage reflects the native quota buckets and ignores disabled or missing data', () => {
  const report = { status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Models', buckets: [
      { name: 'Pro', window: '5h', remaining_fraction: 0.8 },
      { name: 'Pro', window: 'Weekly', remaining_fraction: 0.6, reset_time: '2026-11-20T14:00:00Z' },
      { name: 'Pro', window: 'Monthly', remaining_fraction: 0.9 },
      { name: 'Flash', remaining_fraction: 0 },
      { name: 'Disabled', disabled: true, remaining_fraction: 0 },
      { name: 'Unknown', remaining_amount: 10 },
    ] },
    { name: 'Add-ons', buckets: [{ name: 'Pro', window: 'Weekly', remaining_fraction: 1 }] },
  ] } } }
  assert.deepEqual(agyUsageReport(report), { status: 'available', limits: [
    { label: 'Models · Pro · 5h', poolId: '0:Pro', poolLabel: 'Pro', windowLabel: '5h', usedPercent: 20 },
    { label: 'Models · Pro · Weekly', poolId: '0:Pro', poolLabel: 'Pro', windowLabel: 'Weekly', usedPercent: 40,
      resetsAt: Date.parse('2026-11-20T14:00:00Z') },
    { label: 'Models · Pro · Monthly', poolId: '0:Pro', poolLabel: 'Pro', windowLabel: 'Monthly', usedPercent: 10 },
    { label: 'Models · Flash', poolId: '0:Flash', poolLabel: 'Flash', usedPercent: 100 },
    { label: 'Add-ons · Pro · Weekly', poolId: '1:Pro', poolLabel: 'Add-ons · Pro', windowLabel: 'Weekly', usedPercent: 0 },
  ] })
  assert.deepEqual(agyUsageReport({ ...report, num_turns: 1 }), { status: 'unavailable', limits: [] })
  assert.deepEqual(agyUsageReport({ status: 'ERROR', num_turns: 0 }), { status: 'unavailable', limits: [] })
})

test('AGY groups weekly and five-hour readings from the same native pool', () => {
  const weekly = (name, remaining_fraction) => ({ name, window: 'weekly', remaining_fraction })
  const fiveHours = { name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1 }
  const { limits } = agyUsageReport({ status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: { groups: [
    { name: 'Gemini Models', buckets: [weekly('Weekly Limit Remaining', 0.916), fiveHours] },
    { name: 'Claude and GPT models', buckets: [weekly('Weekly Limit Remaining', 1), fiveHours] },
    { name: 'Gemini 4 Argon', buckets: [weekly('Gemini 4 Argon Weekly Limit', 0.509)] },
  ] } } })
  assert.deepEqual(accountLimitGroups(limits).map(({ name, windows }) => [
    name, windows.map(({ windowLabel, usedPercent }) => [windowLabel, usedPercent]),
  ]), [
    ['Gemini Models', [['weekly', 8.4], ['5h', 0]]],
    ['Claude and GPT models', [['weekly', 0], ['5h', 0]]],
    ['Gemini 4 Argon', [['weekly', 49.1]]],
  ])
})

test('AGY rechecks for native quota support after a CLI upgrade', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'direct-chat-agy-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const version = join(directory, 'version')
  await writeFile(join(directory, 'agy'), '#!/bin/sh\n' + String.raw`
case "$1 $2" in
  '--version ') cat "$FIXTURE_AGY_VERSION" ;;
  '--print /usage') echo '{"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"Models","buckets":[{"name":"Pro","remaining_fraction":0.5}]}]}}}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 })
  const options = { cwd: directory, env: { PATH: `${directory}:${process.env.PATH}`, FIXTURE_AGY_VERSION: version } }
  await writeFile(version, '1.1.10\n')
  assert.equal((await agyAccountUsage(options)).status, 'unavailable')
  await writeFile(version, '1.1.11\n')
  assert.equal((await agyAccountUsage(options)).limits[0]?.usedPercent, 50)
})
