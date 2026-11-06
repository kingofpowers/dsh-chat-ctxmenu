/**
 * Dependency-free checks for the two halves of dsh-chat-ctxmenu.
 *
 * Run with:  node --test
 *
 * The Host half is exercised through its real HTTP handler functions with mock
 * ctx services. The Client half is loaded through a stubbed `__ModuleLoader__`
 * and driven through a stubbed official `contextMenus` service plus a minimal
 * DOM: this verifies that contributions belong to the official targets, that
 * the prose fallback never steals an official gesture, and that a verified
 * prose path is handed to the official file menu. These checks do not replace
 * looking at the running app.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const results = { passed: 0, failed: [] }

async function check(name, fn) {
  try {
    await fn()
    results.passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    results.failed.push({ name, error })
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

// ---------------------------------------------------------------------------
// Package contract
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

await check('package declares the DSH 0.2.2 client contract', () => {
  assert.equal(manifest.engines?.dsh, '>=0.2.2-rc.1 <0.3.0')
  assert.deepEqual(manifest.dsh?.client?.inject, [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-ui-context-menu',
  ])
  assert.equal(manifest.exports?.['./client'], './client.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(Array.isArray(manifest.files), 'files must be an array')
  for (const entry of ['index.js', 'client.js', 'cordis.patch.yml']) {
    assert.ok(manifest.files.includes(entry), `files must include ${entry}`)
  }
})

// ---------------------------------------------------------------------------
// Host half
// ---------------------------------------------------------------------------

function normalize(path) {
  return path.replace(/\//g, '\\')
}

const nativeCalls = []

function makeHostCtx() {
  const routes = []
  const effects = []
  const state = { origin: 'http://127.0.0.1:55902', nativeError: null, nativeOpens: 0 }
  const services = {
    webServer: {
      getOrigin: () => state.origin,
      register(route) {
        routes.push(route)
        return () => {
          route.disposed = true
        }
      },
    },
    fs: {
      async resolve(path, options = {}) {
        const cwd = options !== undefined && options !== null && typeof options.cwd === 'string' ? options.cwd : ''
        const isAbsolute = /^[A-Za-z]:[\\/]/.test(path)
        const absolute = isAbsolute ? normalize(path) : (cwd === '' ? normalize(path) : `${cwd}\\${normalize(path)}`)
        return { path: absolute }
      },
      processPath(target) {
        return target.path
      },
      async stat(target) {
        const value = target.path
        if (/missing/u.test(value) || /and\\or/u.test(value)) return undefined
        return { type: value.endsWith('dir') ? 'directory' : 'file' }
      },
      async lstat(path) {
        const value = normalize(path)
        if (/missing/u.test(value) || value === 'and\\or') return undefined
        return { type: value.endsWith('dir') ? 'directory' : 'file' }
      },
    },
    sessionController: {
      canOpenWorkspacePath: () => true,
      workspaceDesktop: () => ({ name: 'Windows', available: true, fileManager: 'explorer' }),
      async openWorkspacePath(request, signal) {
        state.nativeOpens += 1
        nativeCalls.push({ request, hasSignal: signal instanceof AbortSignal })
        if (state.nativeError !== null) throw state.nativeError
        return { opened: true }
      },
      async workspacePathApplications(request, signal) {
        nativeCalls.push({ request, hasSignal: signal instanceof AbortSignal })
        if (state.nativeError !== null) throw state.nativeError
        return [{ id: 'vscode', name: 'Visual Studio Code', default: true, icon: null }]
      },
    },
    sessions: {
      get() {
        return { header: { cwd: 'C:\\workspace' } }
      },
    },
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(fn) {
      // Cordis runs an effect body immediately and keeps the returned disposer.
      const dispose = fn()
      effects.push(typeof dispose === 'function' ? dispose : () => {})
    },
    logger: { warn() {}, debug() {} },
  }
  return { ctx, routes, effects, state }
}

function mockRequest(body, options = {}) {
  const remoteAddress = options.remoteAddress ?? '127.0.0.1'
  const origin = 'origin' in options ? options.origin : 'http://127.0.0.1:55902'
  const url = options.url ?? '/'
  const raw = options.rawBody !== undefined ? options.rawBody : (body === undefined ? '' : JSON.stringify(body))
  const chunks = raw === '' ? [] : [Buffer.from(raw)]
  return {
    headers: origin === null ? {} : { origin },
    socket: { remoteAddress },
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function mockResponse() {
  const response = {
    status: 0,
    body: '',
    writeHead(status) {
      response.status = status
    },
    end(body) {
      response.body = typeof body === 'string' ? body : body.toString('utf8')
    },
  }
  return response
}

const host = makeHostCtx()
const hostModule = await import('../index.js')

await check('host module declares the webServer dependency', () => {
  assert.equal(hostModule.name, 'dsh-chat-ctxmenu')
  assert.deepEqual(hostModule.inject, ['webServer'])
  assert.equal(typeof hostModule.apply, 'function')
})

hostModule.apply(host.ctx)

await check('host registers rpc and status routes inside one effect', () => {
  const paths = host.routes.map((route) => route.path).sort()
  assert.deepEqual(paths, ['/dsh-chat-ctxmenu/rpc', '/dsh-chat-ctxmenu/status'])
  for (const route of host.routes) assert.equal(route.kind, 'exact')
  assert.equal(host.effects.length, 1)
})

const rpcRoute = host.routes.find((route) => route.path === '/dsh-chat-ctxmenu/rpc')
const statusRoute = host.routes.find((route) => route.path === '/dsh-chat-ctxmenu/status')

async function callRpc(action, args, options = {}) {
  const request = mockRequest({ action, args }, options)
  const response = mockResponse()
  await rpcRoute.handler(request, response)
  return { status: response.status, body: JSON.parse(response.body) }
}

await check('status reports platform, native channel, fs and revision', async () => {
  const response = mockResponse()
  await statusRoute.handler(mockRequest(undefined), response)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.ok, true)
  assert.equal(body.platform, 'windows')
  assert.equal(body.native, true)
  assert.equal(body.canOpen, true)
  assert.equal(body.fs, true)
  assert.equal(body.maxPaths, 8)
  assert.equal(body.rev, 5)
})

await check('status probe resolves a relative path against the given cwd', async () => {
  const response = mockResponse()
  await statusRoute.handler(mockRequest(undefined, { url: '/dsh-chat-ctxmenu/status?probe=src%2Fapp.ts&cwd=C%3A%5Cworkspace' }), response)
  const body = JSON.parse(response.body)
  assert.equal(body.probe.absolute, 'C:\\workspace\\src\\app.ts')
  assert.equal(body.probe.exists, true)
  assert.equal(body.relative, 'src/app.ts')
})

await check('status probe expands a leading tilde', async () => {
  const response = mockResponse()
  await statusRoute.handler(mockRequest(undefined, { url: '/dsh-chat-ctxmenu/status?probe=~%2FDesktop' }), response)
  const body = JSON.parse(response.body)
  assert.equal(body.probe.absolute, `${normalize(homedir())}\\Desktop`)
})

await check('resolve reports existence and directory kind', async () => {
  const reply = await callRpc('resolve', { paths: ['src/app.ts', 'and/or', 'sub-dir'], cwd: 'C:\\workspace' })
  assert.equal(reply.status, 200)
  assert.equal(reply.body.ok, true)
  assert.equal(reply.body.results[0].exists, true)
  assert.equal(reply.body.results[0].isDir, false)
  assert.equal(reply.body.results[1].exists, false)
  assert.equal(reply.body.results[2].exists, true)
  assert.equal(reply.body.results[2].isDir, true)
})

await check('resolve falls back to the session cwd when the client omits it', async () => {
  const reply = await callRpc('resolve', { paths: ['src/app.ts'], sessionId: 'session-1' })
  assert.equal(reply.body.ok, true)
  assert.equal(reply.body.results[0].absolute, 'C:\\workspace\\src\\app.ts')
})

await check('apps lists registered applications and marks the default', async () => {
  const reply = await callRpc('apps', { path: 'src/app.ts', cwd: 'C:\\workspace' })
  assert.equal(reply.body.ok, true)
  assert.deepEqual(reply.body.apps, [{ id: 'vscode', name: 'Visual Studio Code', isDefault: true }])
  assert.equal(reply.body.canOpenWithDialog, true)
})

await check('apps on a directory returns no applications', async () => {
  const reply = await callRpc('apps', { path: 'sub-dir', cwd: 'C:\\workspace' })
  assert.equal(reply.body.ok, true)
  assert.deepEqual(reply.body.apps, [])
  assert.equal(reply.body.canOpenWithDialog, false)
})

await check('apps on a missing path fails instead of pretending success', async () => {
  const reply = await callRpc('apps', { path: 'missing.ts', cwd: 'C:\\workspace' })
  assert.equal(reply.body.ok, false)
  assert.equal(reply.body.error, 'path-missing')
})

await check('open-with strategy rejects applications that are not registered', () => {
  assert.deepEqual(
    hostModule.resolveOpenWithStrategy({ platform: 'win32', application: 'C:\\evil\\evil.exe', registered: false }),
    { action: 'reject', error: 'application-not-registered' },
  )
})

await check('open-with strategy launches registered Windows executables directly', () => {
  assert.deepEqual(
    hostModule.resolveOpenWithStrategy({ platform: 'win32', application: 'C:\\Windows\\system32\\NOTEPAD.EXE', registered: true }),
    { action: 'spawn' },
  )
  assert.deepEqual(
    hostModule.resolveOpenWithStrategy({ platform: 'win32', application: 'C:\\Program Files\\Sublime Text\\sublime_text.exe', registered: true }),
    { action: 'spawn' },
  )
})

await check('open-with strategy keeps the native channel for non-executable ids', () => {
  assert.equal(
    hostModule.resolveOpenWithStrategy({ platform: 'win32', application: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', registered: true }).action,
    'native',
  )
  assert.equal(
    hostModule.resolveOpenWithStrategy({ platform: 'darwin', application: 'com.apple.TextEdit', registered: true }).action,
    'native',
  )
})

await check('openWith rejects an application that is not registered for the file', async () => {
  const reply = await callRpc('openWith', { path: 'src/app.ts', cwd: 'C:\\workspace', application: 'C:\\evil\\evil.exe' })
  assert.equal(reply.body.ok, false)
  assert.equal(reply.body.error, 'application-not-registered')
})

await check('openWith for a registered non-executable id uses the native channel', async () => {
  nativeCalls.length = 0
  const reply = await callRpc('openWith', { path: 'src/app.ts', cwd: 'C:\\workspace', application: 'vscode' })
  assert.equal(reply.body.ok, true)
  assert.equal(nativeCalls.length, 1)
  assert.equal(nativeCalls[0].request.application, 'vscode')
})

await check('removed open/reveal/openUrl actions are gone instead of half-working', async () => {
  for (const action of ['open', 'reveal', 'openUrl']) {
    const reply = await callRpc(action, { path: 'src/app.ts', cwd: 'C:\\workspace' })
    assert.equal(reply.body.ok, false, `expected ${action} to be unknown`)
    assert.equal(reply.body.error, 'unknown-action')
  }
})

await check('unknown actions fail without throwing', async () => {
  const reply = await callRpc('nope', {})
  assert.equal(reply.body.ok, false)
  assert.equal(reply.body.error, 'unknown-action')
})

await check('non-loopback peers are rejected', async () => {
  const reply = await callRpc('status', {}, { remoteAddress: '192.168.1.50' })
  assert.equal(reply.status, 403)
  assert.equal(reply.body.error, 'loopback-only')
})

await check('foreign browser origins are rejected', async () => {
  const reply = await callRpc('status', {}, { origin: 'https://evil.example' })
  assert.equal(reply.status, 403)
  assert.equal(reply.body.error, 'origin-not-allowed')
})

await check('an unknown host origin fails closed', async () => {
  host.state.origin = ''
  const reply = await callRpc('status', {}, { origin: 'https://evil.example' })
  host.state.origin = 'http://127.0.0.1:55902'
  assert.equal(reply.status, 403)
  assert.equal(reply.body.error, 'origin-not-allowed')
})

await check('a cross-site fetch hint is rejected', async () => {
  const request = mockRequest({ action: 'status', args: {} }, {})
  request.headers['sec-fetch-site'] = 'cross-site'
  const response = mockResponse()
  await rpcRoute.handler(request, response)
  assert.equal(response.status, 403)
})

await check('oversized request bodies are rejected', async () => {
  const request = mockRequest(undefined, { rawBody: `{"action":"resolve","args":{"paths":["${'x'.repeat(300 * 1024)}"]}}` })
  const response = mockResponse()
  await rpcRoute.handler(request, response)
  assert.equal(response.status, 413)
  assert.equal(JSON.parse(response.body).error, 'payload-too-large')
})

await check('invalid JSON is rejected with 400', async () => {
  const response = mockResponse()
  await rpcRoute.handler(mockRequest(undefined, { rawBody: '{"action":' }), response)
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.body).error, 'invalid-json')
})

await check('teardown disposes both routes', () => {
  assert.equal(host.effects.length, 1)
  assert.equal(typeof host.effects[0], 'function')
  host.effects[0]()
  assert.equal(host.routes.every((route) => route.disposed === true), true)
})

// ---------------------------------------------------------------------------
// Client half
// ---------------------------------------------------------------------------

// A tiny DOM: only the members the fallback listener touches. Element instances
// resolve their selectors from a per-element map, which keeps the tests focused
// on the plugin's decision instead of on browser parsing.
class FakeElement {
  constructor(spec = {}) {
    this.tagName = spec.tagName ?? 'DIV'
    this.innerText = spec.innerText ?? ''
    this.textContent = spec.textContent ?? ''
    this.attrs = spec.attrs ?? {}
    this.selectors = spec.selectors ?? {}
    this.clone = spec.clone
  }

  closest(selector) {
    if (Object.prototype.hasOwnProperty.call(this.selectors, selector)) return this.selectors[selector]
    return null
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }

  getBoundingClientRect() {
    return { left: 40, bottom: 60, right: 120, top: 20 }
  }

  contains() {
    return true
  }

  cloneNode() {
    return this.clone
  }
}

const clipboard = { writes: [] }
const documentListeners = { contextmenu: [] }
let caret = null

const messageText = 'see src/app.ts'
const messageClone = { nodeType: 1, tagName: 'DIV', querySelectorAll: () => [], childNodes: [{ nodeType: 3, data: messageText }] }
const messageEl = new FakeElement({ tagName: 'DIV', innerText: messageText, textContent: messageText, clone: messageClone })

function setMessageText(text) {
  messageEl.innerText = text
  messageEl.textContent = text
  messageClone.childNodes = [{ nodeType: 3, data: text }]
}

const windowStub = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition)
    },
  },
  getSelection: () => ({ isCollapsed: true, toString: () => '', anchorNode: null }),
  innerWidth: 1280,
  innerHeight: 800,
}

const loaded = []
globalThis.window = windowStub
globalThis.Element = FakeElement
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { language: 'zh-CN', clipboard: { writeText: async (text) => { clipboard.writes.push(text) } } },
})
globalThis.document = {
  addEventListener(type, fn, options) {
    if (documentListeners[type] === undefined) return
    const capture = options === true || (typeof options === 'object' && options !== null && options.capture === true)
    documentListeners[type].push({ fn, capture })
  },
  removeEventListener(type, fn, options) {
    const list = documentListeners[type]
    if (list === undefined) return
    const capture = options === true || (typeof options === 'object' && options !== null && options.capture === true)
    const index = list.findIndex((entry) => entry.fn === fn && entry.capture === capture)
    if (index !== -1) list.splice(index, 1)
  },
  caretPositionFromPoint: () => caret,
}

const rpcReplies = new Map()
globalThis.fetch = async (_url, options) => {
  const request = JSON.parse(options.body)
  const reply = rpcReplies.get(request.action)
  if (reply === undefined) return { ok: false, status: 404, text: async () => '' }
  const value = typeof reply === 'function' ? await reply(request.args) : reply
  return { ok: true, status: 200, text: async () => JSON.stringify(value) }
}

await import('../client.js')

await check('client bundle registers a factory under the package id', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-chat-ctxmenu')
  assert.equal(typeof loaded[0].factory, 'function')
})

const ReactStub = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
}
const plugin = loaded[0].factory((id) => {
  assert.equal(id, 'react')
  return ReactStub
})

function makeClientCtx() {
  const state = {
    contributions: [],
    opened: [],
    notices: [],
    icons: [],
    effects: [],
    sessionsSnapshot: {
      ids: ['session-1'],
      byId: {
        'session-1': { cwd: 'C:\\workspace', retainedBy: { mainView: 1 } },
      },
    },
  }
  const services = {
    contextMenus: {
      register(contribution) {
        state.contributions.push(contribution)
        return () => {}
      },
      open(target, point) {
        state.opened.push({ target, point })
      },
      notify(text, success) {
        state.notices.push({ text, success })
      },
    },
    sessions: {
      list: {
        getSnapshot: () => state.sessionsSnapshot,
      },
    },
    locale: {
      getLocale: () => ({ locale: 'zh' }),
      register: () => () => {},
    },
    slots: {
      inject(owner, callback) {
        assert.equal(owner, 'contextMenu.icon')
        callback()
      },
      register(meta, component) {
        state.icons.push({ meta, component })
        return () => {}
      },
    },
  }
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      state.effects.push(typeof dispose === 'function' ? dispose : () => {})
    },
    logger: { warn() {}, debug() {} },
  }
  return { ctx, state }
}

const client = makeClientCtx()
plugin.apply(client.ctx)

await check('client injects the official context-menu services', () => {
  assert.deepEqual(plugin.inject, ['contextMenus', 'sessions', 'locale', 'slots'])
})

await check('client contributes to the official targets only', () => {
  const byId = new Map(client.state.contributions.map((entry) => [entry.id, entry]))
  assert.deepEqual([...byId.keys()].sort(), [
    'chat-ctxmenu.directory.copy-relative-path',
    'chat-ctxmenu.file.copy-relative-path',
    'chat-ctxmenu.file.open-with',
    'chat-ctxmenu.image.copy-link',
    'chat-ctxmenu.message.copy-message',
    'chat-ctxmenu.message.copy-selection',
  ])
  assert.equal(byId.get('chat-ctxmenu.file.copy-relative-path').target, 'file')
  assert.equal(byId.get('chat-ctxmenu.file.open-with').target, 'file')
  assert.equal(byId.get('chat-ctxmenu.directory.copy-relative-path').target, 'directory')
  assert.equal(byId.get('chat-ctxmenu.image.copy-link').target, 'image')
  assert.equal(byId.get('chat-ctxmenu.message.copy-selection').target, 'chatMessage')
  assert.equal(byId.get('chat-ctxmenu.message.copy-message').target, 'chatMessage')
})

await check('client registers an icon component for every contributed icon key', () => {
  assert.equal(client.state.icons.length, 5)
  for (const entry of client.state.icons) {
    assert.equal(entry.meta.name, 'contextMenu.icon')
    assert.match(entry.meta.key, /^chat-ctxmenu\./)
    assert.equal(typeof entry.component, 'function')
  }
})

await check('fallback registers one capture-phase invalidator and one bubble-phase handler', () => {
  assert.equal(documentListeners.contextmenu.length, 2)
  assert.equal(documentListeners.contextmenu.filter((entry) => entry.capture === true).length, 1)
  assert.equal(documentListeners.contextmenu.filter((entry) => entry.capture !== true).length, 1)
})

function captureHandlers() {
  return documentListeners.contextmenu.filter((entry) => entry.capture === true).map((entry) => entry.fn)
}

function bubbleHandler() {
  return documentListeners.contextmenu.find((entry) => entry.capture !== true)?.fn
}

/** Browser order: capture listeners first, then the bubble listener. */
function dispatchContextMenu(event) {
  for (const fn of captureHandlers()) fn(event)
  bubbleHandler()?.(event)
}

