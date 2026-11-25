import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Script } from 'node:vm'

const version = '0.2.2-rc.5'
const packageName = '@deepseek-ai/dsh-client-ui-workspace'
const checksum = '3ff4116dc91b7dc5cc57e7672e0d7935f992b339be3444a7a72992df218765ba'
const previousChecksum = '1b314b220f568640e9c472d8439280eb01a7976ffbe0fcbe92a93505117f32bb'
const toolbar = 'sidebar.workspaces.external-sessions'
const projection = 'sidebar.workspaces.direct-chat-projection'
const hash = source => createHash('sha256').update(source).digest('hex')

function replaceOnce(source, before, after) {
  const index = source.indexOf(before)
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error('Unexpected workspace browser patch point: ' + before)
  }
  return source.replace(before, () => after)
}

function projectWorkspaceList(source) {
  const start = source.indexOf('(0,react_jsx_runtime.jsx)(`div`,{ref:wide?bindScrollerRef:')
  const end = source.indexOf(',workspaceActionRequest!==null', start)
  if (start < 0 || end < 0) throw new Error('Missing the native workspace list')
  const body = source.slice(start, end)
  const changes = [
    ['FlatList,{useSessionAccess,', 'FlatList,{extension,useSessionAccess,'],
    ['SessionTree,{useSessionAccess,', 'SessionTree,{extension,useSessionAccess,'],
    ['setGroupExpanded:actions.setGroupExpanded,',
      'setGroupExpanded:(key,expanded)=>{if(!extension?.expandGroup(key,expanded))actions.setGroupExpanded(key,expanded)},'],
  ]
  const projected = changes.reduce((value, [before, after]) => replaceOnce(value, before, after), body)
  const root = 'return(0,react_jsx_runtime.jsxs)(`div`,{className:clsx(WorkspaceBrowser_module_css_default.root,'
  source = replaceOnce(source, root, `const renderWorkspaceList=extension=>${projected};${root}`)
  return replaceOnce(source, body,
    'wide&&normalizedQuery===``?' +
    `renderSlot(\`${projection}\`,{render:renderWorkspaceList},{fallback:renderWorkspaceList()}):renderWorkspaceList()`)
}

