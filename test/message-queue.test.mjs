import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(),'dchat-queue-'))
  const env = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async ()=>{
    if (env === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = env
    await rm(dir,{recursive:true,force:true})
  })
  const path = join(dir,'engine.mjs')
  await writeFile(path,`
    import { randomUUID } from 'node:crypto'
    export const turns = [], steering = [], cancellations = [], validations = []
    export const engine = { id:'fixture',label:'Fixture',resolvePrompt({text}) {
      if (text === '/compact') return {name:'compact'}
      if (text.startsWith('/compact ')) throw Object.assign(Error('/compact does not accept arguments'),{status:400})
      if (text === 'slow edit') {
        const result = Promise.withResolvers()
        validations.push(result)
        return result.promise
      }
    },start({resumeId,emit}){
      let current
      return {id:resumeId || randomUUID(),options:[],capabilities:{image:true},
        prompt(text,media){
          const result = Promise.withResolvers()
          const chunk = text => emit('update',{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}})
          current = {text,media,chunk,...result}
          turns.push(current)
          return result.promise
        },
        steer(text,media,accepted) {
          const result = Promise.withResolvers()
          steering.push({text,media,accepted,...result})
          return result.promise
        },
        cancel(){
          const result = Promise.withResolvers()
          cancellations.push(result)
          current.resolve({stopReason:'cancelled'})
          return result.promise
        },
        close(){},
      }
    }}
  `)
  const moduleURL = pathToFileURL(path).href
  const engine = await import(moduleURL)
  const {apply} = await import(`../index.mjs?${dir}`)
  const store = join(dir,'direct-chat')
  function mount() {
    let handler,dispose
    const streams = new Set()
    apply({
      effect(fn){dispose=fn()},
      connection:{admit(){return {peer:{principal:{kind:'owner'}}}}},
      webServer:{register(route){handler=route.handler;return ()=>{}}},
    },{engines:[],engineModules:[moduleURL]})
    function unmount() {
      for (const stream of streams) stream.emit('close')
      streams.clear()
      dispose()
    }
    t.after(unmount)
    async function call(method,suffix,data) {
      const req = Object.assign(Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []),{
        method,url:'/api/direct-chat/sessions'+suffix,headers:{'content-type':'application/json'},
      })
      const res = Object.assign(new EventEmitter(),{
        chunks:[],
        writeHead(status,headers){Object.assign(this,{status,headers,headersSent:true})},
        write(value){this.chunks.push(value)},
        end(value){this.data=Buffer.isBuffer(value) ? value : value && JSON.parse(value)},
      })
      await handler(req,res)
      return res
    }
    function session(id) {
      return {
        id,
        async view(){return (await call('GET','/'+id)).data},
        async events(){
          const stream=await call('GET','/'+id+'/events')
          streams.add(stream)
          return ()=>stream.chunks.filter(chunk=>chunk.startsWith('data:')).map(chunk=>JSON.parse(chunk.slice(6)))
        },
        send(text,delivery,attachments,clientRequestId){return call('POST','/'+id+'/prompt',{text,delivery,attachments,clientRequestId})},
        queue(action,idOfItem,text){return call('POST','/'+id+'/queue',{action,id:idOfItem,text})},
        image(item,index){return call('GET','/'+id+'/queue-image?'+new URLSearchParams({item,index}))},
        stop(){return call('POST','/'+id+'/cancel',{})},
      }
    }
    return {unmount,session,async start(draft){
      const {status,data} = await call('POST','',{engine:'fixture',cwd:dir,draft})
      assert.equal(status,201)
      return session(data.id)
    }}
  }
  return {engine,store,mount}
}