function contextMenuEvent(target, overrides = {}) {
  const event = {
    target,
    clientX: 30,
    clientY: 50,
    defaultPrevented: false,
    prevented: 0,
    stopped: 0,
    preventDefault() {
      this.prevented += 1
      this.defaultPrevented = true
    },
    stopPropagation() {
      this.stopped += 1
    },
    ...overrides,
  }
  return event
}

function conversationTarget() {
  return new FakeElement({
    tagName: 'SPAN',
    selectors: {
      '[data-chat-flow-kind]': messageEl,
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]': null,
    },
  })
}

function workspaceTarget() {
  return new FakeElement({
    tagName: 'DIV',
    selectors: {
      '[data-chat-flow-kind]': null,
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]': null,
    },
  })
}

function editableTarget() {
  const editable = new FakeElement({ tagName: 'TEXTAREA' })
  return new FakeElement({
    tagName: 'TEXTAREA',
    selectors: {
      '[data-chat-flow-kind]': messageEl,
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]': editable,
    },
  })
}

await check('fallback never steals a gesture the official menu already handled', async () => {
  client.state.opened.length = 0
  const event = contextMenuEvent(conversationTarget(), { defaultPrevented: true })
  dispatchContextMenu(event)
  await flush()
  assert.equal(client.state.opened.length, 0)
  assert.equal(event.prevented, 0)
})

