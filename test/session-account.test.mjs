import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { nativeId } from '../server/native-history.mjs'

async function fixture(t, profiles) {
  const dir=await mkdtemp(join(tmpdir(),'direct-chat-accounts-'))
  const old=process.env.DSH_HOME
  process.env.DSH_HOME=dir
  let dispose
  t.after(async()=>{
    dispose?.()
    if (old===undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME=old
    await rm(dir,{recursive:true,force:true})
  })
  const store=join(dir,'direct-chat')
  await mkdir(store)
  await writeFile(join(store,'profiles.json'),JSON.stringify(profiles))
  const modules=await Promise.all(Object.keys(profiles).map(async id=>{
    const file=join(dir,`${id}.mjs`)
    await writeFile(file,`
      import {randomUUID} from 'node:crypto'
      import {agyCliAdmin} from ${JSON.stringify(new URL('../engines/cli-admin.mjs',import.meta.url).href)}
      export const starts=[], turns=[], usage=[], closes=[], imports=[], metadata=[]
      let failNextStart=false
      export function failNext() { failNextStart=true }
      export const engine={id:${JSON.stringify(id)},label:'Fixture',resumeEmpty:${id==='agy'},
        history:{list:()=>imports,messages:entry=>entry.messages,context({file}) {
          metadata.push({action:'context',file})
          return {used:10,size:100}
        }},
        rename({env,remoteId,title}) { metadata.push({action:'rename',env,remoteId,title}) },
        setArchived({env,remoteId,archived}) { metadata.push({action:'archive',env,remoteId,archived}) },
        readOAuthAccount:${id==='agy'} ? agyCliAdmin.readOAuthAccount : undefined,
        logoutCli:${id==='agy'} ? agyCliAdmin.logoutCli : undefined,
        configProfiles:${id==='codex'} ? ()=>[{id:'provider:other',name:'Other provider',kind:'config',modelProvider:'other'}] : undefined,
        defaultModelProvider:${id==='codex'} ? ()=>'openai' : undefined,
        start({env={},resumeId,emit,modelProvider,historyDirectory,runtimeDirectory}) {
          const account=env.ACCOUNT || (env.HOME ? 'isolated' : 'default')
          const id=account==='wrong-id' || failNextStart ? randomUUID() : resumeId || randomUUID()
          failNextStart=false
          const models=account==='two' || account==='isolated' ? ['second','common'] : ['first','common']
          let model=models[0]
          const options=()=>[{id:'model',category:'model',type:'select',currentValue:model,options:models.map(value=>({value,name:value}))}]
          starts.push({env,resumeId,id,...(historyDirectory ? {historyDirectory,runtimeDirectory} : {})})
          return {id,get options(){return options()},capabilities:{},modelProvider:modelProvider || (${id==='codex'} ? 'openai' : undefined),
            configure(option,value){
              if (option!=='model' || !models.includes(value)) throw new Error('Unavailable fixture model')
              model=value
              return options()
            },
            close(){
              closes.push(account)
              if (account==='two') model='common'
              emit('update',{update:{sessionUpdate:'config_option_update',configOptions:options()}})
            },
            accountUsage(){return {limits:[{label:account,usedPercent:10}]}},
            prompt(text){
              emit('update',{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:account+' '+text}}})
              const turn=Promise.withResolvers()
              turns.push(turn)
              return turn.promise
            },
          }
        },
        accountUsage({env={}}){
          usage.push(env)
          return {limits:[{label:env.ACCOUNT || 'default',usedPercent:10}]}
        },
      }
    `)
    return pathToFileURL(file).href
  }))
  const {apply}=await import(`../index.mjs?${dir}`)
  let handler
  function mount() {
    dispose?.()
    apply({effect(fn){dispose=fn()},connection:{admit(){return {peer:{principal:{kind:'owner'}}}}},
      webServer:{register(route){handler=route.handler;return ()=>{}}}}, {engines:[],engineModules:modules})
  }
  mount()
  async function call(method,path,input) {
    const req=Object.assign(Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []),{
      method,url:'/api/direct-chat'+path,headers:{'content-type':'application/json'},
    })
    const res={writeHead(status){this.status=status;this.headersSent=true},end(value){this.data=JSON.parse(value)}}
    if (path.endsWith('/events')) {
      const events = new EventEmitter()
      const fresh = Promise.withResolvers()
      const snapshots = []
      Object.assign(res, {
        on: events.on.bind(events),
        write(chunk) {
          if (!chunk.startsWith('data: ')) return
          const event = JSON.parse(chunk.slice(6))
          if (event.type !== 'snapshot') return
          snapshots.push(event.data)
          if (snapshots.length === 2) fresh.resolve()
        },
        snapshots, fresh: fresh.promise, close: () => events.emit('close'),
      })
    }
    await handler(req,res)
    return res
  }
  return {dir,store,mount,call,engine:await import(modules[0])}
}

