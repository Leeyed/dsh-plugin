import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { agyDataDirectory, migrateAgySharedHistory, prepareAgySessionDirectory } from '../server/agy-session-history.mjs'

const conversationId='12345678-0000-4000-8000-000000000000'
const token='antigravity-oauth-token'
const summaries='conversation_summaries.db'

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'direct-chat-agy-history-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const historyHome=join(root,'history')
  const accountHome=join(root,'account')
  const historyDirectory=agyDataDirectory(historyHome)
  const accountDirectory=agyDataDirectory(accountHome)
  const runtimeDirectory=join(root,'runtime')
  mkdirSync(join(historyDirectory,'conversations'),{recursive:true})
  mkdirSync(accountDirectory,{recursive:true})
  const db=new DatabaseSync(join(historyDirectory,summaries))
  t.after(()=>db.close())
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY)')
  db.prepare('INSERT INTO conversation_summaries VALUES (?)').run(conversationId)
  const conversation=new DatabaseSync(join(historyDirectory,'conversations',conversationId+'.db'))
  conversation.close()
  return {root,historyHome,historyDirectory,accountHome,accountDirectory,runtimeDirectory,db}
}

test('AGY resumes from one history store while selected account credentials remain separate',t=>{
  const {historyDirectory,accountHome,accountDirectory,runtimeDirectory,db}=fixture(t)
  writeFileSync(join(historyDirectory,token),'original fixture account')
  writeFileSync(join(accountDirectory,'settings.json'),'{}')
  const options={historyDirectory,runtimeDirectory,env:{HOME:accountHome},resumeId:conversationId}
  prepareAgySessionDirectory(options)
  assert.equal(prepareAgySessionDirectory(options),runtimeDirectory)
  assert.equal(lstatSync(runtimeDirectory).mode&0o777,0o700)
  // The default account can start through the keyring with no credential file.
  assert.equal(lstatSync(join(runtimeDirectory,token)).isSymbolicLink(),true)
  assert.throws(()=>readFileSync(join(runtimeDirectory,token)),{code:'ENOENT'})
  writeFileSync(join(runtimeDirectory,token),'selected fixture account',{mode:0o600})
  assert.equal(readFileSync(join(accountDirectory,token),'utf8'),'selected fixture account')
  assert.equal(readFileSync(join(historyDirectory,token),'utf8'),'original fixture account')
  assert.equal(realpathSync(join(runtimeDirectory,'cache')),join(accountDirectory,'cache'))
  assert.equal(realpathSync(join(runtimeDirectory,'settings.json')),join(accountDirectory,'settings.json'))
  const alias=new DatabaseSync(join(runtimeDirectory,summaries))
  t.after(()=>alias.close())
  assert.equal(alias.prepare('SELECT COUNT(*) AS count FROM conversation_summaries').get().count,1)
  alias.prepare('INSERT INTO conversation_summaries VALUES (?)').run('new native subagent')
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM conversation_summaries').get().count,2)
  assert.equal(lstatSync(join(runtimeDirectory,summaries+'-wal'),{throwIfNoEntry:false}),undefined)
  assert.equal(realpathSync(join(runtimeDirectory,'brain')),join(historyDirectory,'brain'))
  assert.equal(realpathSync(join(runtimeDirectory,'conversations',conversationId+'.db')),join(historyDirectory,'conversations',conversationId+'.db'))
})

test('AGY checks that the original native conversation exists and rejects conflicting link targets',t=>{
  const {root,historyDirectory,accountHome,runtimeDirectory,db}=fixture(t)
  const options={historyDirectory,runtimeDirectory,env:{HOME:accountHome},resumeId:conversationId}
  db.prepare('DELETE FROM conversation_summaries WHERE conversation_id = ?').run(conversationId)
  assert.throws(()=>prepareAgySessionDirectory(options),{status:409})
  assert.equal(lstatSync(runtimeDirectory,{throwIfNoEntry:false}),undefined)
  db.prepare('INSERT INTO conversation_summaries VALUES (?)').run(conversationId)
  mkdirSync(runtimeDirectory)
  symlinkSync(root,join(runtimeDirectory,token))
  assert.throws(()=>prepareAgySessionDirectory(options),/unexpected entry/)
})

test('migrateAgySharedHistory merges legacy isolated sessions into native AGY store and links them', t => {
  const root = mkdtempSync(join(tmpdir(), 'direct-chat-agy-migrate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const nativeAgy = agyDataDirectory(join(root, 'native'))
  const isolatedAgy = agyDataDirectory(join(root, 'isolated'))
  mkdirSync(join(nativeAgy, 'conversations'), { recursive: true })
  mkdirSync(join(isolatedAgy, 'conversations'), { recursive: true })
  mkdirSync(join(isolatedAgy, 'brain', 'old-conv'), { recursive: true })
  writeFileSync(join(nativeAgy, 'conversations', 'shared.db'), 'native-newer')
  writeFileSync(join(isolatedAgy, 'conversations', 'shared.db'), 'isolated-older')
  writeFileSync(join(isolatedAgy, 'conversations', 'legacy-only.db'), 'legacy')
  writeFileSync(join(isolatedAgy, 'brain', 'old-conv', 'note.md'), 'note')

  const nativeDb = new DatabaseSync(join(nativeAgy, summaries))
  nativeDb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT)')
  nativeDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('shared', 'Native Title')
  nativeDb.close()

  const isoDb = new DatabaseSync(join(isolatedAgy, summaries))
  isoDb.exec('CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, title TEXT)')
  isoDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('shared', 'Old Title')
  isoDb.prepare('INSERT INTO conversation_summaries VALUES (?, ?)').run('legacy-only', 'Legacy Title')
  isoDb.close()

  const link = (src, dst) => { if (!lstatSync(dst, { throwIfNoEntry: false })) symlinkSync(src, dst) }
  migrateAgySharedHistory(nativeAgy, isolatedAgy, link)

  assert.equal(readFileSync(join(nativeAgy, 'conversations', 'shared.db'), 'utf8'), 'native-newer')
  assert.equal(readFileSync(join(nativeAgy, 'conversations', 'legacy-only.db'), 'utf8'), 'legacy')
  assert.equal(readFileSync(join(nativeAgy, 'brain', 'old-conv', 'note.md'), 'utf8'), 'note')
  assert.ok(lstatSync(join(isolatedAgy, 'conversations')).isSymbolicLink())
  assert.ok(lstatSync(join(isolatedAgy, summaries)).isSymbolicLink())

  const verifyDb = new DatabaseSync(join(nativeAgy, summaries), { readOnly: true })
  const rows = verifyDb.prepare('SELECT conversation_id, title FROM conversation_summaries ORDER BY conversation_id').all().map(r => ({ ...r }))
  verifyDb.close()
  assert.deepEqual(rows, [
    { conversation_id: 'legacy-only', title: 'Legacy Title' },
    { conversation_id: 'shared', title: 'Native Title' },
  ])

  // Idempotent on second run.
  migrateAgySharedHistory(nativeAgy, isolatedAgy, link)
  assert.ok(lstatSync(join(isolatedAgy, 'conversations')).isSymbolicLink())
})
