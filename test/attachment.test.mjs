import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

test('generic uploads use private session paths, retain previews and preserve native media', async t => {
  const dir = await mkdtemp(join(tmpdir(),'dchat-attachments-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir,{recursive:true,force:true})
  })
  const fixture = `
    import { randomUUID } from 'node:crypto'
    export const calls = []
    export let gate
    export function hold() {
      const entered = Promise.withResolvers()
      const released = Promise.withResolvers()
      gate = { entered, released }
      return gate
    }
    function start({resumeId} = {}) {
      return {id:resumeId ?? randomUUID(),options:[],capabilities:{image:true,audio:true},
        prompt(text,media){calls.push({text,media});return {stopReason:'end_turn'}}, close(){}}
    }
    export const engine = {id:'mock',label:'Mock',start,fork:()=>start(),deleteSession(){},
      async resolvePrompt({text,attachmentCount,adapter}) {
        if (text === '/compact' && attachmentCount) throw Object.assign(Error('Command excludes attachments'),{status:400})
        if (gate && !adapter) {
          const pending = gate
          pending.entered.resolve()
          await pending.released.promise
          gate = undefined
        }
      },
    }
  `
  const modulePath = join(dir,'mock.mjs')
  await writeFile(modulePath,fixture)
  const moduleUrl = pathToFileURL(modulePath).href
  const mock = await import(moduleUrl)
  const { apply } = await import('../index.mjs')
  const { call, dispose } = mount(apply,moduleUrl)
  t.after(dispose)
  const create = () => call('POST','',{engine:'mock',cwd:dir})
  const source = (await create()).data.id
  const sibling = (await create()).data.id
  const upload = (attachments,text='') => call('POST',`/${source}/prompt`,{text,attachments})
  const file = (name,text,mimeType) => ({name,type:'file',mimeType,data:Buffer.from(text).toString('base64')})
  const image = {name:'dot.png',type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9UvxXt8AAAAASUVORK5CYII='}
  const audio = {name:'native.wav',type:'audio',mimeType:'audio/wav',data:'AAEC'}
  const workspaceFile = (id,path) => call('GET',`/${id}/file?path=${encodeURIComponent(path)}`)
  const getAttachment = (id,key) => call('GET',`/${id}/attachment?key=${key}`)
  const getMessages = async (id=source) => (await call('GET',`/${id}`)).data.messages
  const store = join(dir,'direct-chat')
  const media = join(store,'media',source)
  const promptMarker = 'Attached files (local paths):\n'

  assert.equal((await upload([{...file('bad.txt',''),data:'AA=A'}])).status,400)
  assert.equal((await upload([{...image,data:''}])).status,400)
  assert.equal((await upload([file('bad.txt','', 'text/plain\n')])).status,400)
  assert.equal((await upload(Array.from({length:17},(_,index)=>file(`${index}.txt`,'')))).status,400)
  assert.equal((await upload([file('first.bin',Buffer.alloc(8*1024*1024)),file('over.bin','a')])).status,413)
  assert.equal((await upload([file('note.md','fixture')],'/compact')).status,400)
  assert.equal(mock.calls.length,0)
  assert.deepEqual(await getMessages(),[])

  const tempRecord = join(store,source+'.json.tmp')
  await mkdir(tempRecord)
  assert.equal((await upload([file('note.md','rollback fixture'),image])).status,500)
  assert.deepEqual(await getMessages(),[])
  assert.deepEqual(await readdir(media),[])
  await rm(tempRecord,{recursive:true})

  const gate = mock.hold()
  const submitted = upload([file('..\\private\\example\n.md','hello'),file('empty.txt',''),file('fallback.wav',Buffer.from([0,1,2,3]),'audio/wav'),image,audio],'Use these files')
  await gate.entered.promise
  assert.equal((await upload([file('overlap.txt','busy fixture')])).status,409)
  gate.released.resolve()
  assert.equal((await submitted).status,202)
  await setImmediate()
  const [{text,attachments}] = await getMessages()
  assert.equal(text,'Use these files')
  assert.deepEqual(attachments.map(({name,type,mimeType})=>[name,type,mimeType]),[
    ['example_.md','file','application/octet-stream'],['empty.txt','file','application/octet-stream'],
    ['fallback.wav','file','audio/wav'],['dot.png','image','image/png'],['native.wav','audio','audio/wav'],
  ])
  assert.equal(mock.calls.length,1)
  assert.deepEqual(mock.calls[0].media,[image,audio])
  assert.ok(mock.calls[0].text.startsWith('Use these files\n\n'+promptMarker))
  const [reference,empty] = JSON.parse(mock.calls[0].text.split(promptMarker)[1])
  assert.deepEqual(reference,{name:'example_.md',mimeType:'application/octet-stream',path:join(media,attachments[0].previewId+'.md')})
  assert.equal(await readFile(reference.path,'utf8'),'hello')
  assert.equal((await stat(empty.path)).size,0)
  assert.equal((await stat(reference.path)).mode & 0o777,0o600)
  assert.equal((await stat(media)).mode & 0o777,0o700)
  assert.ok(!(await readFile(join(store,source+'.json'),'utf8')).includes(reference.path))
  assert.deepEqual((await getAttachment(source,attachments[0].previewId)).data,{path:'example_.md',text:'hello',truncated:false})
  assert.equal((await getAttachment(source,attachments[1].previewId)).data.text,'')
  assert.equal((await getAttachment(source,attachments[3].previewId)).data.data,image.data)
  assert.equal((await getAttachment(sibling,attachments[0].previewId)).status,404)
  assert.equal((await getAttachment(source,'..')).status,404)
  assert.equal((await workspaceFile(source,reference.path)).data.text,'hello')
  assert.equal((await workspaceFile(sibling,reference.path)).status,403)
  assert.equal((await call('GET',`/${source}/files?path=direct-chat`)).data.entries.some(entry=>entry.name==='media'),false)
  assert.equal((await call('GET',`/${source}/files?path=direct-chat/media/${source}`)).status,403)
  await symlink(reference.path,join(dir,'linked.md'))
  assert.equal((await workspaceFile(sibling,'linked.md')).status,403)

  const mediaQuery = `/media?attachment=${attachments[2].previewId}`
  assert.equal((await getAttachment(source,attachments[2].previewId)).data.mediaKind,'audio')
  const partial = await call('GET',`/${source}${mediaQuery}`,undefined,{range:'bytes=1-2'})
  assert.equal(partial.status,206)
  assert.equal(partial.headers['Content-Type'],'audio/wav')
  assert.deepEqual(partial.data,Buffer.from([1,2]))
  assert.equal((await call('GET',`/${sibling}${mediaQuery}`)).status,404)

  assert.equal((await upload([file('example_.md','second')])).status,202)
  await setImmediate()
  const duplicate = (await getMessages()).at(-1).attachments[0]
  assert.notEqual(duplicate.previewId,attachments[0].previewId)
  assert.equal((await getAttachment(source,duplicate.previewId)).data.text,'second')
  assert.equal((await getAttachment(source,attachments[0].previewId)).data.text,'hello')

  const fork = await call('POST',`/${source}/fork`,{})
  assert.equal(fork.status,201)
  assert.deepEqual(await getMessages(fork.data.id),await getMessages())
  assert.equal((await getAttachment(fork.data.id,attachments[0].previewId)).data.text,'hello')
  const removed = await call('DELETE',`/${source}`,{confirmId:source})
  assert.equal(removed.status,200)
  await assert.rejects(stat(media),{code:'ENOENT'})
  assert.equal((await getAttachment(fork.data.id,attachments[0].previewId)).data.text,'hello')
  dispose()
  const reopened = mount(apply,moduleUrl)
  t.after(reopened.dispose)
  assert.equal((await reopened.call('GET',`/${fork.data.id}/attachment?key=${attachments[0].previewId}`)).data.text,'hello')
})

test('document routes return scoped preview bytes and use the host Office converter', async t => {
  const dir = await mkdtemp(join(tmpdir(),'dchat-documents-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir,{recursive:true,force:true})
  })
  const modulePath = join(dir,'mock.mjs')
  await writeFile(modulePath,`import {randomUUID} from 'node:crypto';
    import {join} from 'node:path';
    export const engine = {id:'mock',label:'Mock',start:()=>({id:randomUUID(),options:[],
      prompt:()=>({stopReason:'end_turn'}),close(){}}),readableRoots:({cwd})=>[join(cwd,'../shared')]};`)
  const workspace = join(dir,'workspace')
  const shared = join(dir,'shared')
  await mkdir(workspace)
  await mkdir(shared)
  const html = '<script>globalThis.testDocumentFixture = true</script>'
  const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF')
  const office = Buffer.from('generated Office test input')
  await writeFile(join(workspace,'example.html'),html)
  await writeFile(join(workspace,'fake.pdf'),html)
  await writeFile(join(workspace,'example.pdf'),pdf)
  await writeFile(join(workspace,'example.csv'),'name,quantity\none,1\n')
  await writeFile(join(workspace,'example.txt'),'plain text')
  await writeFile(join(workspace,'example.docx'),office)
  await writeFile(join(shared,'sample.xlsx'),Buffer.from([0x50,0x4b,0x03,0x04]))
  await writeFile(join(dir,'secret.pptx'),office)
  await symlink(join(dir,'secret.pptx'),join(workspace,'escape.pptx'))

  const converted = []
  let replaceSource = false
  const converter = { async convert({extension,priority,source}, signal) {
    assert.equal(priority,'foreground')
    assert.equal(source.bytes,office.length)
    assert.equal(signal.aborted,false)
    if (replaceSource) await writeFile(join(workspace,'example.docx'),'new Office fixture')
    const input = await source.read(signal, office.length)
    assert.equal(input.version,source.version)
    assert.deepEqual(input.bytes,office)
    converted.push(extension)
    return { pdf }
  }}
  const {apply} = await import('../index.mjs?document-routes-test')
  const moduleUrl = pathToFileURL(modulePath).href
  const {call,dispose} = mount(apply,moduleUrl,converter)
  t.after(dispose)
  const create = async () => (await call('POST','',{engine:'mock',cwd:workspace})).data.id
  const source = await create()
  const sibling = await create()
  const document = (path,headers) => call('GET',`/${source}/document?${new URLSearchParams({path})}`,undefined,headers)
  const metadata = path => call('GET',`/${source}/file?${new URLSearchParams({path})}`)
  assert.deepEqual((await metadata('example.pdf')).data,{path:join(workspace,'example.pdf'),
    documentKind:'pdf',mimeType:'application/pdf',size:pdf.length,truncated:false})
  assert.equal((await metadata('example.html')).data.documentKind,'html')
  assert.equal((await metadata('example.csv')).data.documentKind,'spreadsheet')
  assert.equal((await metadata('example.docx')).data.documentKind,'pdf')
  const htmlResponse = await document('example.html')
  assert.equal(htmlResponse.headers['Content-Type'],'application/octet-stream')
  assert.equal(htmlResponse.headers['Content-Disposition'],'attachment')
  assert.equal(htmlResponse.headers['X-Content-Type-Options'],'nosniff')
  assert.equal(htmlResponse.data.toString(),html)
  assert.equal((await document('example.csv')).data.toString(),'name,quantity\none,1\n')
  assert.deepEqual((await document(pathToFileURL(join(shared,'sample.xlsx')).href)).data,Buffer.from([0x50,0x4b,0x03,0x04]))
  const pdfResponse = await document('example.pdf',{range:'bytes=0-4'})
  assert.equal(pdfResponse.status,206)
  assert.equal(pdfResponse.headers['Content-Type'],'application/pdf')
  assert.equal(pdfResponse.data.toString(),'%PDF-')
  assert.equal((await document('fake.pdf')).status,415)
  assert.equal((await document('example.txt')).status,415)
  assert.equal((await document('escape.pptx')).status,403)
  assert.deepEqual((await document('example.docx')).data,pdf)

  await call('POST',`/${source}/prompt`,{text:'',attachments:[{
    name:'slides.pptx',type:'file',mimeType:'application/octet-stream',data:office.toString('base64'),
  }]})
  await setImmediate()
  const {previewId} = (await call('GET',`/${source}`)).data.messages[0].attachments[0]
  assert.equal((await call('GET',`/${source}/attachment?key=${previewId}`)).data.path,'slides.pptx')
  assert.deepEqual((await call('GET',`/${source}/document?attachment=${previewId}`)).data,pdf)
  assert.equal((await call('GET',`/${sibling}/document?attachment=${previewId}`)).status,404)
  const privatePath = join(dir,'direct-chat','media',source,previewId+'.pptx')
  assert.equal((await call('GET',`/${sibling}/document?${new URLSearchParams({path:privatePath})}`)).status,403)
  assert.deepEqual(converted,['docx','pptx'])
  replaceSource = true
  assert.equal((await document('example.docx')).status,409)
  const unavailable = mount(apply,moduleUrl)
  t.after(unavailable.dispose)
  const noConverter = (await unavailable.call('POST','',{engine:'mock',cwd:workspace})).data.id
  assert.equal((await unavailable.call('GET',`/${noConverter}/document?path=example.docx`)).status,503)
})

function mount(apply,moduleUrl,officeKit) {
  let handler,dispose
  apply({
    effect(fn){dispose=fn()},
    get(name){return name === 'officeKit' ? officeKit : undefined},
    connection:{admit(){return {peer:{principal:{kind:'owner'}}}}},
    webServer:{register(route){handler=route.handler;return ()=>{}}},
  },{engines:[],engineModules:[moduleUrl]})
  return {dispose,async call(method,suffix,body,headers={}) {
    const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []),{
      url:'/api/direct-chat/sessions'+suffix, method, headers:{'content-type':'application/json',...headers},
    })
    const chunks = []
    const res = new Writable({write(chunk,encoding,done){chunks.push(chunk);done()}})
    res.writeHead = (status,headers) => Object.assign(res,{status,headers,headersSent:true})
    await handler(req,res)
    const bytes = Buffer.concat(chunks)
    const data = res.headers?.['Content-Type']?.startsWith('application/json') ? JSON.parse(bytes) : bytes
    return {status:res.status,headers:res.headers,data}
  }}
}