const envProfile=(id,value=id)=>({id,name:id,kind:'env',env:{ACCOUNT:value}})

test('AGY sign-out closes only the selected idle adapter and refreshes connected account menus', async t => {
  const isolated = { id: 'work', name: 'Work', kind: 'isolated' }
  const { call, dir, store, engine } = await fixture(t, { agy: { list: [isolated] } })
  const credentialDirectory = join(store, 'profiles', 'agy', isolated.id, '.gemini', 'antigravity-cli')
  await mkdir(credentialDirectory, { recursive: true })
  await writeFile(join(credentialDirectory, 'antigravity-oauth-token'), JSON.stringify({
    token: { refresh_token: 'fixture' }, id_token_email: 'old@example.test',
  }))
  const native = await call('POST', '/sessions', { engine: 'agy', cwd: dir, profileId: 'default' })
  const work = await call('POST', '/sessions', { engine: 'agy', cwd: dir, profileId: isolated.id })
  assert.equal(native.status, 201)
  assert.equal(work.status, 201)
  const nativeStream = await call('GET', '/sessions/' + native.data.id + '/events')
  const workStream = await call('GET', '/sessions/' + work.data.id + '/events')
  const nativeSnapshots = nativeStream.snapshots
  const workSnapshots = workStream.snapshots
  try {
    assert.equal(workSnapshots.at(-1).account.account, 'old@example.test')
    const loggedOut = await call('POST', '/engines/agy/logout', { profileId: isolated.id })
    assert.equal(loggedOut.status, 200)
    assert.deepEqual(engine.closes, ['isolated'])
    assert.equal(workSnapshots.length, 2)
    assert.equal(workSnapshots.at(-1).account.account, undefined)
    assert.equal(nativeSnapshots.length, 2)
    assert.equal(nativeSnapshots.at(-1).account.id, 'default')
    assert.equal(nativeSnapshots.at(-1).account.choices.find(choice => choice.id === isolated.id).account, undefined)
  } finally {
    nativeStream.close()
    workStream.close()
  }
})