await check('fallback leaves workspace and other surfaces to the official UI', async () => {
  client.state.opened.length = 0
  const event = contextMenuEvent(workspaceTarget())
  dispatchContextMenu(event)
  await flush()
  assert.equal(client.state.opened.length, 0)
  assert.equal(event.prevented, 0)
})

await check('fallback ignores editable fields', async () => {
  client.state.opened.length = 0
  const event = contextMenuEvent(editableTarget())
  dispatchContextMenu(event)
  await flush()
  assert.equal(client.state.opened.length, 0)
  assert.equal(event.prevented, 0)
})

await check('plain conversation text opens the plugin chatMessage target', async () => {
  caret = null
  setMessageText('hello world')
  rpcReplies.clear()
  client.state.opened.length = 0
  const event = contextMenuEvent(conversationTarget())
  dispatchContextMenu(event)
  await flush()
  assert.equal(event.prevented, 1)
  assert.equal(client.state.opened.length, 1)
  const opened = client.state.opened[0]
  assert.equal(opened.target.kind, 'chatMessage')
  assert.equal(opened.target.value.sessionId, 'session-1')
  assert.equal(opened.target.value.messageText, 'hello world')
  assert.deepEqual(opened.point, { x: 30, y: 50 })
})

await check('a verified prose path opens the official file menu with the resolved absolute path', async () => {
  caret = { offsetNode: { nodeType: 3, data: 'see src/app.ts' }, offset: 8 }
  messageEl.innerText = 'see src/app.ts'
  messageEl.textContent = 'see src/app.ts'
  messageClone.childNodes = [{ nodeType: 3, data: 'see src/app.ts' }]
  rpcReplies.clear()
  rpcReplies.set('resolve', () => ({
    ok: true,
    results: [{ exists: true, absolute: 'C:\\workspace\\src\\app.ts', isDir: false }],
  }))
  client.state.opened.length = 0
  const event = contextMenuEvent(conversationTarget())
  dispatchContextMenu(event)
  await flush()
  assert.equal(client.state.opened.length, 1)
  const opened = client.state.opened[0]
  assert.equal(opened.target.kind, 'file')
  assert.deepEqual(opened.target.value, { sessionId: 'session-1', path: 'C:\\workspace\\src\\app.ts' })
})

