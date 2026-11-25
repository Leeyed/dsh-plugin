import { createHash, randomUUID } from 'node:crypto'
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Script } from 'node:vm'

const packageName = '@deepseek-ai/dsh-client-ui-conversation'
const version = '0.2.2-rc.5'
const checksum = '3d166eab312749bf8c528dd7d26d95340df75a27fec668b3510e4558fe9b343b'
const slot = 'conversation.hero.engine'

function replaceOnce(source, search, replacement) {
  const index = source.indexOf(search)
  if (index < 0 || source.indexOf(search, index + search.length) !== -1) {
    throw new Error('Unexpected conversation hero patch point: ' + search)
  }
  return source.replace(search, () => replacement)
}

function patch(source) {
  if (createHash('sha256').update(source).digest('hex') !== checksum) {
    throw new Error(`Unexpected ${packageName}@${version} browser bundle`)
  }

  const headlineStart = source.indexOf('(0,react_jsx_runtime.jsxs)(`div`,{className:HeroShell_module_css_default.headline,')
  const headlineEnd = source.indexOf(',(0,react_jsx_runtime.jsx)(`div`,{className:HeroShell_module_css_default.body})', headlineStart)
  if (headlineStart < 0 || headlineEnd < 0) throw new Error('Missing the native conversation hero headline')
  const headline = source.slice(headlineStart, headlineEnd)
  const renderStart = 'function HeroShell({t,renderSlot,children}){const[hovering,setHovering]=(0,react.useState)(false);'
  const replacements = [
    ['"conversation.hero.brand.mark":{kind:`single`,scope:`root`},',
      `"${slot}":{kind:\`single\`,scope:\`root\`},"conversation.hero.brand.mark":{kind:\`single\`,scope:\`root\`},`],
    [headline, `engineChooser?renderSlot(\`${slot}\`,{cwd:engineCwd,headline:(0,react_jsx_runtime.jsxs)(\`span\`,headline.props)},{fallback:headline}):headline`],
    [renderStart, 'function HeroShell({t,renderSlot,children,engineChooser,engineCwd}){const[hovering,setHovering]=(0,react.useState)(false);'
      + `const headline=${headline};`],
    ['HeroShell,{t,renderSlot}',
      'HeroShell,{t,renderSlot,engineChooser:props.variant!==`embedded`,engineCwd:pendingWorkspace?.path??sessionWorkspace?.path??cwd}'],
  ]
  const patched = replacements.reduce((bundle, [before, after]) => replaceOnce(bundle, before, after), source)
    .replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '\n')
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
    throw new Error('Usage: node ui/conversation-hero-patch.mjs <check|apply|restore> <conversation package path>')
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== packageName || manifest.version !== version) throw new Error(`Expected ${packageName}@${version}`)

  const path = join(root, 'lib', 'client.js')
  const backupPath = path + '.before-direct-chat-hero'
  const current = await readFile(path, 'utf8')
  const backup = await readFile(backupPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  const original = backup ?? current
  const patched = patch(original)
  if (current !== original && current !== patched) throw new Error('Unexpected changes to the conversation browser bundle')

  const mode = (await stat(path)).mode & 0o777
  if (action === 'apply' && current !== patched) {
    if (!backup) {
      await writeFile(backupPath, original, { flag: 'wx', mode })
      await chmod(backupPath, mode)
    }
    await install(path, patched, mode)
    console.log('Applied the conversation hero slot patch')
  } else if (action === 'restore' && current === patched) {
    await install(path, original, mode)
    console.log('Restored the published conversation bundle')
  } else {
    console.log(current === patched ? 'Conversation hero slot patch is installed' : 'Published conversation bundle verified')
  }
}

await main(process.argv.slice(2))