test('session launch and account usage follow the persisted binding through switch, failure and restart',async t=>{
  const {call,dir,store,mount,engine}=await fixture(t,{codex:{defaultProfileId:'one',list:[
    envProfile('one'),envProfile('two'),envProfile('bad','wrong-id'),{...envProfile('other-home'),env:{CODEX_HOME:'/unrelated'}},
  ],overrides:{one:{env:{OWN:'first'}},two:{env:{OWN:'second'}},unrelated:{env:{UNRELATED:'excluded'}}}}})
  const create=await call('POST','/sessions',{engine:'codex',cwd:dir})
  assert.equal(create.status,201)
  const path='/sessions/'+create.data.id
  const persisted=async()=>JSON.parse(await readFile(join(store,create.data.id+'.json'),'utf8'))
  assert.deepEqual(create.data.account,{id:'one',label:'one',canSwitch:true,choices:[
    {id:'default',label:'Default configuration'},{id:'provider:other',label:'Other provider'},
    {id:'one',label:'one'},{id:'two',label:'two'},{id:'bad',label:'bad'},
  ]})
  assert.deepEqual(engine.starts[0].env,{ACCOUNT:'one',OWN:'first'})
  assert.equal((await persisted()).profileId,'one')
  assert.equal((await call('POST','/engines/codex/profiles',{action:'setDefault',profileId:'two'})).status,200)
  assert.equal((await call('GET',path)).data.account.id,'one')
  assert.equal((await call('GET',path+'/usage?profileId=one')).data.limits[0].label,'one')

  assert.equal((await call('POST',path+'/prompt',{text:'before'})).status,202)
  assert.equal((await call('GET',path)).data.account.switchBlockedReason,'busy')
  assert.equal((await call('POST',path+'/account',{profileId:'two'})).status,409)
  engine.turns[0].resolve({stopReason:'end_turn'})
  await setImmediate()
  assert.equal((await call('GET',path)).data.account.choices.some(choice=>choice.id==='provider:other'),false)
  assert.equal((await call('POST',path+'/account',{profileId:'provider:other'})).status,409)
  const switched=await call('POST',path+'/account',{profileId:'two'})
  assert.equal(switched.status,200)
  assert.equal(switched.data.id,create.data.id)
  assert.equal(switched.data.account.id,'two')
  assert.deepEqual(switched.data.options[0].options.map(option=>option.value),['second','common'])
  assert.equal(switched.data.options[0].currentValue,'second')
  assert.deepEqual(switched.data.messages.map(row=>row.text),['before','one before'])
  assert.deepEqual(engine.starts[1],{env:{ACCOUNT:'two',OWN:'second'},resumeId:engine.starts[0].id,id:engine.starts[0].id})
  assert.deepEqual(engine.closes,['one'])
  assert.equal((await persisted()).profileId,'two')
  assert.equal((await call('GET',path+'/usage?profileId=one')).status,409)
  assert.equal((await call('GET',path+'/usage?cached=1&profileId=two')).data.status,'unavailable')
  assert.equal((await call('GET',path+'/usage?profileId=two')).data.limits[0].label,'two')
  assert.equal((await call('POST',path+'/account',{profileId:'other-home'})).status,409)
  assert.equal((await call('POST',path+'/account',{profileId:'bad'})).status,409)
  assert.equal((await persisted()).profileId,'two')
  assert.equal((await call('GET',path)).data.account.id,'two')
  assert.deepEqual((await call('GET',path)).data.options,switched.data.options)
  assert.equal((await call('POST','/engines/codex/profiles',{action:'setDefault',profileId:'one'})).status,200)

  mount()
  assert.equal((await call('GET',path+'/usage?profileId=two')).data.limits[0].label,'two')
  assert.deepEqual(engine.usage.at(-1),{ACCOUNT:'two',OWN:'second'})
  assert.equal((await call('POST',path+'/prompt',{text:'after'})).status,202)
  engine.turns.at(-1).resolve({stopReason:'end_turn'})
  await setImmediate()
  assert.deepEqual((await call('GET',path)).data.messages.map(row=>row.text),['before','one before','after','two after'])
  assert.equal((await call('POST',path+'/parallel',{tasks:['child']})).status,202)
  assert.deepEqual(engine.starts.at(-1).env,{ACCOUNT:'two',OWN:'second'})
  engine.turns.at(-1).resolve({stopReason:'end_turn'})
  await setImmediate()
})