await check('a missing prose path falls back to the chatMessage target', async () => {
  caret = { offsetNode: { nodeType: 3, data: 'see src/app.ts' }, offset: 8 }
  messageEl.innerText = 'see src/app.ts'
  messageEl.textContent = 'see src/app.ts'
  messageClone.childNodes = [{ nodeType: 3, data: 'see src/app.ts' }]
  rpcReplies.clear()
  rpcReplies.set('resolve', () => ({ ok: true, results: [{ exists: false, absolute: 'C:\\workspace\\src\\app.ts', isDir: false }] }))
  client.state.opened.length = 0
  const event = contextMenuEvent(conversationTarget())
  dispatchContextMenu(event)
  await flush()
  assert.equal(client.state.opened.length, 1)
  assert.equal(client.state.opened[0].target.kind, 'chatMessage')
})

await check('a URL in prose opens the official url target', async () => {
  const text = 'see https://example.test/a?b=1 now'
  caret = { offsetNode: { nodeType: 3, data: text }, offset: 20 }
  setMessageText(text)
  rpcReplies.clear()
  client.state.opened.length = 0
  const event = contextMenuEvent(conversationTarget())
  dispatchContextMenu(event)
  await flush()
  assert.equal(client.state.opened.length, 1)
  assert.equal(client.state.opened[0].target.kind, 'url')
  assert.deepEqual(client.state.opened[0].target.value, { sessionId: 'session-1', url: 'https://example.test/a?b=1' })
})

