import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { engine as agy } from './engines/agy.mjs'
import { engine as codex } from './engines/codex.mjs'
import { engine as claude } from './engines/claude.mjs'

const builtIns = new Map([agy, codex, claude].map(engine => [engine.id, engine]))

function validate(definition) {
  const { id, label, start, history } = definition ?? {}
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(id) ||
      typeof label !== 'string' || !label.trim() || typeof start !== 'function') {
    throw new Error('A direct-chat engine requires an id, label and start function')
  }
  if (definition.setArchived !== undefined && typeof definition.setArchived !== 'function') {
    throw new Error('Direct-chat engine setArchived must be a function')
  }
  for (const key of ['supportsDelete', 'deleteSession', 'rename', 'accountUsage', 'readableRoots', 'resolvePrompt', 'cliInfo', 'checkUpdate', 'updateCli', 'authStatus', 'logoutCli', 'configProfiles']) {
    if (definition[key] !== undefined && typeof definition[key] !== 'function') {
      throw new Error(`Direct-chat engine ${key} must be a function`)
    }
  }
  if (definition.loginCommand !== undefined && typeof definition.loginCommand !== 'string') {
    throw new Error('Direct-chat engine loginCommand must be a string')
  }
  if (definition.composerVersion !== undefined && (!Number.isSafeInteger(definition.composerVersion) || definition.composerVersion < 1)) {
    throw new Error('Direct-chat engine composerVersion must be a positive integer')
  }
  for (const key of ['meta', 'capabilities', 'loginSpec']) {
    if (definition[key] !== undefined && (!definition[key] || typeof definition[key] !== 'object' || Array.isArray(definition[key]))) {
      throw new Error(`Direct-chat engine ${key} must be an object`)
    }
  }
  if (history && (typeof history.list !== 'function' || typeof history.messages !== 'function')) {
    throw new Error('Direct-chat engine history requires list and messages functions')
  }
  return Object.freeze({ ...definition, label: label.trim() })
}

async function loadModule(file) {
  if (typeof file !== 'string' || !(isAbsolute(file) || file.startsWith('file:'))) {
    throw new Error('Direct-chat engineModules must contain absolute paths or file URLs')
  }
  const module = await import(isAbsolute(file) ? pathToFileURL(file) : new URL(file))
  return validate(module.engine ?? module.default)
}

// Cordis can configure a subset of built-ins and load additional local ESM providers.
export function createEngineRegistry(config = {}) {
  const { engines = [...builtIns.keys()], engineModules = [] } = config ?? {}
  if (!Array.isArray(engines) || !Array.isArray(engineModules)) {
    throw new Error('Direct-chat engines and engineModules must be arrays')
  }
  const definitions = new Map()

  function add(entry) {
    if (definitions.has(entry.id)) throw new Error('Direct-chat engine already registered: ' + entry.id)
    definitions.set(entry.id, entry)
    return () => { if (definitions.get(entry.id) === entry) definitions.delete(entry.id) }
  }

  for (const id of engines) {
    if (!builtIns.has(id)) throw new Error('Unknown built-in direct-chat engine: ' + id)
    add(validate(builtIns.get(id)))
  }

  const ready = Promise.all(engineModules.map(loadModule)).then(entries => {
    const seen = new Set(definitions.keys())
    for (const entry of entries) {
      if (seen.has(entry.id)) throw new Error('Direct-chat engine already registered: ' + entry.id)
      seen.add(entry.id)
    }
    for (const entry of entries) add(entry)
  })
  void ready.catch(() => {})

  return {
    ready,
    has: id => definitions.has(id),
    get: id => definitions.get(id),
    list: () => [...definitions.values()],
    register: definition => add(validate(definition)),
  }
}