test('AGY switches each session independently and resumes the same native conversation after restart',async t=>{
  const isolated={id:'abcd1234',name:'Antigravity #1',kind:'isolated'}
  const legacy={id:'abcd5678',name:'Legacy',kind:'snapshot'}
  const {call,dir,store,mount,engine}=await fixture(t,{agy:{defaultProfileId:legacy.id,list:[isolated,legacy]}})
  const workspace=join(dir,'workspace')
  await mkdir(workspace)
  const dirForAccount=join(store,'profiles','agy',isolated.id)
  const credentials=join(dirForAccount,'.gemini','antigravity-cli')
  await mkdir(credentials,{recursive:true})
  await writeFile(join(credentials,'antigravity-oauth-token'),JSON.stringify({
    token:{access_token:'fixture-access',refresh_token:'fixture-refresh'},id_token_email:'legacy@example.test',
  }))
  assert.equal((await call('POST','/sessions',{engine:'agy',cwd:dir,profileId:legacy.id})).status,400)
  assert.equal((await call('POST','/sessions',{engine:'agy',cwd:dir})).status,400)
  assert.equal(engine.starts.length,0)
  const create=await call('POST','/sessions',{engine:'agy',cwd:workspace,profileId:'default'})
  const path='/sessions/'+create.data.id
  const persisted=async()=>JSON.parse(await readFile(join(store,create.data.id+'.json'),'utf8'))
  assert.equal(create.status,201)
  assert.equal(create.data.account.canSwitch,true)
  assert.equal(create.data.account.choices.find(choice=>choice.id===isolated.id).label,'legacy@example.test')
  const select=await call('POST',path+'/account',{profileId:isolated.id})
  assert.equal(select.status,200)
  assert.equal(select.data.account.id,isolated.id)
  assert.equal(select.data.account.label,'legacy@example.test')
  assert.equal(select.data.account.account,'legacy@example.test')
  assert.deepEqual(select.data.options[0].options.map(option=>option.value),['second','common'])
  assert.equal(engine.starts.at(-1).env.HOME,dirForAccount)
  assert.equal(engine.starts.at(-1).env.XDG_CONFIG_HOME,join(dirForAccount,'.config'))
  if (process.platform === 'linux') assert.equal(engine.starts.at(-1).env.DBUS_SESSION_BUS_ADDRESS,'unix:path=/dev/null/dsh-agy-private-bus')
  assert.equal(engine.starts.at(-1).resumeId,undefined)
  const isolatedSessionId=engine.starts.at(-1).id
  assert.notEqual(isolatedSessionId,engine.starts[0].id)
  const attachment={type:'file',name:'note.txt',mimeType:'text/plain',data:Buffer.from('attached').toString('base64')}
  assert.equal((await call('POST',path+'/prompt',{text:'hello',attachments:[attachment]})).status,202)
  engine.turns[0].resolve({stopReason:'end_turn'})
  await setImmediate()
  const before=(await call('GET',path)).data
  assert.equal(before.account.canSwitch,true)
  const previewId=before.messages[0].attachments[0].previewId
  const preview=path=>call('GET',`/sessions/${create.data.id}/file?path=${encodeURIComponent(path)}`)
  const olderArtifact=join(credentials,'brain','previous','result.txt')
  await mkdir(join(credentials,'brain','previous'),{recursive:true})
  await writeFile(olderArtifact,'previous native artifact')
  assert.equal((await preview(olderArtifact)).data.text,'previous native artifact')
  const other=await call('POST','/sessions',{engine:'agy',cwd:workspace,profileId:isolated.id})
  const otherPath='/sessions/'+other.data.id
  assert.equal((await call('POST',otherPath+'/prompt',{text:'unrelated'})).status,202)
  engine.failNext()
  assert.equal((await call('POST',path+'/account',{profileId:'default'})).status,409)
  assert.equal((await persisted()).profileId,isolated.id)
  assert.deepEqual((await call('GET',path)).data.messages,before.messages)
  const switched=await call('POST',path+'/account',{profileId:'default'})
  assert.equal(switched.status,200)
  assert.equal(switched.data.id,create.data.id)
  assert.equal(switched.data.account.id,'default')
  assert.deepEqual(switched.data.messages,before.messages)
  assert.equal((await persisted()).remoteId,isolatedSessionId)
  assert.equal((await persisted()).agyHistoryProfileId,isolated.id)
  const active=engine.starts.at(-1)
  assert.deepEqual(active.env,{})
  assert.equal(active.resumeId,isolatedSessionId)
  assert.equal(active.historyDirectory,credentials)
  assert.equal(active.runtimeDirectory,join(store,'agy-sessions',isolatedSessionId,'account-default'))
  assert.equal((await call('GET',otherPath)).data.account.id,isolated.id)
  assert.equal((await call('GET',otherPath)).data.busy,true)
  assert.equal((await call('GET',path+'/attachment?key='+previewId)).data.text,'attached')
  engine.turns[1].resolve({stopReason:'end_turn'})
  await setImmediate()

  const brain=join(credentials,'brain',isolatedSessionId)
  await mkdir(brain,{recursive:true})
  await writeFile(join(brain,'result.txt'),'native artifact')
  assert.equal((await preview(join(active.runtimeDirectory,'brain',isolatedSessionId,'result.txt'))).data.text,'native artifact')
  assert.equal((await preview(join(credentials,'antigravity-oauth-token'))).status,403)
  assert.equal((await preview(olderArtifact)).status,403)
  assert.equal((await call('POST','/engines/agy/profiles',{action:'delete',profileId:isolated.id})).status,409)
  assert.equal((await call('POST',path+'/rename',{title:'renamed'})).status,200)
  assert.equal(engine.metadata.at(-1).env.HOME,dirForAccount)
  assert.equal(engine.metadata.at(-1).remoteId,isolatedSessionId)
  assert.equal((await call('POST',path+'/archive',{archived:true})).status,200)
  assert.equal(engine.metadata.at(-1).env.HOME,dirForAccount)
  assert.equal(engine.metadata.at(-1).remoteId,isolatedSessionId)
  assert.equal((await call('POST',path+'/archive',{archived:false})).status,200)
  mount()
  assert.equal((await call('GET',path)).data.options.some(option=>option.category==='model'),false)
  const stream = await call('GET',path+'/events')
  try {
    await stream.fresh
    assert.deepEqual(stream.snapshots[0].options,[])
    assert.deepEqual(stream.snapshots[1].options[0].options.map(option=>option.value),['first','common'])
  } finally { stream.close() }
  assert.equal((await call('GET',path+'/context')).data.used,10)
  assert.deepEqual(engine.metadata.at(-1),{action:'context',file:join(credentials,'conversation_summaries.db')})
  assert.equal((await call('POST',path+'/prompt',{text:'again'})).status,202)
  assert.deepEqual(engine.starts.at(-1),active)
  engine.turns.at(-1).resolve({stopReason:'end_turn'})
  await setImmediate()
  assert.equal((await call('POST',path+'/account',{profileId:isolated.id})).status,200)
  assert.equal(engine.starts.at(-1).resumeId,isolatedSessionId)
  assert.equal(engine.starts.at(-1).env.HOME,dirForAccount)
  assert.equal(engine.starts.at(-1).runtimeDirectory,undefined)
})

