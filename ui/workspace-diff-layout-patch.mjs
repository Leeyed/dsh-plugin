import { createHash, randomUUID } from 'node:crypto'
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Script } from 'node:vm'

const packageName = '@deepseek-ai/dsh-client-ui-layout'
const version = '0.2.2-rc.5'
const checksum = 'dfbc793b4147fd695fdb2a57c0982d73c668e57493f609945d5d04fb36fdd48e'
const slot = 'rightbar.direct-chat'

function replaceOnce(source, search, replacement) {
  const index = source.indexOf(search)
  if (index < 0 || source.indexOf(search, index + search.length) !== -1) {
    throw new Error('Unexpected rightbar layout patch point: ' + search)
  }
  return source.replace(search, () => replacement)
}

function patch(source) {
  if (createHash('sha256').update(source).digest('hex') !== checksum) {
    throw new Error(`Unexpected ${packageName}@${version} browser bundle`)
  }
  const declaration = '"rightbar":{kind:`single`,scope:`root`},'
  const owner = '{width:normal.rightbar,viewportWidth:viewport,canShow:normal.rightbar>0}'
  const current = 'renderSlot(`rightbar`,' + owner + ')'
  const pane = `renderSlot(\`${slot}\`,${owner})`
  const patched = replaceOnce(
    replaceOnce(source, declaration, declaration + `"${slot}":{kind:\`single\`,scope:\`root\`},`),
    current,
    `(0,react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment,{children:[${current},${pane}]})`,
  ).replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '\n')
  new Script(patched)
  return patched
}

async function install(path, contents, mode) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode })
    await chmod(temporary, mode)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function main([action, root]) {
  if (!root || !['check', 'apply', 'restore'].includes(action)) {
    throw new Error('Usage: node ui/workspace-diff-layout-patch.mjs <check|apply|restore> <layout package path>')
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== packageName || manifest.version !== version) throw new Error(`Expected ${packageName}@${version}`)
  const path = join(root, 'lib', 'client.js')
  const backupPath = path + '.before-direct-chat-rightbar'
  const current = await readFile(path, 'utf8')
  const backup = await readFile(backupPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  const original = backup ?? current
  const patched = patch(original)
  if (current !== original && current !== patched) throw new Error('Unexpected changes to the layout browser bundle')

  const mode = (await stat(path)).mode & 0o777
  if (action === 'apply' && current !== patched) {
    if (!backup) {
      await writeFile(backupPath, original, { flag: 'wx', mode })
      await chmod(backupPath, mode)
    }
    await install(path, patched, mode)
    console.log('Applied the workspace rightbar slot patch')
  } else if (action === 'restore' && current === patched) {
    await install(path, original, mode)
    console.log('Restored the published layout bundle')
  } else {
    console.log(current === patched ? 'Workspace rightbar slot patch is installed' : 'Published layout bundle verified')
  }
}

await main(process.argv.slice(2))
