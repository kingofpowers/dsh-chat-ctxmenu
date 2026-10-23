/**
 * dsh-chat-ctxmenu — Host half.
 *
 * The browser half renders a right-click menu on conversation content and needs
 * three host-side capabilities:
 *
 *   1. resolve  — turn a path-shaped piece of message text into a host absolute
 *                 path and tell whether it exists (and whether it is a folder).
 *   2. open     — open a file/folder with the OS default program, or reveal it
 *                 in the file manager.
 *   3. apps     — list the applications the OS registered for that exact file,
 *                 so "Open with…" can offer the same choices as the shell.
 *
 * Opening and app listing reuse the Harness' own authorized path-opening channel
 * (`sessionController.openWorkspacePath` / `workspacePathApplications`), which is
 * exactly what the conversation header's "Open In…" control uses. A direct
 * spawn fallback keeps the menu useful on hosts where that service is absent.
 *
 * Transport: POST /dsh-chat-ctxmenu/rpc  { action, args } -> { ok, ... }
 *            GET  /dsh-chat-ctxmenu/status -> diagnostics (also used for checks)
 *
 * Only loopback peers of the Harness web server may call these routes; that is
 * the same posture as the native open channel (a remote browser must not open
 * files on the host desktop).
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const ROUTE_BASE = '/dsh-chat-ctxmenu'
const MAX_PATHS = 8
const MAX_BODY_BYTES = 256 * 1024
const NATIVE_TIMEOUT_MS = 15000
const SPAWN_CONFIRM_MS = 1500

// A Host plugin module is a normal Node module, but stay defensive: a missing
// `process` global must degrade to shape detection instead of failing activation.
const HOST_PLATFORM = (() => {
  try {
    return typeof process !== 'undefined' && typeof process.platform === 'string' ? process.platform : 'unknown'
  } catch {
    return 'unknown'
  }
})()

// Native refusals that must never be bypassed by a direct spawn: the Harness
// decided this host may not open the path (invalid mapping, wrong principal).
const TERMINAL_NATIVE_ERRORS = new Set([
  'native-open-unavailable',
  'native-open-refused',
  'gateway/bad-request',
  'gateway/cancelled',
])

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function asString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function isWindowsPath(abs) {
  return /^[A-Za-z]:[\\/]/.test(abs) || abs.startsWith('\\\\') || abs.includes('\\')
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function sameOrigin(a, b) {
  try {
    const left = new URL(a)
    const right = new URL(b)
    return left.protocol === right.protocol && left.hostname === right.hostname && (left.port || '') === (right.port || '')
  } catch {
    return false
  }
}

function joinFallback(cwd, raw) {
  const windows = isWindowsPath(cwd) || isWindowsPath(raw)
  const separator = windows ? '\\' : '/'
  const base = String(cwd).replace(/[\\/]+$/, '')
  const tail = String(raw).replace(/^[\\/]+/, '')
  return base + separator + tail
}

/** Expand a leading `~` the way a shell would; the fs service does not. */
function expandHome(raw) {
  if (!/^~(?=$|[\\/])/u.test(raw)) return raw
  let home = ''
  try {
    home = homedir()
  } catch {
    home = ''
  }
  if (home === '') return raw
  const rest = raw.slice(1).replace(/^[\\/]+/, '')
  return rest === '' ? home : joinFallback(home, rest)
}

function relativePath(cwd, abs) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  const normalize = (value) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
  const base = normalize(cwd)
  const target = normalize(abs)
  if (base === '' || target === '') return ''
  const lowerBase = base.toLowerCase()
  const lowerTarget = target.toLowerCase()
  if (lowerTarget === lowerBase) return '.'
  if (lowerTarget.startsWith(lowerBase + '/')) return target.slice(base.length + 1)
  return ''
}

/** Explorer splits its command line at `,` and `=`; encode them like the Harness does. */
function explorerTarget(path) {
  return path.replace(/,/g, '%2C').replace(/=/g, '%3D')
}