function patch(source) {
  if (hash(source) !== checksum) {
    throw new Error(`Unexpected ${packageName}@${version} browser bundle`)
  }
  const replacements = [
    // The projection slot supplies render-only rows to the native browser.
    ['name:`sidebar.workspaces`,children:{', 'name:`sidebar.workspaces`,children:{' +
      `"${toolbar}":{kind:\`list\`,scope:\`root\`},"${projection}":{kind:\`single\`,scope:\`root\`},`],
    ['(0,react_jsx_runtime.jsxs)(`div`,{className:clsx(WorkspaceBrowser_module_css_default.headerActions,',
      `wide&&!searchExpanded&&renderSlot(\`${toolbar}\`,{placement:\`toolbar\`})` +
      ',(0,react_jsx_runtime.jsxs)(`div`,{className:clsx(WorkspaceBrowser_module_css_default.headerActions,'],

    // Workspace view: assemble one native row window before rendering either engine.
    ['function SessionTree({list,', 'function SessionTree({extension,list,'],
    ['const groups=(0,react.useMemo)(()=>deriveGroups', 'const nativeGroups=(0,react.useMemo)(()=>deriveGroups'],
    ['expandedGroups,ungroupedSessionIds]);(0,react.useEffect)',
      'expandedGroups,ungroupedSessionIds]);const groups=extension?.groups(nativeGroups,workspaces,expandedGroups,rowState.archivedFilter)??nativeGroups;(0,react.useEffect)'],
    ['requiredWatermark(group.sessions,current,', 'requiredWatermark(group.sessions,current??extension?.activeId,'],
    ['group.sessions,sessionWatermarks[group.key]??SESSION_WATERMARK_BASE).rows;',
      'group.sessions,sessionWatermarks[group.key]??SESSION_WATERMARK_BASE).rows.filter(node=>!node.directChat);'],
    ['drag:workspaceDragProps}),childRows.length',
      'drag:workspaceDragProps,directActions:group.directCwd===void 0?void 0:extension?.renderFolderActions(group,Rows_module_css_default,setGroupExpanded)}),childRows.length'],
    ['sessions.map(node=>{const sameGroupDrag=',
      'sessions.map(node=>{if(node.directChat)return extension.renderRow(node,Rows_module_css_default,timeLabel(node.updatedAt,now,t),directChatFormatTime);const sameGroupDrag='],

    // Unregistered directories use the same native header component.
    ['function ProjectRow({group,containsCurrentDescendant=', 'function ProjectRow({directActions,group,containsCurrentDescendant='],
    ['const label=row.workspaceId===void 0?t(`group.ungrouped`):row.label;',
      'const label=row.workspaceId===void 0&&row.directCwd===void 0?t(`group.ungrouped`):row.label;'],
    ['children:[workspaceMenuTarget!==void 0&&renderFactorySlot', 'children:[directActions,workspaceMenuTarget!==void 0&&renderFactorySlot'],

    // Flat view keeps its standard native rows and applies one shared limit when external rows join.
    ['function FlatList({list,', 'function FlatList({extension,list,'],
    ['const rows=(0,react.useMemo)(()=>deriveFlat(list,sessionIds,rowState,statuses),[list,sessionIds,rowState,statuses]);',
      'const nativeRows=(0,react.useMemo)(()=>deriveFlat(list,sessionIds,rowState,statuses),[list,sessionIds,rowState,statuses]);' +
      'const rows=extension?.flat(nativeRows,rowState.archivedFilter)??nativeRows;const[flatLimit,setFlatLimit]=(0,react.useState)(0);'],
    ['sessionDragOrder(sessionIds,rows,activeDrag,over)', 'sessionDragOrder(sessionIds,flatWindow.rows.filter(node=>!node.directChat),activeDrag,over)'],
    ['const now=Date.now();return(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCardGroup,',
      'const flatBase=rows===nativeRows?Infinity:Math.max(SESSION_WATERMARK_BASE,requiredWatermark(rows,currentId??extension?.activeId,revealSessionId));' +
      'const flatOverflow=watermarkRows(rows,flatBase).hiddenCount>0;' +
      'const flatWindow=watermarkRows(rows,Math.max(flatBase,flatLimit));' +
      'const now=Date.now();return(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.HoverCardGroup,'],
    ['rowKeys:rows.length===0?[`empty`]:rows.map(row=>`session:${row.id}`)',
      'rowKeys:rows.length===0?[`empty`]:[...flatWindow.rows.map(row=>`session:${row.id}`),...(flatOverflow?[`overflow:direct-chat-flat`]:[])]'],
    ['rows.map(node=>{const active=drag!==null&&drag.pinned===node.pinned;',
      'flatWindow.rows.map(node=>{if(node.directChat)return extension.renderRow(node,Rows_module_css_default,timeLabel(node.updatedAt,now,t),directChatFormatTime);const active=drag!==null&&drag.pinned===node.pinned;'],
    ['home,t},node.id)})]})})}function SearchResults',
      'home,t},node.id)}),flatOverflow&&(0,react_jsx_runtime.jsx)(`button`,{type:`button`,className:WorkspaceBrowser_module_css_default.sessionOverflowButton,' +
      '"data-row-key":`overflow:direct-chat-flat`,"aria-expanded":flatWindow.hiddenCount===0,' +
      'onClick:()=>setFlatLimit(flatWindow.hiddenCount===0?0:Math.max(flatBase,flatLimit)+SESSION_WATERMARK_BASE),' +
      'children:flatWindow.hiddenCount===0?t(`sessions.collapse`):t(`sessions.expand`,{n:flatWindow.hiddenCount})})]})})}function SearchResults'],

    // Use the same full calendar-time formatter for native and direct session hover cards.
    ['function hoverTimeLabel(',
      'const directChatClock=new Intl.DateTimeFormat(void 0,{dateStyle:`medium`,timeStyle:`long`});' +
      'function directChatFormatTime(at){return Number.isFinite(at)&&at>0&&at<=8.64e15?directChatClock.format(at):void 0}function hoverTimeLabel('],
    ['className:Rows_module_css_default.hoverTime,children:hoverTimeLabel(node.updatedAt,now,t)',
      'className:Rows_module_css_default.hoverTime,children:directChatFormatTime(node.updatedAt)??hoverTimeLabel(node.updatedAt,now,t)'],
    ['"aria-hidden":primaryStatus.trailingLabel===void 0?void 0:true,children:primaryStatus.trailingLabel',
      'title:directChatFormatTime(row.updatedAt),"aria-hidden":primaryStatus.trailingLabel===void 0?void 0:true,children:primaryStatus.trailingLabel'],
  ]
  source = projectWorkspaceList(replacements.reduce((bundle, [before, after]) => replaceOnce(bundle, before, after), source))
  // The vendor source map reflects offsets before this local change.
  const patched = source.replace(/\n\/\/# sourceMappingURL=client\.js\.map\s*$/, '\n')
  new Script(patched)
  return patched
}

async function replaceFile(path, contents, mode) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, contents, { flag: 'wx', mode })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function main([action, root]) {
  if (!root || !['check', 'apply', 'restore', 'rollback'].includes(action)) {
    throw new Error('Usage: node ui/sidebar-workspace-patch.mjs <check|apply|restore|rollback> <workspace package path>')
  }
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(`Expected ${packageName}@${version}`)
  }

  const path = join(root, 'lib', 'client.js')
  const backupPath = path + '.before-direct-chat'
  const previousPath = path + '.before-unified-direct-chat'
  const current = await readFile(path, 'utf8')
  const backup = await readFile(backupPath, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  const original = backup ?? current
  const patched = patch(original)
  const previous = hash(current) === previousChecksum
  if (current !== original && current !== patched && !previous) throw new Error('Unexpected changes to the workspace browser bundle')

  const mode = (await stat(path)).mode & 0o777
  if (action === 'apply' && current !== patched) {
    if (!backup) await writeFile(backupPath, original, { flag: 'wx', mode })
    if (previous) await writeFile(previousPath, current, { flag: 'wx', mode }).catch(async error => {
      if (error.code !== 'EEXIST' || hash(await readFile(previousPath)) !== previousChecksum) throw error
    })
    await replaceFile(path, patched, mode)
    console.log('Applied the workspace sidebar slot patch')
  } else if (action === 'restore' && current !== original) {
    await replaceFile(path, original, mode)
    console.log('Restored the published workspace browser')
  } else if (action === 'rollback' && current === patched) {
    const previousBundle = await readFile(previousPath)
    if (hash(previousBundle) !== previousChecksum) throw new Error('Unexpected previous workspace bundle')
    await replaceFile(path, previousBundle, mode)
    console.log('Restored the previous direct chat sidebar patch')
  } else {
    console.log(current === patched ? 'Workspace sidebar slot patch is installed'
      : previous ? 'Previous workspace sidebar patch can be upgraded' : 'Published workspace browser verified')
  }
}

await main(process.argv.slice(2))