await check('chatMessage opens even when no main-view session is detected', async () => {
  caret = null
  setMessageText('hello world')
  rpcReplies.clear()
  const previous = client.state.sessionsSnapshot
  client.state.sessionsSnapshot = { ids: [], byId: {} }
  client.state.opened.length = 0
  const event = contextMenuEvent(conversationTarget())
  dispatchContextMenu(event)
  await flush()
  client.state.sessionsSnapshot = previous
  assert.equal(event.prevented, 1)
  assert.equal(client.state.opened.length, 1)
  assert.equal(client.state.opened[0].target.kind, 'chatMessage')
  assert.equal(client.state.opened[0].target.value.sessionId, null)
})

await check('a newer gesture cancels a fallback whose resolve is still pending', async () => {
  caret = { offsetNode: { nodeType: 3, data: 'see src/app.ts' }, offset: 8 }
  setMessageText('see src/app.ts')
  let release = () => {}
  rpcReplies.clear()
  rpcReplies.set('resolve', () => new Promise((resolve) => {
    release = () => resolve({ ok: true, results: [{ exists: true, absolute: 'C:\\workspace\\src\\app.ts', isDir: false }] })
  }))
  client.state.opened.length = 0
  dispatchContextMenu(contextMenuEvent(conversationTarget()))
  await flush()
  // A newer official gesture (defaultPrevented) must invalidate the pending one.
  dispatchContextMenu(contextMenuEvent(conversationTarget(), { defaultPrevented: true }))
  release()
  await flush()
  await flush()
  assert.equal(client.state.opened.length, 0)
})