function validateExternalUrl(value) {
  if (typeof value !== 'string' || value === '') return undefined
  if (/[\u0000-\u001f\u007f]/u.test(value)) return undefined
  let url
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') return undefined
  if (url.protocol !== 'mailto:' && url.hostname === '') return undefined
  return url.href
}

async function readRequestBody(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.code = 'PAYLOAD_TOO_LARGE'
      throw error
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : JSON.parse(raw)
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * The Windows handler list identifies applications by the executable path that
 * registered the association. The Harness' native "open with" adapter invokes
 * the shell handler object instead of launching that executable, and most Win32
 * handlers do not implement that invocation (it fails or silently does
 * nothing), so for those ids this plugin launches the executable directly.
 * Packaged/AUMID handlers keep using the native channel.
 */
export function resolveOpenWithStrategy({ platform, application, registered }) {
  if (registered !== true) return { action: 'reject', error: 'application-not-registered' }
  if (platform !== 'win32') return { action: 'native' }
  if (typeof application !== 'string' || !/\.(?:exe|com)$/iu.test(application)) return { action: 'native' }
  if (!isWindowsPath(application)) return { action: 'native' }
  return { action: 'spawn' }
}

export const name = 'dsh-chat-ctxmenu'

// The RPC route lives on the web server; declaring the dependency parks this
// plugin until that row exists instead of silently registering nothing.
export const inject = ['webServer']

export function apply(ctx) {
  const getFs = () => ctx.get('fs')
  const getSessionController = () => {
    const controller = ctx.get('sessionController')
    return controller !== undefined && typeof controller === 'object' ? controller : undefined
  }

  /**
   * Spawn a detached OS opener and report whether the process really started.
   * Never report success for an executable that does not exist: the error
   * event arrives asynchronously, so wait for `spawn` or a short timeout.
   */
  const spawnDetached = (argv) => new Promise((resolve) => {
    let child
    let timer
    let settled = false
    const settle = (value) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore', windowsHide: true })
    } catch (error) {
      ctx.logger?.debug?.(`[chat-ctxmenu] spawn threw: ${argv[0]}: ${errorMessage(error)}`)
      settle(false)
      return
    }
    child.once('spawn', () => {
      child.unref()
      settle(true)
    })
    child.once('error', (error) => {
      ctx.logger?.debug?.(`[chat-ctxmenu] spawn failed: ${argv[0]}: ${errorMessage(error)}`)
      settle(false)
    })
    timer = setTimeout(() => settle(true), SPAWN_CONFIRM_MS)
  })

  /**
   * The native path channel validates an `AbortSignal` before touching the
   * filesystem, and a stuck opener must not hold the HTTP request forever.
   */
  const newSignal = () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NATIVE_TIMEOUT_MS)
    return {
      signal: controller.signal,
      release() {
        clearTimeout(timer)
      },
    }
  }

  /**
   * The client sends the Session id it belongs to; when the Session working
   * directory is not already known, read it from the live Session header so a
   * relative path resolves exactly like it does for the agent.
   */
  const resolveCwd = (cwd, sessionId) => {
    if (typeof cwd === 'string' && cwd !== '') return cwd
    if (typeof sessionId === 'string' && sessionId !== '') {
      try {
        const sessions = ctx.get('sessions')
        const session = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
        const header = session !== undefined && session !== null ? session.header : undefined
        if (header !== undefined && header !== null && typeof header.cwd === 'string' && header.cwd !== '') return header.cwd
      } catch {
        // fall through to the unresolved-cwd behaviour
      }
    }
    return undefined
  }

  const isDirectoryInfo = (info) => {
    if (info === undefined || info === null) return false
    const kind = info.type ?? info.kind
    return kind === 'directory' || kind === 'dir'
  }

  const describePath = async (raw, cwd) => {
    const expanded = expandHome(raw)
    const fs = getFs()
    if (fs === undefined) {
      return { input: raw, absolute: cwd === undefined ? expanded : joinFallback(cwd, expanded), exists: false, isDir: false, error: 'fs-unavailable' }
    }
    let target
    let absolute = cwd === undefined ? expanded : joinFallback(cwd, expanded)
    try {
      target = await fs.resolve(expanded, cwd === undefined ? {} : { cwd })
      const processed = fs.processPath(target)
      if (typeof processed === 'string' && processed !== '') absolute = processed
    } catch {
      // A not-yet-created path may not resolve; the joined fallback above is
      // still good enough to copy and compare against the session directory.
    }
    let exists = false
    let isDir = false
    if (target !== undefined) {
      try {
        const info = await fs.stat(target)
        if (info !== undefined && info !== null) {
          exists = true
          isDir = isDirectoryInfo(info)
        }
      } catch {
        exists = false
      }
    }
    if (!exists) {
      try {
        const info = await fs.lstat(expanded, cwd === undefined ? undefined : { cwd })
        if (info !== undefined && info !== null) {
          exists = true
          isDir = isDirectoryInfo(info)
        }
      } catch {
        exists = false
      }
    }
    return { input: raw, absolute, exists, isDir }
  }

  const platformInfo = async () => {
    const controller = getSessionController()
    if (controller !== undefined && typeof controller.workspaceDesktop === 'function') {
      try {
        const desktop = controller.workspaceDesktop()
        if (desktop !== undefined && desktop !== null) {
          const fileManager = desktop.fileManager ?? null
          const platform = fileManager === 'explorer' ? 'windows' : fileManager === 'finder' ? 'macos' : 'linux'
          return { platform, available: desktop.available === true, fileManager, native: true }
        }
      } catch {
        // fall through to shape detection
      }
    }
    const fs = getFs()
    if (fs !== undefined) {
      try {
        const target = await fs.resolve('.', {})
        const processed = fs.processPath(target)
        if (typeof processed === 'string') {
          return { platform: isWindowsPath(processed) ? 'windows' : 'posix', available: true, fileManager: null, native: false }
        }
      } catch {
        // unknown
      }
    }
    return { platform: 'unknown', available: false, fileManager: null, native: false }
  }

  const nativeCanOpen = () => {
    const controller = getSessionController()
    if (controller === undefined || typeof controller.canOpenWorkspacePath !== 'function') return undefined
    try {
      return controller.canOpenWorkspacePath() === true
    } catch {
      return undefined
    }
  }

  const nativeError = (error) => {
    const record = asRecord(error)
    const code = asString(record.code) ?? asString(record.name)
    const message = asString(record.message) ?? errorMessage(error)
    return code === undefined ? { ok: false, error: 'native-open-failed', detail: message } : { ok: false, error: code, detail: message }
  }

  const nativeOpen = async (absolute, mode, application) => {
    const controller = getSessionController()
    if (controller === undefined || typeof controller.openWorkspacePath !== 'function') return null
    const canOpen = nativeCanOpen()
    if (canOpen === false) return { ok: false, error: 'native-open-unavailable' }
    const { signal, release } = newSignal()
    try {
      const request = mode === 'reveal' ? { action: 'reveal', path: absolute } : { path: absolute }
      if (mode === 'openWith' && typeof application === 'string' && application !== '') request.application = application
      const value = await controller.openWorkspacePath(request, signal)
      if (value !== undefined && value !== null && value.opened === true) return { ok: true }
      return { ok: false, error: 'native-open-refused' }
    } catch (error) {
      return nativeError(error)
    } finally {
      release()
    }
  }

  const fallbackOpen = async (absolute) => {
    if (HOST_PLATFORM === 'win32' || isWindowsPath(absolute)) {
      if (await spawnDetached(['explorer.exe', absolute])) return { ok: true }
      return { ok: false, error: 'no-native-opener' }
    }
    if (await spawnDetached(['open', absolute])) return { ok: true }
    if (await spawnDetached(['xdg-open', absolute])) return { ok: true }
    return { ok: false, error: 'no-native-opener' }
  }

  const fallbackReveal = async (absolute, isDir) => {
    if (HOST_PLATFORM === 'win32' || isWindowsPath(absolute)) {
      const argv = isDir ? ['explorer.exe', absolute] : ['explorer.exe', `/select,${explorerTarget(absolute)}`]
      if (await spawnDetached(argv)) return { ok: true }
      return { ok: false, error: 'no-native-opener' }
    }
    if (!isDir && (await spawnDetached(['open', '-R', absolute]))) return { ok: true }
    if (await spawnDetached(['open', absolute])) return { ok: true }
    if (await spawnDetached(['xdg-open', absolute])) return { ok: true }
    return { ok: false, error: 'no-native-opener' }
  }

  const openPath = async (absolute, mode, isDir) => {
    const native = await nativeOpen(absolute, mode)
    if (native !== null) {
      if (native.ok) return native
      // Authorization and validation refusals are terminal. Only an absent
      // service or an explicit opener failure may use the direct spawn path.
      if (TERMINAL_NATIVE_ERRORS.has(native.error)) return native
      if (typeof native.error === 'string' && native.error.startsWith('gateway/') && native.error !== 'gateway/internal') return native
      const fallback = mode === 'reveal' ? await fallbackReveal(absolute, isDir) : await fallbackOpen(absolute)
      if (fallback.ok) return fallback
      return { ...native, fallbackError: fallback.error }
    }
    if (mode === 'reveal') return fallbackReveal(absolute, isDir)
    return fallbackOpen(absolute)
  }

  const appCache = new Map()
  const APP_CACHE_TTL_MS = 60000
  const APP_CACHE_MAX = 32

  const listApplications = async (absolute) => {
    const controller = getSessionController()
    if (controller === undefined || typeof controller.workspacePathApplications !== 'function') return []
    const cacheKey = absolute.toLowerCase()
    const cached = appCache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < APP_CACHE_TTL_MS) return cached.apps
    const { signal, release } = newSignal()
    try {
      const raw = await controller.workspacePathApplications({ path: absolute }, signal)
      const entries = Array.isArray(raw) ? raw : asRecord(raw).applications ?? asRecord(raw).apps ?? []
      if (!Array.isArray(entries)) return []
      const apps = []
      for (const entry of entries.slice(0, 24)) {
        const record = asRecord(entry)
        const id = asString(record.id) ?? asString(record.applicationId) ?? asString(record.identifier) ?? asString(record.key)
        const appName = asString(record.name) ?? asString(record.title) ?? asString(record.label) ?? asString(record.displayName) ?? id
        if (id !== undefined && appName !== undefined) apps.push({ id, name: appName, isDefault: record.default === true })
      }
      apps.sort((left, right) => (left.isDefault === right.isDefault ? 0 : left.isDefault ? -1 : 1))
      appCache.set(cacheKey, { apps, at: Date.now() })
      if (appCache.size > APP_CACHE_MAX) {
        const oldest = appCache.keys().next()
        if (oldest.done !== true) appCache.delete(oldest.value)
      }
      return apps
    } catch {
      return []
    } finally {
      release()
    }
  }

  const openWithDialog = async (absolute) => {
    if (nativeCanOpen() === false) return { ok: false, error: 'native-open-unavailable' }
    if (!(HOST_PLATFORM === 'win32') && !isWindowsPath(absolute)) {
      return { ok: false, error: 'open-with-dialog-unsupported' }
    }
    if (await spawnDetached(['rundll32.exe', 'shell32.dll,OpenAs_RunDLL', absolute])) return { ok: true }
    return { ok: false, error: 'no-open-with-dialog' }
  }

  const openExternal = async (url) => {
    const validated = validateExternalUrl(url)
    if (validated === undefined) return { ok: false, error: 'unsupported-url' }
    if (HOST_PLATFORM === 'win32') {
      const literal = validated.replace(/'/g, "''")
      if (await spawnDetached(['powershell.exe', '-NoProfile', '-Command', `Start-Process '${literal}'`])) return { ok: true }
      return { ok: false, error: 'no-browser-opener' }
    }
    if (HOST_PLATFORM === 'darwin') {
      if (await spawnDetached(['open', validated])) return { ok: true }
      return { ok: false, error: 'no-browser-opener' }
    }
    if (await spawnDetached(['xdg-open', validated])) return { ok: true }
    return { ok: false, error: 'no-browser-opener' }
  }

  const describeOrFail = async (record) => {
    const raw = asString(record.path)
    if (raw === undefined) return { error: { ok: false, error: 'path-required' } }
    const described = await describePath(raw, resolveCwd(asString(record.cwd), asString(record.sessionId)))
    if (described.error === 'fs-unavailable') return { error: { ok: false, error: 'fs-unavailable' } }
    return { described }
  }

  const actions = {
    async resolve(args) {
      const record = asRecord(args)
      const cwd = resolveCwd(asString(record.cwd), asString(record.sessionId))
      const inputs = Array.isArray(record.paths) ? record.paths.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, MAX_PATHS) : []
      if (inputs.length === 0) return { ok: true, results: [] }
      const results = []
      for (const input of inputs) results.push(await describePath(input, cwd))
      return { ok: true, cwd: cwd ?? null, results }
    },

    async open(args) {
      const { described, error } = await describeOrFail(asRecord(args))
      if (error !== undefined) return error
      if (!described.exists) return { ok: false, error: 'path-missing', path: described.absolute }
      return openPath(described.absolute, 'open', described.isDir)
    },

    async reveal(args) {
      const { described, error } = await describeOrFail(asRecord(args))
      if (error !== undefined) return error
      if (!described.exists) return { ok: false, error: 'path-missing', path: described.absolute }
      return openPath(described.absolute, 'reveal', described.isDir)
    },

    async apps(args) {
      const { described, error } = await describeOrFail(asRecord(args))
      if (error !== undefined) return error
      const info = await platformInfo()
      if (!described.exists) return { ok: false, error: 'path-missing', platform: info.platform }
      if (described.isDir) return { ok: true, platform: info.platform, apps: [], canOpenWithDialog: false, path: described.absolute }
      const apps = await listApplications(described.absolute)
      return { ok: true, platform: info.platform, apps, canOpenWithDialog: info.platform === 'windows' && nativeCanOpen() !== false, path: described.absolute }
    },

    async openWith(args) {
      const record = asRecord(args)
      const application = asString(record.application)
      if (application === undefined) return { ok: false, error: 'path-and-application-required' }
      const { described, error } = await describeOrFail(record)
      if (error !== undefined) return error
      if (!described.exists) return { ok: false, error: 'path-missing', path: described.absolute }
      const listed = await listApplications(described.absolute)
      const registered = listed.some((entry) => entry.id.toLowerCase() === application.toLowerCase())
      const strategy = resolveOpenWithStrategy({ platform: HOST_PLATFORM, application, registered })
      if (strategy.action === 'reject') return { ok: false, error: strategy.error }
      if (strategy.action === 'spawn') {
        const executable = await describePath(application, undefined)
        if (executable.exists !== true || executable.isDir === true) return { ok: false, error: 'application-missing' }
        if (await spawnDetached([executable.absolute, described.absolute])) return { ok: true }
        // Fall back to the native handler once the direct launch could not start.
        const native = await nativeOpen(described.absolute, 'openWith', application)
        if (native !== null && native.ok === true) return native
        return { ok: false, error: 'application-launch-failed', detail: native === null ? undefined : native.detail }
      }
      const native = await nativeOpen(described.absolute, 'openWith', application)
      if (native === null) return { ok: false, error: 'open-with-unsupported' }
      return native
    },

    async openWithDialog(args) {
      const { described, error } = await describeOrFail(asRecord(args))
      if (error !== undefined) return error
      if (!described.exists) return { ok: false, error: 'path-missing', path: described.absolute }
      return openWithDialog(described.absolute)
    },

    async openUrl(args) {
      const record = asRecord(args)
      const url = asString(record.url)
      if (url === undefined) return { ok: false, error: 'url-required' }
      return openExternal(url.trim())
    },

    async status() {
      const info = await platformInfo()
      const native = getSessionController() !== undefined
      const canOpen = nativeCanOpen()
      return {
        ok: true,
        ...info,
        native,
        canOpen: canOpen === undefined ? info.available !== false : canOpen,
        fs: getFs() !== undefined,
        relativePathResolvedByHost: true,
        maxPaths: MAX_PATHS,
        version: 1,
        rev: 4,
      }
    },
  }

  const dispatch = async (action, args) => {
    const fn = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : undefined
    if (typeof fn !== 'function') return { ok: false, error: 'unknown-action' }
    try {
      return await fn(args)
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('[chat-ctxmenu] webServer service unavailable; RPC route not registered')
    return
  }
  const getOrigin = () => {
    try {
      return typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
    } catch {
      return ''
    }
  }

  /**
   * Fail closed: a loopback-only surface, and any browser request that carries
   * an Origin must match the Harness origin. An unknown expected origin rejects
   * rather than admitting the caller.
   */
  const guard = (request) => {
    const remote = request.socket === undefined ? undefined : request.socket.remoteAddress
    if (!isLoopbackAddress(remote)) return { ok: false, error: 'loopback-only' }
    const origin = asString(request.headers.origin)
    if (origin !== undefined) {
      const expected = getOrigin()
      if (expected === '' || !sameOrigin(origin, expected)) return { ok: false, error: 'origin-not-allowed' }
    }
    const site = asString(request.headers['sec-fetch-site'])
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return { ok: false, error: 'origin-not-allowed' }
    return { ok: true }
  }

  ctx.effect(() => {
    const disposeRpc = webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/rpc`,
      handler: async (request, response) => {
        const allowed = guard(request)
        if (!allowed.ok) {
          writeJson(response, 403, allowed)
          return
        }
        let body
        try {
          body = await readRequestBody(request, MAX_BODY_BYTES)
        } catch (error) {
          const tooLarge = error instanceof Error && error.code === 'PAYLOAD_TOO_LARGE'
          writeJson(response, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'payload-too-large' : 'invalid-json' })
          return
        }
        const record = asRecord(body)
        const action = asString(record.action) ?? ''
        const result = await dispatch(action, record.args)
        writeJson(response, 200, result)
      },
    })

    const disposeStatus = webServer.register({
      kind: 'exact',
      path: `${ROUTE_BASE}/status`,
      handler: async (request, response) => {
        const allowed = guard(request)
        if (!allowed.ok) {
          writeJson(response, 403, allowed)
          return
        }
        try {
          const url = new URL(request.url ?? '/', 'http://localhost')
          const probe = url.searchParams.get('probe')
          const status = await dispatch('status', {})
          if (probe !== null && probe.trim() !== '') {
            const cwd = url.searchParams.get('cwd') ?? undefined
            const described = await describePath(probe, cwd)
            const base = cwd !== undefined && cwd !== '' ? cwd : ''
            writeJson(response, 200, {
              ...status,
              probe: described,
              relative: relativePath(base, described.absolute ?? ''),
            })
            return
          }
          writeJson(response, 200, status)
        } catch (error) {
          writeJson(response, 500, { ok: false, error: errorMessage(error) })
        }
      },
    })

    return () => {
      try {
        if (typeof disposeRpc === 'function') disposeRpc()
      } catch {
        // ignore teardown races
      }
      try {
        if (typeof disposeStatus === 'function') disposeStatus()
      } catch {
        // ignore teardown races
      }
    }
  }, 'dsh-chat-ctxmenu: rpc routes')
}
