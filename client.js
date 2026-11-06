/**
 * dsh-chat-ctxmenu — Client half (Web bundle).
 *
 * DSH 0.2.2 ships the official context-menu framework
 * (`@deepseek-ai/dsh-client-ui-context-menu`). That framework owns every
 * right-click gesture it is bound to, plus the shared menu presentation
 * (positioning, keyboard navigation, icons, toasts). This plugin no longer
 * renders a menu of its own: the gesture hook belongs to the official feature.
 *
 * What remains ours, contributed into the official menu:
 *
 *   - `file`    → "Copy relative path" and "Open with ▸" (the applications the
 *                 system registered for that file, including the direct
 *                 executable launch the Windows shell handlers do not perform).
 *   - `directory` → "Copy relative path".
 *   - `image`   → "Copy image link" (an http(s) source, never a blob URL).
 *   - `chatMessage` → a plugin-defined target used for plain message text:
 *                 "Copy selection" and "Copy whole message".
 *
 * Two document listeners cooperate for gestures the official chat surface does
 * not claim:
 *
 *   - a capture-phase counter only — it never calls preventDefault and never
 *     opens anything; it invalidates a pending fallback resolve whenever a
 *     newer gesture happens (pointer or keyboard);
 *   - a bubble-phase handler that checks `event.defaultPrevented` (official
 *     triggers sit on their own elements, call preventDefault + stopPropagation,
 *     and are therefore never stolen), then decides *which official target* the
 *     gesture belongs to. Gestures outside conversation content — the workspace
 *     rows, any other surface — are left entirely to the official UI. A URL
 *     under the caret outranks any path token in the same block; otherwise a
 *     path-shaped token (relative path, `~`, UNC, `path:line`, bare filename) is
 *     verified by the Host and opens the official `file`/`directory` menu; any
 *     other text opens the plugin's `chatMessage` menu.
 *
 * Transport: POST /dsh-chat-ctxmenu/rpc  { action, args } -> { ok, ... }
 * Only the actions the official menu cannot provide live there: `resolve`
 * (prose path verification), `apps` / `openWith` / `openWithDialog`, and
 * `status` for diagnostics.
 */