function contribution(id) {
  const found = client.state.contributions.find((entry) => entry.id === id)
  assert.notEqual(found, undefined, `missing contribution ${id}`)
  return found
}

await check('file contribution copies a workspace-relative path', async () => {
  clipboard.writes.length = 0
  const actions = await contribution('chat-ctxmenu.file.copy-relative-path').resolve({ sessionId: 'session-1', path: 'src/app.ts' }, new AbortController().signal)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'copyRelativePath')
  await actions[0].run()
  assert.deepEqual(clipboard.writes, ['src/app.ts'])
})

await check('file contribution hides a relative path outside the workspace', async () => {
  const actions = await contribution('chat-ctxmenu.file.copy-relative-path').resolve({ sessionId: 'session-1', path: 'D:\\elsewhere\\app.ts' }, new AbortController().signal)
  assert.deepEqual(actions, [])
})

await check('directory contribution copies a workspace-relative path', async () => {
  clipboard.writes.length = 0
  const actions = await contribution('chat-ctxmenu.directory.copy-relative-path').resolve({ sessionId: 'session-1', path: 'src' }, new AbortController().signal)
  assert.equal(actions.length, 1)
  await actions[0].run()
  assert.deepEqual(clipboard.writes, ['src'])
})

await check('image contribution only offers an http(s) link', async () => {
  const httpActions = await contribution('chat-ctxmenu.image.copy-link').resolve({ url: 'https://example.test/a.png' }, new AbortController().signal)
  assert.equal(httpActions.length, 1)
  clipboard.writes.length = 0
  await httpActions[0].run()
  assert.deepEqual(clipboard.writes, ['https://example.test/a.png'])
  const blobActions = await contribution('chat-ctxmenu.image.copy-link').resolve({ url: 'blob:http://127.0.0.1/abc' }, new AbortController().signal)
  assert.deepEqual(blobActions, [])
})

