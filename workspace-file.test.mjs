import assert from 'node:assert/strict'
import {Writable} from 'node:stream'
import {test} from 'node:test'
import {mkdtemp, mkdir, rm, writeFile, symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {listWorkspaceDirectory,openMediaFile,sendMedia,previewFile} from './workspace-file.mjs'

test('workspace preview handles text, links, file boundaries and partial UTF-8',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'dsh-file-preview-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const root=join(dir,'root')
  await mkdir(root)
  await writeFile(join(root,'notes.md'),'一\n二\n')
  await symlink('notes.md',join(root,'link.md'))
  const data=await previewFile(root,join(root,'link.md'))
  assert.deepEqual(data,{path:join(root,'notes.md'),text:'一\n二\n',truncated:false})
  await writeFile(join(dir,'outside'),'outside')
  await symlink('../outside',join(root,'escape'))
  await assert.rejects(previewFile(root,'escape'),{status:403})
  await assert.rejects(previewFile(root,'../outside'),{status:403})
  const brain=join(dir,'brain')
  await mkdir(brain)
  await writeFile(join(brain,'plan.md'),'# Plan\n')
  assert.deepEqual(
    await previewFile(root, pathToFileURL(join(brain,'plan.md')).href, { allowedRoots: [brain] }),
    { path: join(brain,'plan.md'), text: '# Plan\n', truncated: false },
  )
  await assert.rejects(previewFile(root,'absent'),{status:404})
  await assert.rejects(previewFile(root,'.'),{status:415})
  await writeFile(join(root,'binary'),Buffer.from([0,42]))
  await assert.rejects(previewFile(root,'binary'),{status:415})
  await writeFile(join(root,'large'),'文'.repeat(200000))
  const large=await previewFile(root,'large')
  assert.equal(large.truncated,true)
  assert.equal(large.text,'文'.repeat(Math.floor(512*1024/3)))
  await writeFile(join(root,'sample.mp4'),Buffer.from([0,0,0,24,102,116,121,112]))
  assert.deepEqual(await previewFile(root,'sample.mp4'),{path:join(root,'sample.mp4'),mimeType:'video/mp4',mediaKind:'video',size:8,truncated:false})
  await writeFile(join(root,'sample.mp3'),Buffer.from([73,68,51,4,0,0]))
  assert.deepEqual(await previewFile(root,'sample.mp3'),{path:join(root,'sample.mp3'),mimeType:'audio/mpeg',mediaKind:'audio',size:6,truncated:false})
  const media=await openMediaFile(root,'sample.mp4')
  await media.handle.close()
  assert.equal(media.mimeType,'video/mp4')
  assert.equal(media.size,8)
})

test('directory browser lists scoped files and refuses directory escapes', async t => {
  const dir = await mkdtemp(join(tmpdir(),'dsh-file-tree-'))
  t.after(() => rm(dir,{ recursive:true, force:true }))
  const root = join(dir,'root')
  await mkdir(join(root,'src'),{recursive:true})
  await writeFile(join(root,'a.md'),'# readme')
  await symlink(dir,join(root,'outside'))
  assert.deepEqual(await listWorkspaceDirectory(root),{path:'',truncated:false,entries:[
    {name:'src',path:'src',directory:true},{name:'a.md',path:'a.md',directory:false},
  ]})
  assert.deepEqual(await listWorkspaceDirectory(root,'src'),{path:'src',entries:[],truncated:false})
  for (const path of ['..','outside']) await assert.rejects(listWorkspaceDirectory(root,path),{status:403})
  await assert.rejects(listWorkspaceDirectory(root,'a.md'),{status:404})
})

test('media delivery supports whole files, suffix ranges and unsatisfiable ranges', async t => {
  const root = await mkdtemp(join(tmpdir(),'dsh-media-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  await writeFile(join(root,'clip.mp4'),'abcdefgh')
  for (const [header,status,body,contentRange] of [
    [undefined,200,'abcdefgh'], ['bytes=-3',206,'fgh','bytes 5-7/8'],
    ['bytes=2-',206,'cdefgh','bytes 2-7/8'], ['bytes=2-4',206,'cde','bytes 2-4/8'],
    ['bytes=9-',416,'','bytes */8'], ['bytes=-0',416,'','bytes */8'],
  ]) {
    const media = await openMediaFile(root,'clip.mp4')
    const chunks=[]
    const response=new Writable({ write(chunk, encoding, callback) { chunks.push(chunk); callback() } })
    response.writeHead=(code,headers) => { assert.equal(code,status); assert.equal(headers['Content-Range'],contentRange) }
    await sendMedia(response,media,header)
    assert.equal(Buffer.concat(chunks).toString(),body)
    assert.equal(media.handle.fd,-1)
  }
})