test('an AGY native import can switch from the host account to an isolated OAuth account',async t=>{
  const isolated={id:'abcd1234',name:'Isolated account',kind:'isolated'}
  const {call,dir,store,engine}=await fixture(t,{agy:{defaultProfileId:isolated.id,list:[isolated]}})
  const remoteId='f0443848-0a19-4084-9e17-07f8cbb3de8a'
  const id=nativeId('agy',remoteId)
  const path='/sessions/'+id
  const messages=[{role:'user',text:'original transcript'}]
  engine.imports.push({remoteId,cwd:dir,messages,createdAt:1_800_000_000_000,updatedAt:1_800_000_000_000})
  assert.equal((await call('GET',path)).data.account.id,'default')
  const switched=await call('POST',path+'/account',{profileId:isolated.id})
  assert.equal(switched.status,200)
  assert.deepEqual(switched.data.messages,messages)
  assert.equal(engine.starts.at(-1).resumeId,remoteId)
  assert.equal(engine.starts.at(-1).historyDirectory,join(homedir(),'.gemini','antigravity-cli'))
  assert.equal(engine.starts.at(-1).env.HOME,join(store,'profiles','agy',isolated.id))
  assert.equal((await call('POST','/engines/agy/profiles',{action:'delete',profileId:isolated.id})).status,409)
})

test('a Claude Code native import uses the native account and persists a compatible account switch',async t=>{
  const {call,dir,store,mount,engine}=await fixture(t,{claude:{defaultProfileId:'two',list:[envProfile('two')]}})
  const remoteId='f0443848-0a19-4084-9e17-07f8cbb3de8a'
  const id=nativeId('claude',remoteId)
  const path='/sessions/'+id
  const messages=[{role:'user',text:'local history'},{role:'assistant',text:'local answer'}]
  engine.imports.push({remoteId,cwd:dir,messages,createdAt:1_800_000_000_000,updatedAt:1_800_000_000_000})
  assert.equal((await call('GET',path)).data.account.id,'default')
  const switched=await call('POST',path+'/account',{profileId:'two'})
  assert.equal(switched.status,200)
  assert.equal(engine.starts.at(-1).resumeId,remoteId)
  assert.deepEqual(switched.data.messages,messages)
  assert.equal(JSON.parse(await readFile(join(store,id+'.json'),'utf8')).profileId,'two')
  mount()
  assert.equal((await call('GET',path)).data.account.id,'two')
})