window.__ModuleLoader__.load({
  id: 'dsh-chat-ctxmenu',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const RPC_ENDPOINT = '/dsh-chat-ctxmenu/rpc'
    const RPC_TIMEOUT_MS = 6000
    const MESSAGE_SELECTOR = '[data-chat-flow-kind]'
    const EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'
    const BLOCK_SELECTOR = 'p, li, pre, blockquote, td, th, h1, h2, h3, h4, h5, h6'
    const URL_SCHEMES = /^(?:https?:\/\/|mailto:)/i

    const STRINGS = {
      zh: {
        openWith: '用其他应用打开',
        chooseApp: '选择其他程序…',
        defaultApp: '默认',
        copyRelative: '复制相对路径',
        copySelection: '复制选中内容',
        copyMessage: '复制整条消息',
        copyImageLink: '复制图片链接',
        copied: '已复制',
        copyFailed: '复制失败',
        openFailed: '打开失败',
        errAppNotRegistered: '这个程序没有注册为此文件类型的打开方式',
        errAppMissing: '找不到这个程序（可能已卸载或移动）',
        errAppLaunchFailed: '这个程序没能启动',
        errSystemOpen: '系统打开接口调用失败',
      },
      en: {
        openWith: 'Open with',
        chooseApp: 'Choose another app…',
        defaultApp: 'default',
        copyRelative: 'Copy relative path',
        copySelection: 'Copy selection',
        copyMessage: 'Copy whole message',
        copyImageLink: 'Copy image link',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        openFailed: 'Open failed',
        errAppNotRegistered: 'That application is not registered for this file type',
        errAppMissing: 'That application could not be found (uninstalled or moved?)',
        errAppLaunchFailed: 'That application did not start',
        errSystemOpen: 'The system open call failed',
      },
    }

    // One icon per action family; registered into the official `contextMenu.icon`
    // slot so contributed rows align with the built-in rows.
    const ICONS = {
      'copy-relative': 'M4 12h16M12 4l4 4-4 4M12 20l-4-4 4-4',
      'copy-selection': 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
      'copy-message': 'M4 4h16v12H7l-3 3z',
      apps: 'M12 3l1.2 4.8L18 9l-4.8 1.2L12 15l-1.2-4.8L6 9l4.8-1.2z',
      link: 'M10 14a5 5 0 0 1 0-7l2-2a5 5 0 0 1 7 7l-2 2M14 10a5 5 0 0 1 0 7l-2 2a5 5 0 0 1-7-7l2-2',
    }

    // ------------------------------------------------------------------
    // Text utilities
    // ------------------------------------------------------------------

    const TRAILING = /[.,;!?，。；：！？、）)\]}>"'`]+$/u
    const LEADING = /^[([{"'`]+/u

    function trimToken(raw) {
      let value = String(raw).trim()
      value = value.replace(LEADING, '')
      let previous = ''
      while (previous !== value) {
        previous = value
        value = value.replace(TRAILING, '')
      }
      return value
    }

    function stripLineSuffix(value) {
      const match = /^(.*?\.[A-Za-z0-9_]+)((?::\d+){1,2})$/.exec(value)
      if (match === null) return { path: value, line: undefined }
      return { path: match[1], line: match[2].slice(1) }
    }

    function relativePath(cwd, absolute) {
      if (typeof cwd !== 'string' || cwd === '' || typeof absolute !== 'string' || absolute === '') return ''
      const normalize = (value) => value.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
      const base = normalize(cwd)
      const target = normalize(absolute)
      if (base === '') return ''
      const lowerBase = base.toLowerCase()
      const lowerTarget = target.toLowerCase()
      if (lowerTarget === lowerBase) return '.'
      if (lowerTarget.startsWith(lowerBase + '/')) return target.slice(base.length + 1)
      return ''
    }

    function looksLikeBareFilename(value) {
      return /^[\w@.+\- ]+\.[A-Za-z0-9]{1,12}$/u.test(value) && !/[\\/]/u.test(value)
    }

    function isAbsolutePathKind(kind) {
      return kind === 'win' || kind === 'unc' || kind === 'posix' || kind === 'home'
    }

    /**
     * Find path-shaped tokens in a plain text run. Every match keeps its
     * offsets so a caret position can pick the exact token under the pointer.
     */
    function scanPaths(text) {
      if (typeof text !== 'string' || text === '') return []
      const tokens = []
      const urls = []
      const add = (raw, start, end, kind) => {
        const value = trimToken(raw)
        if (value.length < 2) return
        if (value.includes('://')) return
        tokens.push({ raw: value, start, end, kind, absolute: isAbsolutePathKind(kind) })
      }

      for (const match of text.matchAll(/\b(?:https?:\/\/|file:\/\/)[^\s<>"'`）)\]】,，。；;]+/giu)) {
        urls.push({ start: match.index, end: match.index + match[0].length })
      }
      const isInsideUrl = (start, end) => urls.some((url) => start < url.end && end > url.start)

      const scanners = [
        // Quoted Windows path, which may contain spaces.
        [/(["'`])([A-Za-z]:[\\/][^"'`\n\r]*?)\1/gu, 2, 'win'],
        // Bare Windows drive path (no spaces).
        [/(?:^|[\s([{"'`])([A-Za-z]:[\\/][^\s<>"|?*]*)/gu, 1, 'win'],
        // UNC share.
        [/(?:^|[\s([{"'`])(\\\\[^\s"'`<>|]+)/gu, 1, 'unc'],
        // POSIX absolute path.
        [/(?:^|[\s([{"'`])(\/(?:[^\s"'`<>|/]+\/)+[^\s"'`<>|,;:]+)/gu, 1, 'posix'],
        // Home-relative path.
        [/(?:^|[\s([{"'`])(~[\\/][^\s"'`<>|]+)/gu, 1, 'home'],
        // Relative path with at least one separator, e.g. src/app.ts or ./dist/x.js
        [/(?:^|[\s([{"'`])((?:\.{1,2}[\\/])?(?:[\w.@+\-]+[\\/])+[\w.@+\-]+)/gu, 1, 'relative'],
      ]

      for (const [pattern, group, kind] of scanners) {
        for (const match of text.matchAll(pattern)) {
          const captured = match[group]
          if (typeof captured !== 'string') continue
          const offset = match.index + match[0].indexOf(captured)
          const start = offset
          const end = offset + captured.length
          if (isInsideUrl(start, end)) continue
          add(captured, start, end, kind)
        }
      }

      tokens.sort((left, right) => (left.start - right.start) || (right.end - right.start) - (left.end - left.start))
      // Keep one entry per occurrence: the caret hit test needs the offsets of
      // every occurrence, not just the first spelling of a repeated token.
      const deduped = []
      const seen = new Set()
      for (const token of tokens) {
        const key = `${token.start}:${token.raw.toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        deduped.push(token)
      }
      return deduped
    }

    function scanUrls(text) {
      if (typeof text !== 'string' || text === '') return []
      const found = []
      for (const match of text.matchAll(/\b(?:https?:\/\/)[^\s<>"'`）)\]】,，。；;]+/giu)) {
        const href = trimToken(match[0])
        if (href.length < 8) continue
        found.push({ href, start: match.index, end: match.index + match[0].length })
      }
      return found
    }

    function caretInfoAt(x, y) {
      let node
      let offset
      try {
        if (typeof document.caretPositionFromPoint === 'function') {
          const position = document.caretPositionFromPoint(x, y)
          if (position !== null && position !== undefined) {
            node = position.offsetNode
            offset = position.offset
          }
        } else if (typeof document.caretRangeFromPoint === 'function') {
          const range = document.caretRangeFromPoint(x, y)
          if (range !== null && range !== undefined) {
            node = range.startContainer
            offset = range.startOffset
          }
        }
      } catch {
        return null
      }
      if (node === undefined || node === null || node.nodeType !== 3 || typeof offset !== 'number') return null
      const text = typeof node.data === 'string' ? node.data : (node.textContent ?? '')
      return { text, offset, tokens: scanPaths(text) }
    }

    /**
     * An unquoted Windows path with spaces is truncated by any whitespace
     * tokenizer. Offer the longest plausible extension as a second candidate;
     * the Host only opens the one that actually exists.
     */
    function extendAbsoluteToken(text, token) {
      if (token === null || token === undefined || token.absolute !== true) return null
      if (typeof text !== 'string' || text === '') return null
      let end = token.end
      let guard = 0
      while (end < text.length && guard < 40) {
        guard += 1
        const space = /^[ \t]+/u.exec(text.slice(end))
        if (space === null) break
        const nextStart = end + space[0].length
        let nextEnd = nextStart
        while (nextEnd < text.length && !/[\s<>"|]/u.test(text[nextEnd])) nextEnd += 1
        if (nextEnd === nextStart) break
        const chunk = text.slice(nextStart, nextEnd)
        if (/[。；;!?！？]$/u.test(chunk)) break
        if (/^[（(【[\]）)]/u.test(chunk)) break
        end = nextEnd
        if (end - token.start > 240) break
      }
      if (end === token.end) return null
      return trimToken(text.slice(token.start, end))
    }

    /** Serialize a DOM subtree with block boundaries kept as newlines. */
    function textWithBreaks(root) {
      const BLOCK = /^(P|LI|PRE|BLOCKQUOTE|DIV|SECTION|ARTICLE|UL|OL|TABLE|TBODY|THEAD|TR|TD|TH|H[1-6])$/u
      let out = ''
      const walk = (node) => {
        if (node === null || node === undefined) return
        if (node.nodeType === 3) {
          out += node.data
          return
        }
        if (node.nodeType !== 1) return
        if (node.tagName === 'BR') {
          out += '\n'
          return
        }
        const block = BLOCK.test(node.tagName)
        if (block) out += '\n'
        for (const child of node.childNodes) walk(child)
        if (block) out += '\n'
      }
      walk(root)
      return out
    }

    function extractMessageText(root) {
      if (root === undefined || root === null) return ''
      try {
        const clone = root.cloneNode(true)
        const drop = clone.querySelectorAll('button, svg, style, script, [aria-hidden="true"], [data-ctxmenu-ignore]')
        for (const node of drop) node.remove()
        return String(textWithBreaks(clone))
          .replace(/\r\n?/gu, '\n')
          .split('\n')
          .map((line) => line.replace(/[ \t]+$/u, ''))
          .join('\n')
          .replace(/\n{3,}/gu, '\n\n')
          .trim()
      } catch {
        return ''
      }
    }

    function readSelectionWithin(root) {
      try {
        const selection = window.getSelection()
        if (selection === null || selection === undefined || selection.isCollapsed === true) return ''
        const text = String(selection.toString())
        if (text.trim() === '') return ''
        const anchor = selection.anchorNode
        if (root !== undefined && root !== null && anchor !== null && anchor !== undefined && !root.contains(anchor)) return ''
        return text.replace(/^\s+|\s+$/gu, '')
      } catch {
        return ''
      }
    }

    function detectElementHint(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null
      const selectors = [
        'button[title]',
        'a[title]',
        'span[title]',
        'code[title]',
        '[title]',
      ]
      for (const selector of selectors) {
        const element = target.closest(selector)
        if (element === null) continue
        const title = element.getAttribute('title')
        if (typeof title !== 'string') continue
        const value = trimToken(title)
        if (value.length < 2) continue
        if (!/[\\/]/u.test(value) && !looksLikeBareFilename(value)) continue
        return { path: value }
      }
      return null
    }

    function detectLink(target) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null
      const anchor = target.closest('a[href]')
      if (anchor === null) return null
      const href = typeof anchor.href === 'string' && anchor.href !== '' ? anchor.href : anchor.getAttribute('href')
      if (typeof href !== 'string' || href === '') return null
      if (href.toLowerCase().startsWith('file://')) return null
      if (!URL_SCHEMES.test(href)) return null
      return { href, text: String(anchor.textContent ?? '').trim() }
    }

    /**
     * `scanPaths` deliberately excludes URL tokens (they are not file paths), so
     * a URL under the caret is looked up in the caret's own text instead. A caret
     * hit is authoritative: it must outrank path tokens elsewhere in the same
     * text block, otherwise right-clicking a URL next to a path opens the file
     * menu. When the pointer is not on a text node, an unambiguous URL in the
     * surrounding block wins.
     */
    function detectTextUrl(target, caret) {
      if (caret !== null) {
        for (const match of caret.text.matchAll(/\bhttps?:\/\/[^\s<>"'`）)\]】,，。；;]+/giu)) {
          const start = match.index
          const end = start + match[0].length
          if (caret.offset < start - 1 || caret.offset > end + 1) continue
          const href = trimToken(match[0])
          if (href.length < 8) continue
          return { href, text: href, fromCaret: true }
        }
        return null
      }
      const block = target !== null && target !== undefined && typeof target.closest === 'function'
        ? target.closest(BLOCK_SELECTOR)
        : null
      if (block === null || block === undefined) return null
      const urls = scanUrls(block.innerText !== undefined ? block.innerText : (block.textContent ?? ''))
      return urls.length === 1 ? { href: urls[0].href, text: urls[0].href, fromCaret: false } : null
    }

    function buildCandidates(target, caret, messageEl, hint) {
      const candidates = []
      const push = (raw, confidence, source) => {
        const trimmed = trimToken(raw)
        if (trimmed === '' || trimmed.length < 2) return
        if (trimmed.includes('://')) return
        // "src/app.ts:12:4" is a location, not a path: resolve the file itself
        // and keep the suffix only as a display hint.
        const split = stripLineSuffix(trimmed)
        if (split.path.length < 2) return
        if (candidates.some((entry) => entry.raw.toLowerCase() === split.path.toLowerCase())) return
        candidates.push({ raw: split.path, line: split.line, confidence, source })
      }

      if (caret !== null) {
        const hit = caret.tokens.find((token) => caret.offset >= token.start - 1 && caret.offset <= token.end + 1)
        if (hit !== undefined && !/^https?:\/\//iu.test(hit.raw)) {
          const extended = extendAbsoluteToken(caret.text, hit)
          if (extended !== null) push(extended, 'high', 'caret-extended')
          push(hit.raw, hit.absolute ? 'high' : 'low', 'caret')
        }
      }
      if (hint !== null && typeof hint.path === 'string') push(hint.path, 'high', 'element')

      let block = null
      if (target !== null && target !== undefined && typeof target.closest === 'function') {
        block = target.closest(`${BLOCK_SELECTOR}, code, summary, a`)
      }
      if (block === null || block === undefined) block = messageEl
      const blockIsCode = block !== null && block !== undefined && (block.tagName === 'PRE' || block.tagName === 'CODE')
      const blockText = block === null || block === undefined ? '' : String(block.innerText !== undefined ? block.innerText : (block.textContent ?? ''))
      const blockTokens = scanPaths(blockText)
      if (blockTokens.length === 1) {
        const token = blockTokens[0]
        const extended = extendAbsoluteToken(blockText, token)
        if (extended !== null) push(extended, 'high', 'block-extended')
        push(token.raw, token.absolute || blockIsCode ? 'high' : 'low', 'block')
      } else if (blockTokens.length > 1) {
        // Several candidates: only an unambiguous absolute path may be offered,
        // otherwise the menu would guess at whichever file it saw first.
        const absolute = blockTokens.filter((token) => token.absolute)
        if (absolute.length === 1) {
          const extended = extendAbsoluteToken(blockText, absolute[0])
          if (extended !== null) push(extended, 'high', 'block-extended')
          push(absolute[0].raw, 'high', 'block')
        }
      }
      if (blockIsCode) {
        const code = String(block.textContent ?? '').trim()
        if (looksLikeBareFilename(code)) push(code, 'high', 'code')
      } else if (blockTokens.length === 0 && blockText !== '') {
        // A filename quoted in prose (for example `app.ts` written without
        // backticks) is still worth offering, but only once the Host confirms
        // it exists next to the Session working directory.
        let count = 0
        for (const match of blockText.matchAll(/(?:^|[\s`"'（(])((?:[\w@+\-]+\.)+[A-Za-z][A-Za-z0-9]{0,11})(?=$|[\s`"'，。、）),;:])/gu)) {
          push(match[1], 'low', 'prose')
          count += 1
          if (count >= 3) break
        }
      }
      return candidates.slice(0, 6)
    }

    function detectLanguage(locale) {
      try {
        const snapshot = locale !== undefined && locale !== null && typeof locale.getLocale === 'function' ? locale.getLocale() : undefined
        if (snapshot !== undefined && snapshot !== null) {
          const direct = typeof snapshot.locale === 'string'
            ? snapshot.locale
            : (typeof snapshot.active === 'string'
              ? snapshot.active
              : (snapshot.active !== undefined && snapshot.active !== null && typeof snapshot.active === 'object'
                ? (snapshot.active.id ?? snapshot.active.locale ?? snapshot.active.localeId)
                : undefined))
          if (typeof direct === 'string' && direct !== '') {
            const lower = direct.toLowerCase()
            if (lower.startsWith('zh')) return 'zh'
            if (lower.startsWith('en')) return 'en'
          }
        }
      } catch {
        // fall through to the browser locale
      }
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.language === 'string') {
          return navigator.language.toLowerCase().startsWith('en') ? 'en' : 'zh'
        }
      } catch {
        // ignore
      }
      return 'zh'
    }

    // ------------------------------------------------------------------
    // Session and path plumbing
    // ------------------------------------------------------------------

    /**
     * The main-view Session is the one the conversation renders. The official
     * list snapshot carries local retain counts on every row (`ids` holds the
     * Host order while `byId` also keeps retained subagent rows), so no extra
     * subscription is created; `useSessions` is not available outside render.
     */
    function currentSessionId(sessions) {
      try {
        if (sessions === undefined || sessions === null) return undefined
        const snapshot = typeof sessions.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
        if (snapshot === undefined || snapshot === null) return undefined
        const mainView = (row) => row !== undefined && row !== null && row.retainedBy !== undefined && row.retainedBy !== null
          ? row.retainedBy.mainView
          : undefined
        if (Array.isArray(snapshot.ids)) {
          for (const id of snapshot.ids) {
            const retained = mainView(snapshot.byId !== undefined && snapshot.byId !== null ? snapshot.byId[id] : undefined)
            if (typeof retained === 'number' && retained > 0) return id
          }
        }
        if (snapshot.byId !== undefined && snapshot.byId !== null) {
          for (const [id, row] of Object.entries(snapshot.byId)) {
            const retained = mainView(row)
            if (typeof retained === 'number' && retained > 0) return id
          }
        }
        return undefined
      } catch {
        return undefined
      }
    }

    function sessionCwd(sessions, sessionId) {
      try {
        const snapshot = sessions?.list?.getSnapshot?.()
        const row = snapshot !== undefined && snapshot !== null && snapshot.byId !== undefined ? snapshot.byId[sessionId] : undefined
        return row !== undefined && row !== null && typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined
      } catch {
        return undefined
      }
    }

    /** Join a workspace-relative path the way the official `resolveWorkspacePath` does. */
    function absolutePathOf(cwd, raw) {
      if (typeof raw !== 'string' || raw === '') return raw
      if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')) return raw
      if (typeof cwd !== 'string' || cwd === '') return raw
      const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.includes('\\')
      const separator = windows ? '\\' : '/'
      const base = cwd.replace(/[\\/]+$/, '')
      const tail = raw.replace(/^(?:\.{1,2}[\\/])+/, '')
      return `${base}${separator}${tail}`
    }

    function errorMessage(error) {
      if (error instanceof Error) return error.message
      return typeof error === 'string' ? error : String(error)
    }

    const ERROR_KEYS = {
      'application-not-registered': 'errAppNotRegistered',
      'application-missing': 'errAppMissing',
      'application-launch-failed': 'errAppLaunchFailed',
      'gateway/internal': 'errSystemOpen',
    }

    function describeError(reply, fallback, translate) {
      if (reply !== undefined && reply !== null) {
        const code = typeof reply.error === 'string' ? reply.error : ''
        if (code === 'native-open-unavailable') return fallback
        if (code !== '') {
          const key = ERROR_KEYS[code]
          if (key !== undefined && typeof translate === 'function') return translate(key)
          return `${fallback}：${code}`
        }
      }
      return fallback
    }

    async function rpc(action, args, signal) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), RPC_TIMEOUT_MS)
      const abort = () => {
        if (controller !== null) controller.abort()
      }
      if (signal !== undefined && signal !== null) {
        if (signal.aborted === true) {
          if (timer !== null) clearTimeout(timer)
          return { ok: false, error: 'aborted' }
        }
        signal.addEventListener('abort', abort, { once: true })
      }
      try {
        const response = await fetch(RPC_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, args: args === undefined ? {} : args }),
          credentials: 'same-origin',
          signal: controller === null ? undefined : controller.signal,
        })
        const text = await response.text()
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, body: text.slice(0, 200) }
        if (text === '') return { ok: false, error: 'empty-response' }
        return JSON.parse(text)
      } catch (error) {
        return { ok: false, error: errorMessage(error) }
      } finally {
        if (timer !== null) clearTimeout(timer)
        if (signal !== undefined && signal !== null) signal.removeEventListener('abort', abort)
      }
    }

    /** First candidate the Host confirmed exists; everything else is ignored. */
    function pickExisting(reply, candidates) {
      if (reply === undefined || reply === null || reply.ok !== true || !Array.isArray(reply.results)) return null
      for (let index = 0; index < candidates.length; index += 1) {
        const info = reply.results[index]
        if (info === undefined || info === null || info.error !== undefined) continue
        if (info.exists === true) {
          return { raw: candidates[index].raw, line: candidates[index].line, absolute: info.absolute, isDir: info.isDir === true }
        }
      }
      return null
    }

    return {
      // The official menu service is the whole point of this release: without it
      // (DSH < 0.2.2) the plugin has nothing to contribute to.
      inject: ['contextMenus', 'sessions', 'locale', 'slots'],
      apply(ctx) {
        const contextMenus = ctx.get('contextMenus')
        if (contextMenus === undefined || contextMenus === null || typeof contextMenus.register !== 'function') {
          ctx.logger?.warn?.('[chat-ctxmenu] contextMenus service unavailable; official menu integration skipped')
          return
        }
        const sessions = ctx.get('sessions')
        const slots = ctx.get('slots')
        const locale = ctx.get('locale')

        const language = detectLanguage(locale)
        const dictionary = STRINGS[language] !== undefined ? STRINGS[language] : STRINGS.zh
        const t = (key) => (dictionary[key] !== undefined ? dictionary[key] : (STRINGS.en[key] ?? key))

        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          try {
            const dictionaries = {}
            for (const [id, values] of Object.entries(STRINGS)) dictionaries[id] = values
            const dispose = locale.register('chat-ctxmenu', dictionaries)
            if (typeof dispose === 'function') ctx.effect(() => dispose)
          } catch {
            // the local dictionary above is the fallback; never break the menu
          }
        }

        // Icons are optional chrome: register each one into the official keyed
        // slot so a contributed row looks like a built-in row.
        if (slots !== undefined && slots !== null && typeof slots.inject === 'function' && typeof slots.register === 'function') {
          for (const [key, path] of Object.entries(ICONS)) {
            try {
              slots.inject('contextMenu.icon', () => slots.register({
                name: 'contextMenu.icon',
                key: `chat-ctxmenu.${key}`,
              }, () => h('svg', {
                viewBox: '0 0 24 24',
                width: 15,
                height: 15,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.8,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true,
              }, h('path', { d: path }))))
            } catch (error) {
              ctx.logger?.debug?.(`[chat-ctxmenu] icon slot ${key} unavailable: ${errorMessage(error)}`)
            }
          }
        }

        const icon = (key) => ({ key: `chat-ctxmenu.${key}` })
        const cwdFor = (sessionId) => sessionCwd(sessions, sessionId)
        const absoluteFor = (sessionId, path) => absolutePathOf(cwdFor(sessionId), path)

        /**
         * Clipboard API first; a browser that denies it (insecure origin, denied
         * permission, missing user activation) falls back to the legacy
         * selection-based copy this plugin used before the official-menu
         * migration, so its own rows keep working there.
         */
        const copyText = async (text) => {
          try {
            if (typeof navigator !== 'undefined' && navigator !== null && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(text)
              return true
            }
          } catch {
            // fall through to the selection-based fallback
          }
          try {
            if (typeof document === 'undefined' || document === null || typeof document.createElement !== 'function') return false
            if (document.body === undefined || document.body === null) return false
            const area = document.createElement('textarea')
            area.value = text
            area.setAttribute('readonly', '')
            area.style.position = 'fixed'
            area.style.top = '-1000px'
            area.style.opacity = '0'
            document.body.appendChild(area)
            try {
              area.select()
              const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
              return copied === true
            } finally {
              document.body.removeChild(area)
            }
          } catch {
            return false
          }
        }
        const notifyCopied = () => {
          try {
            if (typeof contextMenus.notify === 'function') contextMenus.notify(t('copied'), true)
          } catch {
            // feedback is best-effort; the clipboard write already succeeded
          }
        }
        const copyOrThrow = async (text) => {
          if (!(await copyText(text))) throw new Error(t('copyFailed'))
          notifyCopied()
        }

        const openWithApplication = async (absolute, cwd, sessionId, application) => {
          const reply = await rpc('openWith', { path: absolute, cwd, sessionId, application })
          if (reply !== undefined && reply !== null && reply.ok === true) return
          throw new Error(describeError(reply, t('openFailed'), t))
        }
        const openWithDialog = async (absolute, cwd, sessionId) => {
          const reply = await rpc('openWithDialog', { path: absolute, cwd, sessionId })
          if (reply !== undefined && reply !== null && reply.ok === true) return
          throw new Error(describeError(reply, t('openFailed'), t))
        }

        const register = (contribution) => {
          try {
            ctx.effect(() => contextMenus.register(contribution), `chat-ctxmenu: ${contribution.id}`)
          } catch (error) {
            ctx.logger?.debug?.(`[chat-ctxmenu] menu contribution ${contribution.id} failed: ${errorMessage(error)}`)
          }
        }

        // --- `file`: relative path + open-with submenu (the official rows already
        //     cover preview, reveal, default app and absolute path). ---
        register({
          id: 'chat-ctxmenu.file.copy-relative-path',
          target: 'file',
          order: 110,
          resolve(target) {
            const cwd = cwdFor(target.sessionId)
            const relative = relativePath(cwd, absoluteFor(target.sessionId, target.path))
            if (relative === '' || relative === '.') return []
            return [{
              id: 'copyRelativePath',
              icon: icon('copy-relative'),
              label: t('copyRelative'),
              failureLabel: t('copyFailed'),
              run: () => copyOrThrow(relative),
            }]
          },
        })

        register({
          id: 'chat-ctxmenu.file.open-with',
          target: 'file',
          order: 120,
          async resolve(target, signal) {
            const cwd = cwdFor(target.sessionId)
            const absolute = absoluteFor(target.sessionId, target.path)
            const reply = await rpc('apps', { path: absolute, cwd, sessionId: target.sessionId }, signal)
            if (signal.aborted === true) return []
            if (reply === undefined || reply === null || reply.ok !== true || !Array.isArray(reply.apps)) return []
            const children = []
            for (const entry of reply.apps) {
              if (entry === null || entry === undefined || typeof entry.id !== 'string' || typeof entry.name !== 'string') continue
              children.push({
                id: `application:${entry.id}`,
                label: entry.isDefault === true ? `${entry.name} (${t('defaultApp')})` : entry.name,
                failureLabel: t('openFailed'),
                run: () => openWithApplication(absolute, cwd, target.sessionId, entry.id),
              })
            }
            if (reply.canOpenWithDialog === true) {
              children.push({
                id: 'application:__choose__',
                label: t('chooseApp'),
                failureLabel: t('openFailed'),
                run: () => openWithDialog(absolute, cwd, target.sessionId),
              })
            }
            if (children.length === 0) return []
            return [{ id: 'openWith', icon: icon('apps'), label: t('openWith'), children }]
          },
        })

        // --- `directory`: the official rows cover reveal and absolute path. ---
        register({
          id: 'chat-ctxmenu.directory.copy-relative-path',
          target: 'directory',
          order: 110,
          resolve(target) {
            const cwd = cwdFor(target.sessionId)
            const relative = relativePath(cwd, absoluteFor(target.sessionId, target.path))
            if (relative === '' || relative === '.') return []
            return [{
              id: 'copyRelativePath',
              icon: icon('copy-relative'),
              label: t('copyRelative'),
              failureLabel: t('copyFailed'),
              run: () => copyOrThrow(relative),
            }]
          },
        })

        // --- `image`: only an http(s) source is a useful thing to copy. ---
        register({
          id: 'chat-ctxmenu.image.copy-link',
          target: 'image',
          order: 150,
          resolve(target) {
            const url = typeof target?.url === 'string' ? target.url : ''
            if (!/^https?:\/\//iu.test(url)) return []
            return [{
              id: 'copyImageLink',
              icon: icon('link'),
              label: t('copyImageLink'),
              failureLabel: t('copyFailed'),
              run: () => copyOrThrow(url),
            }]
          },
        })

        // --- `chatMessage`: plugin-defined target, only used for plain text. ---
        register({
          id: 'chat-ctxmenu.message.copy-selection',
          target: 'chatMessage',
          order: 100,
          resolve(target) {
            const text = typeof target?.selectionText === 'string' ? target.selectionText : ''
            if (text === '') return []
            return [{
              id: 'copySelection',
              icon: icon('copy-selection'),
              label: t('copySelection'),
              failureLabel: t('copyFailed'),
              run: () => copyOrThrow(text),
            }]
          },
        })

        register({
          id: 'chat-ctxmenu.message.copy-message',
          target: 'chatMessage',
          order: 110,
          resolve(target) {
            const text = typeof target?.messageText === 'string' ? target.messageText : ''
            if (text === '') return []
            return [{
              id: 'copyMessage',
              icon: icon('copy-message'),
              label: t('copyMessage'),
              failureLabel: t('copyFailed'),
              run: () => copyOrThrow(text),
            }]
          },
        })

        // ------------------------------------------------------------------
        // Fallback: gestures the official chat surface did not claim.
        // ------------------------------------------------------------------

        ctx.effect(() => {
          if (typeof document === 'undefined' || document === null || typeof document.addEventListener !== 'function') return () => {}

          let gesture = 0

          const openTarget = (kind, value, point) => {
            try {
              contextMenus.open({ kind, value }, point)
            } catch (error) {
              ctx.logger?.debug?.(`[chat-ctxmenu] open ${kind} menu failed: ${errorMessage(error)}`)
            }
          }

          const openSharedMenu = async (prepared, token) => {
            const sessionId = currentSessionId(sessions)
            const cwd = cwdFor(sessionId)
            const point = { x: prepared.x, y: prepared.y }
            // A URL directly under the caret is authoritative: path tokens
            // elsewhere in the same block must not hijack it.
            if (prepared.caretUrl === true && prepared.link !== null && sessionId !== undefined) {
              openTarget('url', { sessionId, url: prepared.link.href }, point)
              return
            }
            let found = null
            if (prepared.candidates.length > 0 && sessionId !== undefined) {
              const reply = await rpc('resolve', { paths: prepared.candidates.map((entry) => entry.raw), cwd, sessionId })
              if (token !== gesture) return
              found = pickExisting(reply, prepared.candidates)
            }
            if (token !== gesture) return
            if (found !== null && sessionId !== undefined) {
              openTarget(found.isDir ? 'directory' : 'file', { sessionId, path: found.absolute }, point)
              return
            }
            if (prepared.link !== null && sessionId !== undefined) {
              openTarget('url', { sessionId, url: prepared.link.href }, point)
              return
            }
            // The chatMessage contributions only read the captured text, so this
            // menu must open even when the main-view Session cannot be detected;
            // otherwise preventDefault would swallow the native menu for nothing.
            if (prepared.selectionText !== '' || prepared.messageText !== '') {
              openTarget('chatMessage', { sessionId: sessionId ?? null, selectionText: prepared.selectionText, messageText: prepared.messageText }, point)
            }
          }

          // Every contextmenu gesture — official, workspace, or ours — invalidates
          // a fallback whose Host resolve is still in flight. Without this a slow
          // prose resolve could open its menu after a newer official menu appeared.
          const invalidatePendingGesture = () => {
            gesture += 1
          }

          const onContextMenu = (event) => {
            // An official trigger already handled this gesture (or another
            // surface claimed it): never steal it.
            if (event === null || event === undefined || event.defaultPrevented === true) return
            const raw = event.target
            const target = raw instanceof Element ? raw : (raw !== null && raw !== undefined && raw.parentElement instanceof Element ? raw.parentElement : null)
            if (target === null) return
            if (target.closest(EDITABLE_SELECTOR) !== null) return
            // Workspace rows, the workspace file tree and every other surface
            // outside conversation content belong to the official UI.
            const messageEl = target.closest(MESSAGE_SELECTOR)
            if (messageEl === null) return

            let prepared
            try {
              const rect = typeof target.getBoundingClientRect === 'function' && event.clientX === 0 && event.clientY === 0
                ? target.getBoundingClientRect()
                : undefined
              const x = rect !== undefined ? rect.left : event.clientX
              const y = rect !== undefined ? rect.bottom : event.clientY
              const caret = caretInfoAt(x, y)
              const selectionText = readSelectionWithin(messageEl)
              const messageText = extractMessageText(messageEl)
              const textUrl = detectTextUrl(target, caret)
              const link = detectLink(target) ?? textUrl
              const caretUrl = textUrl !== null && textUrl.fromCaret === true
              const candidates = buildCandidates(target, caret, messageEl, detectElementHint(target))
              // With no extractable text and no caret URL, the only thing this
              // gesture could offer is a hinted path; leave the native menu
              // instead of swallowing it for a menu that may not open.
              if (selectionText === '' && messageText === '' && (link === null || caretUrl !== true)) return
              prepared = { x, y, selectionText, messageText, link, caretUrl, candidates }
            } catch {
              return
            }

            event.preventDefault()
            event.stopPropagation()
            void openSharedMenu(prepared, gesture)
          }

          // Official keyboard triggers (ContextMenu / Shift+F10) call
          // preventDefault() on keydown instead of dispatching a contextmenu
          // event, so they need their own invalidation.
          const invalidatePendingKeyGesture = (event) => {
            if (event === null || event === undefined) return
            if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey === true)) gesture += 1
          }

          document.addEventListener('contextmenu', invalidatePendingGesture, true)
          document.addEventListener('contextmenu', onContextMenu)
          document.addEventListener('keydown', invalidatePendingKeyGesture, true)
          return () => {
            document.removeEventListener('contextmenu', invalidatePendingGesture, true)
            document.removeEventListener('contextmenu', onContextMenu)
            document.removeEventListener('keydown', invalidatePendingKeyGesture, true)
          }
        }, 'chat-ctxmenu: prose fallback')
      },
    }
  },
})
