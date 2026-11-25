import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const harnessPackages = new URL('../../deepseek-harness/node_modules/.pnpm/', import.meta.url)
let esbuild
try {
  esbuild = require('esbuild')
} catch {
  const esbuildPkg = new URL('esbuild@0.28.1/node_modules/esbuild/package.json', harnessPackages)
  if (!existsSync(esbuildPkg)) {
    throw new Error('esbuild is required to build ui/client.js; run `npm install` first or use the prebuilt ui/client.js.')
  }
  esbuild = createRequire(esbuildPkg)('.')
}
const { build } = esbuild
const forgePackage = '@deepseek-ai/dsh-experimental-client-ui-forge'

const nativePackages = ['dsh-experimental-client-ui-forge', 'dsh-client-ui-attachment', 'dsh-client-ui-chat', 'dsh-client-ui-conversation', 'dsh-client-ui-input-trigger', 'dsh-client-ui-sidebar-right', 'dsh-client-ui-sidebar-terminal']
  .map(name => '@deepseek-ai/' + name)

function resolveNativePackages() {
  const installations = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
    .map(directory => join(directory, 'dsh')).filter(existsSync)
  for (const candidate of [require, ...installations.map(path => createRequire(realpathSync(path)))]) {
    try {
      for (const name of nativePackages) candidate.resolve(`${name}/package.json`)
      return candidate
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error
    }
  }
  throw new Error(`Install DSH with ${forgePackage} or install the direct-chat development dependencies`)
}

const native = resolveNativePackages()
const rightbarSource = native.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/src/client/shell/SidebarRight.tsx')
const viewedFilesSource = native.resolve(`${forgePackage}/src/client/viewed-files.ts`)
const { outputFiles } = await build({
  absWorkingDir: fileURLToPath(new URL('.', import.meta.url)),
  entryPoints: ['index.jsx'],
  outfile: 'client.js',
  write: false,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.css': 'text', '.module.css': 'local-css', '.png': 'dataurl' },
  nodePaths: [
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    fileURLToPath(new URL('@tanstack+react-virtual@3.14.9_react-dom@18.3.1_react@18.3.1__react@18.3.1/node_modules', harnessPackages)),
    fileURLToPath(new URL('clsx@2.1.1/node_modules', harnessPackages)),
  ].filter(existsSync),
  external: ['react', 'react/jsx-runtime', 'react-dom', 'zod', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-dockkit', '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: [{
    name: 'native-dsh-ui',
    setup(build) {
      build.onResolve({ filter: /^@deepseek-ai\/dsh-(?:experimental-client-ui-forge|client-ui-(?:attachment|chat|conversation|input-trigger|sidebar-right|sidebar-terminal))\/src\// }, ({ path }) => ({
        path: native.resolve(path),
      }))
      // rc.5 shares its dock kit publicly but keeps the two panel buttons local to this module.
      build.onLoad({ filter: /SidebarRight\.tsx$/ }, async ({ path }) => {
        if (path !== rightbarSource) return
        const source = await readFile(path, 'utf8')
        return { contents: source + '\nexport { PanelChrome }\n', loader: 'tsx' }
      })
      build.onLoad({ filter: /viewed-files\.ts$/ }, async ({ path }) => {
        if (path !== viewedFilesSource) return
        const contents = await readFile(path, 'utf8')
        const prefix = "const PREFIX = 'dsh.forge-viewed.v1'"
        if (!contents.includes(prefix)) throw new Error('The installed Forge viewed storage layout has changed')
        // Isolate direct sessions from the native package's shared retention index.
        return { contents: contents.replace(prefix, "const PREFIX = 'dsh-direct-chat.forge-viewed.v1'"), loader: 'ts' }
      })
    },
  }],
})
const js = outputFiles.find(file => file.path.endsWith('.js'))
const css = outputFiles.find(file => file.path.endsWith('.css'))
const license = await readFile(join(dirname(native.resolve(`${forgePackage}/package.json`)), 'LICENSE'), 'utf8')
await writeFile(js.path, '// Built from ui/index.jsx by npm run build:ui.\n'
  + `/*! ${nativePackages.join(", ")}\n${license.trimEnd()}\n*/\n`
  + 'window.__ModuleLoader__.load({ id: "dsh-direct-chat", factory(require) {\n'
  + 'const module = { exports: {} };\n'
  + `const compiledNativeStyles = ${JSON.stringify(css.text)};\n`
  + js.text + 'return module.exports;\n} });\n')