const upload = {name:'note.txt',type:'file',mimeType:'text/plain',data:'aGVsbG8='}
const image = {name:'dot.png',type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9UvxXt8AAAAASUVORK5CYII='}
const pause = () => setImmediate()

test('queue publishes pending metadata, removes rows and follows Stop in FIFO order', async t=>{
  const {engine,store,mount} = await fixture(t)
  const session = await mount().start()
  assert.equal((await session.send('first')).status,202)
  const events = await session.events()
  const bytes = join(store,'media',session.id)
  assert.equal((await session.send('second','queue',[upload])).status,202)
  assert.equal((await session.send('remove','queue',[upload])).status,202)
  assert.equal((await session.send('third','queue')).status,202)
  const queued = (await session.view()).queue
  assert.deepEqual(queued.map(row=>row.text),['second','remove','third'])
  assert.deepEqual(queued[0].attachments,[{name:'note.txt',type:'file',mimeType:'text/plain',bytes:5}])
  assert.equal((await readdir(bytes)).length,2)
  assert.equal((await session.queue('remove',queued[1].id)).status,200)
  assert.equal((await readdir(bytes)).length,1)
  assert.deepEqual(events().at(-1).data.queue.map(row=>row.text),['second','third'])
  assert.ok(events().every(event=>!JSON.stringify(event).includes(upload.data)))
  assert.equal((await session.send('legacy while busy')).status,409)

  const stopped = session.stop()
  await pause()
  assert.equal(engine.cancellations.length,1)
  assert.equal(engine.turns.length,1)
  engine.cancellations[0].resolve()
  assert.equal((await stopped).status,200)
  await pause()
  assert.equal(engine.turns.length,2)
  const second = engine.turns[1]
  const [reference] = JSON.parse(second.text.split('\n').at(-1))
  assert.equal(await readFile(reference.path,'utf8'),'hello')
  assert.equal((await readdir(bytes)).length,1)
  assert.deepEqual((await session.view()).queue.map(row=>row.text),['third'])
  second.resolve({stopReason:'end_turn'})
  await pause()
  assert.equal(engine.turns[2].text,'third')
  engine.turns[2].resolve({stopReason:'end_turn'})
  await pause()
  const completed = await session.view()
  assert.deepEqual(completed.messages.map(row=>row.text),['first','second','third'])
  assert.deepEqual(completed.queue,[])
  assert.equal(completed.queuePaused,false)
})

test('queued steering waits for acknowledgement and leaves rejected messages pending', async t=>{
  const {engine,mount} = await fixture(t)
  const session = await mount().start()
  await session.send('first')
  engine.turns[0].chunk('before')
  await session.send('queued steering','queue')
  const {id} = (await session.view()).queue[0]
  const rejected = session.queue('steer',id)
  await pause()
  assert.equal(engine.steering.length,1)
  assert.equal((await session.queue('remove',id)).status,409)
  engine.steering[0].reject(Object.assign(Error('Turn rejected steering'),{status:409}))
  assert.equal((await rejected).status,409)
  assert.equal((await session.view()).queue[0].id,id)
  assert.equal((await session.view()).queuePaused,false)

  const steered = session.queue('steer',id)
  await pause()
  assert.equal(engine.steering.length,2)
  assert.deepEqual((await session.view()).messages.map(row=>row.text),['first','before'])
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
  assert.equal((await session.view()).busy,true)
  engine.steering[1].resolve()
  assert.equal((await steered).status,200)
  await pause()
  assert.equal((await session.queue('steer',id)).data.code,'queue_entered_chat')
  assert.equal((await session.queue('remove',id)).data.code,'queue_entered_chat')
  assert.equal(engine.steering.length,2)
  assert.equal(engine.steering[1].text,'queued steering')
  assert.equal(engine.turns.length,1)
  assert.deepEqual((await session.view()).messages.map(row=>row.text),['first','before','queued steering'])
  assert.equal((await session.view()).busy,false)
  assert.deepEqual((await session.view()).queue,[])
  assert.equal((await session.send('steering while idle','steer')).status,409)
})

test('native acceptance removes the queued message and splits streamed replies immediately', async t=>{
  const {engine,mount} = await fixture(t)
  const session = await mount().start()
  await session.send('first')
  engine.turns[0].chunk('before')
  const events = await session.events()
  await session.send('follow-up','queue')
  const {id} = (await session.view()).queue[0]
  const delivery = session.queue('steer',id)
  await pause()
  engine.steering[0].accepted()
  const accepted = events().at(-1)
  assert.equal(accepted.type,'snapshot')
  assert.deepEqual(accepted.data.queue,[])
  assert.equal(accepted.data.messages.at(-1).queueItemId,id)
  engine.turns[0].chunk('after')
  assert.deepEqual((await session.view()).messages.map(row=>row.text),['first','before','follow-up','after'])
  engine.steering[0].resolve()
  await delivery
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
  assert.equal((await session.view()).messages.length,4)
})

test('queued edits validate commands and preserve identity, ordering and attachments', async t=>{
  const {engine,store,mount} = await fixture(t)
  const session = await mount().start()
  await session.send('active')
  const clientRequestId = randomUUID()
  const events = await session.events()
  assert.equal((await session.send('invalid id','queue',undefined,'bad-id')).status,400)
  const queued = await session.send('pending','queue',undefined,clientRequestId)
  assert.equal(queued.status,202)
  const [item] = queued.data.queue
  assert.equal(item.clientRequestId,clientRequestId)
  assert.equal(events().at(-1).data.queue[0].clientRequestId,clientRequestId)
  const withFile = (await session.send('with file','queue',[upload])).data.queue[1]
  assert.equal((await session.queue('edit',withFile.id,'edited attachment')).status,409)
  assert.equal((await session.queue('edit',item.id,'   ')).status,400)
  assert.equal((await session.queue('edit',item.id,'/compact with arguments')).status,400)
  const slow = session.queue('edit',item.id,'slow edit')
  await pause()
  const fast = await session.queue('edit',item.id,'edited')
  assert.equal(fast.status,200)
  engine.validations[0].resolve()
  assert.equal((await slow).status,409)
  const expected = [{...item,text:'edited'},withFile]
  assert.deepEqual(fast.data.queue,expected)
  assert.deepEqual(events().at(-1).data.queue,expected)
  assert.deepEqual(JSON.parse(await readFile(join(store,session.id+'.json'),'utf8')).queue,expected)
  await session.queue('remove',withFile.id)
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
  assert.equal(engine.turns[1].text,'edited')
  assert.equal((await session.queue('edit',item.id,'too late')).status,404)
  engine.turns[1].resolve({stopReason:'end_turn'})
  await pause()
})

test('queue image previews serve signed images scoped to a pending session item', async t=>{
  const {engine,mount} = await fixture(t)
  const host = mount()
  const session = await host.start()
  const other = await host.start()
  await session.send('first')
  const fakeImage = {...image,mimeType:'image/jpeg'}
  const svg = {name:'svg.svg',type:'image',mimeType:'image/svg+xml',data:Buffer.from('<svg/>').toString('base64')}
  const sent = await session.send('pending','queue',[upload,image,fakeImage,svg])
  assert.equal(sent.status,202)
  const [item] = sent.data.queue
  const bytes = Buffer.from(image.data,'base64')
  assert.equal(item.attachments[1].bytes,bytes.length)
  assert.equal(JSON.stringify(item).includes(image.data),false)
  assert.equal((await session.image(item.id,0)).status,404)
  assert.equal((await other.image(item.id,1)).status,404)
  assert.equal((await session.image(item.id,'01')).status,404)
  assert.equal((await session.image(item.id,4)).status,404)
  assert.equal((await session.image(item.id,2)).status,415)
  assert.equal((await session.image(item.id,3)).status,415)
  const preview = await session.image(item.id,1)
  assert.equal(preview.status,200)
  assert.deepEqual(preview.headers,{
    'Content-Type':'image/png','Content-Length':bytes.length,
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
  })
  assert.deepEqual(preview.data,bytes)
  await session.queue('remove',item.id)
  assert.equal((await session.image(item.id,1)).status,404)
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
})

test('steer-all sends the pending snapshot in FIFO order and commits each acknowledgement', async t=>{
  const {engine,mount} = await fixture(t)
  const session = await mount().start()
  await session.send('active')
  await session.send('first','queue')
  const {id} = (await session.send('second','queue')).data.queue[1]
  const result = session.queue('steer-all')
  await pause()
  assert.deepEqual(engine.steering.map(row=>row.text),['first'])
  assert.equal((await session.queue('steer-all')).status,409)
  assert.equal((await session.queue('edit',id,'changed')).status,409)
  assert.equal((await session.queue('remove',id)).status,409)
  await session.send('queued during steering','queue')
  engine.steering[0].resolve()
  await pause()
  assert.deepEqual(engine.steering.map(row=>row.text),['first','second'])
  assert.deepEqual((await session.view()).messages.map(row=>row.text),['active','first'])
  engine.steering[1].resolve()
  assert.equal((await result).status,200)
  assert.deepEqual((await session.view()).queue.map(row=>row.text),['queued during steering'])
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
  assert.equal(engine.turns[1].text,'queued during steering')
  engine.turns[1].resolve({stopReason:'end_turn'})
  await pause()
})

test('steer-all retains unacknowledged input when the active turn ends', async t=>{
  const {engine,mount} = await fixture(t)
  const session = await mount().start()
  await session.send('active')
  await session.send('acknowledged','queue')
  await session.send('still pending','queue')
  const result = session.queue('steer-all')
  await pause()
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
  engine.steering[0].resolve()
  assert.equal((await result).status,409)
  await pause()
  assert.deepEqual(engine.steering.map(row=>row.text),['acknowledged'])
  const view = await session.view()
  assert.deepEqual(view.messages.map(row=>row.text),['active','acknowledged'])
  assert.deepEqual(view.queue.map(row=>row.text),['still pending'])
  assert.equal(view.queuePaused,true)
  assert.equal(engine.turns.length,1)
  assert.equal((await session.queue('steer-all')).status,409)
  assert.equal((await session.queue('resume')).status,202)
  await pause()
  assert.equal(engine.turns[1].text,'still pending')
  engine.turns[1].resolve({stopReason:'end_turn'})
  await pause()
})

test('steer-all retains the rejected message and its successors', async t=>{
  const {engine,mount} = await fixture(t)
  const session = await mount().start()
  await session.send('active')
  for (const text of ['accepted','rejected','untouched']) await session.send(text,'queue')
  const result = session.queue('steer-all')
  await pause()
  engine.steering[0].resolve()
  await pause()
  engine.steering[1].reject(Object.assign(Error('Turn rejected steering'),{status:409}))
  assert.equal((await result).status,409)
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
  const view = await session.view()
  assert.deepEqual(engine.steering.map(row=>row.text),['accepted','rejected'])
  assert.deepEqual(view.messages.map(row=>row.text),['active','accepted'])
  assert.deepEqual(view.queue.map(row=>row.text),['rejected','untouched'])
  assert.equal(view.queuePaused,true)
  assert.equal(engine.turns.length,1)
})

test('steer-all stops before a native command and leaves the remaining queue paused', async t=>{
  const {engine,mount} = await fixture(t)
  const session = await mount().start()
  await session.send('active')
  await session.send('/compact','queue')
  await session.send('following','queue')
  assert.equal((await session.queue('steer-all')).status,409)
  assert.equal(engine.steering.length,0)
  engine.turns[0].resolve({stopReason:'end_turn'})
  await pause()
  assert.equal(engine.turns.length,1)
  const view = await session.view()
  assert.deepEqual(view.queue.map(row=>row.text),['/compact','following'])
  assert.equal(view.queuePaused,true)
})

test('direct steering uses the selected session and forwards native media', async t=>{
  const {engine,mount} = await fixture(t)
  const host = mount()
  const first = await host.start()
  const second = await host.start()
  await first.send('one')
  await second.send('two')
  const pushed = second.send('','steer',[image])
  await pause()
  assert.equal(engine.steering[0].text,'')
  assert.deepEqual(engine.steering[0].media,[image])
  engine.steering[0].resolve()
  assert.equal((await pushed).status,202)
  engine.turns[1].chunk('after')
  assert.equal((await first.view()).messages.length,1)
  const {messages} = await second.view()
  assert.deepEqual(messages.map(row=>[row.role,row.text]),[['user','two'],['user',''],['assistant','after']])
  assert.equal(messages[1].attachments[0].name,'dot.png')
  assert.ok(messages[1].attachments[0].previewId)
  engine.turns.forEach(turn=>turn.resolve({stopReason:'end_turn'}))
  await pause()
})

test('pending queue survives host restart and turn failure until explicit resume', async t=>{
  const {engine,mount} = await fixture(t)
  const original = mount()
  const session = await original.start(true)
  assert.equal((await session.send('first','queue')).status,202)
  await pause()
  assert.equal(engine.turns[0].text,'first')
  await session.send('after restart','queue',[upload])
  original.unmount()
  const recovered = mount().session(session.id)
  assert.equal((await recovered.view()).queuePaused,true)
  await pause()
  assert.equal(engine.turns.length,1)
  assert.equal((await recovered.queue('resume')).status,202)
  await pause()
  assert.ok(engine.turns[1].text.startsWith('after restart'))
  await recovered.send('after failure','queue')
  engine.turns[1].reject(Error('Fixture turn failure'))
  await pause()
  assert.equal(engine.turns.length,2)
  assert.equal((await recovered.view()).queuePaused,true)
  assert.deepEqual((await recovered.view()).queue.map(row=>row.text),['after failure'])
  assert.equal((await recovered.queue('resume')).status,202)
  await pause()
  assert.equal(engine.turns[2].text,'after failure')
  engine.turns[2].resolve({stopReason:'end_turn'})
  await pause()
  assert.deepEqual((await recovered.view()).queue,[])
})