await check('open-with contribution lists registered applications and the OS chooser', async () => {
  rpcReplies.clear()
  rpcReplies.set('apps', () => ({
    ok: true,
    canOpenWithDialog: true,
    apps: [
      { id: 'C:\\Program Files\\App\\app.exe', name: 'App', isDefault: true },
      { id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', name: 'Notepad', isDefault: false },
    ],
  }))
  const actions = await contribution('chat-ctxmenu.file.open-with').resolve({ sessionId: 'session-1', path: 'src/app.ts' }, new AbortController().signal)
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'openWith')
  assert.equal(actions[0].children.length, 3)
  assert.deepEqual(actions[0].children.map((child) => child.id), [
    'application:C:\\Program Files\\App\\app.exe',
    'application:Microsoft.WindowsNotepad_8wekyb3d8bbwe!App',
    'application:__choose__',
  ])
})

await check('open-with contribution disappears when the host lists no application', async () => {
  rpcReplies.clear()
  rpcReplies.set('apps', () => ({ ok: true, canOpenWithDialog: false, apps: [] }))
  const actions = await contribution('chat-ctxmenu.file.open-with').resolve({ sessionId: 'session-1', path: 'src/app.ts' }, new AbortController().signal)
  assert.deepEqual(actions, [])
})

await check('chatMessage contributions copy the captured selection and message', async () => {
  const selectionActions = await contribution('chat-ctxmenu.message.copy-selection').resolve({ selectionText: 'src/app.ts', messageText: 'see src/app.ts' }, new AbortController().signal)
  assert.equal(selectionActions.length, 1)
  clipboard.writes.length = 0
  await selectionActions[0].run()
  assert.deepEqual(clipboard.writes, ['src/app.ts'])

  const messageActions = await contribution('chat-ctxmenu.message.copy-message').resolve({ selectionText: '', messageText: 'see src/app.ts' }, new AbortController().signal)
  assert.equal(messageActions.length, 1)
  clipboard.writes.length = 0
  await messageActions[0].run()
  assert.deepEqual(clipboard.writes, ['see src/app.ts'])
})

await check('teardown removes the fallback listener', () => {
  for (const dispose of client.state.effects) dispose()
  assert.equal(documentListeners.contextmenu.length, 0)
})

// ---------------------------------------------------------------------------

console.log(`\n${results.passed} passed, ${results.failed.length} failed`)
if (results.failed.length > 0) process.exitCode = 1
