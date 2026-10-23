/**
 * Dependency-free checks for the two halves of dsh-chat-ctxmenu.
 *
 * Run with:  node test/plugin.test.mjs
 *
 * The Host half is exercised through its real HTTP handler functions with mock
 * ctx services; the Client half is loaded through a stubbed `__ModuleLoader__`
 * so that the bundle factory and its slot registration are verified without a
 * browser. These checks do not replace looking at the running app.
 */
import assert from 'node:assert/strict'
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
  assert.equal(body.rev, 4)
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

await check('open uses the native path channel with an AbortSignal', async () => {
  nativeCalls.length = 0
  const reply = await callRpc('open', { path: 'src/app.ts', cwd: 'C:\\workspace' })
  assert.equal(reply.body.ok, true)
  assert.equal(nativeCalls.length, 1)
  assert.equal(nativeCalls[0].hasSignal, true)
  assert.deepEqual(nativeCalls[0].request, { path: 'C:\\workspace\\src\\app.ts' })
})

await check('reveal sends action=reveal', async () => {
  nativeCalls.length = 0
  const reply = await callRpc('reveal', { path: 'src/app.ts', cwd: 'C:\\workspace' })
  assert.equal(reply.body.ok, true)
  assert.equal(nativeCalls[0].request.action, 'reveal')
})

await check('open refuses a path that does not exist', async () => {
  const reply = await callRpc('open', { path: 'missing.ts', cwd: 'C:\\workspace' })
  assert.equal(reply.body.ok, false)
  assert.equal(reply.body.error, 'path-missing')
})

await check('native authorization refusal is terminal, not bypassed', async () => {
  host.state.nativeError = { code: 'gateway/bad-request', message: 'Path has no verified Host path' }
  const openReply = await callRpc('open', { path: 'src/app.ts', cwd: 'C:\\workspace' })
  host.state.nativeError = null
  assert.equal(openReply.body.ok, false)
  assert.equal(openReply.body.error, 'gateway/bad-request')
  assert.equal(openReply.body.fallbackError, undefined)
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

await check('unknown actions fail without throwing', async () => {
  const reply = await callRpc('nope', {})
  assert.equal(reply.body.ok, false)
  assert.equal(reply.body.error, 'unknown-action')
})

await check('openUrl rejects non-http schemes, control characters and empty hosts', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/x', 'https://a\nb', 'http://']) {
    const reply = await callRpc('openUrl', { url })
    assert.equal(reply.body.ok, false, `expected rejection for ${JSON.stringify(url)}`)
    assert.equal(reply.body.error, 'unsupported-url')
  }
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

const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition)
    },
  },
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
  useRef(value) {
    return { current: value }
  },
  useState(value) {
    return [typeof value === 'function' ? value() : value, () => {}]
  },
  useEffect() {},
  useLayoutEffect() {},
  useCallback(fn) {
    return fn
  },
}

const plugin = loaded[0].factory((id) => {
  assert.equal(id, 'react')
  return ReactStub
})

await check('client plugin injects slots and registers one overlay entry', () => {
  assert.deepEqual(plugin.inject, ['slots'])
  const registrations = []
  plugin.apply({
    get(name) {
      if (name === 'slots') {
        return {
          inject(owner, callback) {
            assert.equal(owner, 'shell.overlay')
            callback()
          },
          register(meta, component) {
            registrations.push({ meta, component })
          },
        }
      }
      return undefined
    },
    effect() {},
  })
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].meta.name, 'shell.overlay')
  assert.equal(registrations[0].meta.id, 'chat-ctxmenu')
  assert.equal(typeof registrations[0].component, 'function')
})

// ---------------------------------------------------------------------------

console.log(`\n${results.passed} passed, ${results.failed.length} failed`)
if (results.failed.length > 0) process.exitCode = 1
