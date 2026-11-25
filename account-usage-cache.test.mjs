import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createAccountUsageCache, excludesSubscriptionQuota} from './account-usage-cache.mjs'

const report = (usedPercent, observedAt, resetsAt) => ({limits:[{label:'5h',usedPercent,resetsAt}],observedAt})
test('shares one in-flight refresh, preserves observation time on failure, and can manually retry', async () => {
  let time = 100_000, calls = 0, finish
  const read = createAccountUsageCache(() => time)
  const query = () => { calls++; return new Promise(resolve => { finish=resolve }) }
  const options = {query}
  assert.equal((await read('engine',{...options,cachedOnly:true})).status,'unavailable')
  assert.equal(calls,0)
  const first=read('engine',options), second=read('engine',{...options,force:true})
  await Promise.resolve()
  assert.equal(calls,1)
  finish(report(25))
  const result=await first
  assert.deepEqual(result,await second)
  assert.equal(result.observedAt,time)
  time+=30_001
  const stale=await read('engine',options)
  assert.equal(stale.limits[0].usedPercent,25)
  assert.equal(stale.refreshing,true)
  const forced=read('engine',{...options,force:true})
  finish(undefined)
  const failed=await forced
  assert.equal(failed.observedAt,result.observedAt)
  assert.ok(failed.refreshFailed && failed.stale && !failed.refreshing)
  assert.deepEqual(await read('engine',options),failed)
  const retry=read('engine',{...options,force:true})
  await Promise.resolve()
  finish(report(28))
  assert.equal((await retry).limits[0].usedPercent,28)
  assert.equal(calls,3)
})
test('cached-only can read a timestamped native snapshot and marks it stale across a window reset',async () => {
  let time=10_000, queries=0, local=0
  const read=createAccountUsageCache(()=>time)
  const options={cachedOnly:true,readLocal:()=>{local++;return report(50,9500,10_001)},query:()=>{queries++}}
  const [a,b]=await Promise.all([read('codex',options),read('codex',options)])
  assert.equal(a.observedAt,9500);assert.equal(b.stale,false)
  time+=2
  assert.equal((await read('codex',options)).stale,true)
  assert.equal(local,1);assert.equal(queries,0)
  assert.equal((await read('other',{...options,readLocal:()=>report(90)})).status,'unavailable')
})
test('adopts a newer local reading without a CLI call after a cached account value ages',async () => {
  let time=1_000_000, version=1
  const read=createAccountUsageCache(()=>time)
  const options={cachedOnly:true,readLocal:()=>report(version,time-1000),query:()=>assert.fail('unexpected CLI query')}
  assert.equal((await read('claude',options)).limits[0].usedPercent,1)
  time+=60_000;version=2
  const fresh=await read('claude',options)
  assert.equal(fresh.limits[0].usedPercent,2)
  assert.equal(fresh.stale,false)
})

test('subscription quota depends on the active auth configuration', () => {
  assert.equal(excludesSubscriptionQuota('codex', 'api-provider', {}), true)
  assert.equal(excludesSubscriptionQuota('codex', 'openai', {}), false)
  assert.equal(excludesSubscriptionQuota('claude', undefined, {ANTHROPIC_API_KEY:'fixture'}), true)
  assert.equal(excludesSubscriptionQuota('claude', undefined, {CLAUDE_CODE_USE_VERTEX:'0', CLAUDE_CODE_OAUTH_TOKEN:'fixture'}), false)
  assert.equal(excludesSubscriptionQuota('agy', undefined, {ANTHROPIC_API_KEY:'fixture'}), false)
})
