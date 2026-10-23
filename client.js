/**
 * dsh-chat-ctxmenu — Client half (Web bundle).
 *
 * Registers one `shell.overlay` entry that owns a right-click menu for
 * conversation content:
 *
 *   - Copy: the current text selection, or the whole message.
 *   - Files: when the right-click lands on (or next to) a path in message text,
 *     a produced-file chip, an inline reference, or a tool card, the menu offers
 *     Open / Reveal in file manager / Open with ▸ / Copy path / Copy relative path.
 *   - Links: Open in browser / Copy link.
 *
 * Path detection is caret-first: the token under the pointer wins, then an
 * element hint (title attribute), then the surrounding text block. Relative
 * paths are resolved against the Session working directory by the Host half and
 * only offered once the Host confirms the file exists, so prose like "and/or"
 * never produces a file menu.
 */
window.__ModuleLoader__.load({
  id: 'dsh-chat-ctxmenu',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const RPC_ENDPOINT = '/dsh-chat-ctxmenu/rpc'

    const STRINGS = {
      zh: {
        titleText: '对话内容',
        open: '打开',
        reveal: '在文件管理器中显示',
        openWith: '用其他应用打开',
        chooseApp: '选择其他程序…',
        appsLoading: '正在读取应用列表…',
        appsEmpty: '没有找到可用应用',
        defaultApp: '默认',
        copyPath: '复制路径',
        copyRelative: '复制相对路径',
        copySelection: '复制选中内容',
        copyMessage: '复制整条消息',
        copyImage: '复制图片',
        copyImageLink: '复制图片链接',
        saveImage: '另存为图片',
        imageLabel: '图片',
        imageCopied: '已复制图片',
        imageCopiedAsLink: '剪贴板不支持图片，已复制图片链接',
        copyImageFailed: '复制图片失败',
        saveImageFailed: '保存图片失败',
        saveStarted: '已开始下载',
        openLink: '在浏览器中打开',
        copyLink: '复制链接',
        resolving: '正在确认路径…',
        missing: '未找到，无法打开',
        outside: '不在会话工作区内',
        unsupported: '当前环境不能在本机打开文件',
        copied: '已复制',
        copyFailed: '复制失败',
        openFailed: '打开失败',
        errAppNotRegistered: '这个程序没有注册为此文件类型的打开方式',
        errAppMissing: '找不到这个程序（可能已卸载或移动）',
        errAppLaunchFailed: '这个程序没能启动',
        errSystemOpen: '系统打开接口调用失败',
        folder: '文件夹',
        folderTag: '文件夹',
      },
      en: {
        titleText: 'Conversation',
        open: 'Open',
        reveal: 'Show in file manager',
        openWith: 'Open with',
        chooseApp: 'Choose another app…',
        appsLoading: 'Reading application list…',
        appsEmpty: 'No application found',
        defaultApp: 'default',
        copyPath: 'Copy path',
        copyRelative: 'Copy relative path',
        copySelection: 'Copy selection',
        copyMessage: 'Copy whole message',
        copyImage: 'Copy image',
        copyImageLink: 'Copy image link',
        saveImage: 'Save image as…',
        imageLabel: 'Image',
        imageCopied: 'Image copied',
        imageCopiedAsLink: 'Clipboard does not accept images; copied the image link instead',
        copyImageFailed: 'Could not copy the image',
        saveImageFailed: 'Could not save the image',
        saveStarted: 'Download started',
        openLink: 'Open in browser',
        copyLink: 'Copy link',
        resolving: 'Resolving path…',
        missing: 'Not found, cannot open',
        outside: 'Outside the session workspace',
        unsupported: 'This environment cannot open files on the host',
        copied: 'Copied',
        copyFailed: 'Copy failed',
        openFailed: 'Open failed',
        errAppNotRegistered: 'That application is not registered for this file type',
        errAppMissing: 'That application could not be found (uninstalled or moved?)',
        errAppLaunchFailed: 'That application did not start',
        errSystemOpen: 'The system open call failed',
        folder: 'Folder',
        folderTag: 'Folder',
      },
    }

    const MENU_CSS = `
.ctxm-root{position:fixed;z-index:2147483000;font-family:inherit;font-size:13px;line-height:20px;pointer-events:auto}
.ctxm-menu{position:fixed;display:flex;flex-direction:column;min-width:216px;max-width:380px;padding:4px;box-sizing:border-box;background:var(--dsw-alias-bg-overlay,#1b1b1f);color:var(--dsw-alias-label-primary,#f5f5f7);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));border-radius:10px;box-shadow:0 14px 36px rgba(0,0,0,.34),0 2px 8px rgba(0,0,0,.2);user-select:none;outline:none}
.ctxm-head{padding:5px 10px 7px;margin-bottom:3px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.1));min-width:0}
.ctxm-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px}
.ctxm-sub{margin-top:1px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.62));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:340px;direction:ltr}
.ctxm-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;text-align:left;padding:5px 10px;border:0;background:transparent;color:inherit;font:inherit;border-radius:7px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ctxm-item:hover:not(:disabled),.ctxm-item.ctxm-active:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.08))}
.ctxm-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-1px}
.ctxm-item:disabled{opacity:.45;cursor:default}
.ctxm-item .ctxm-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.ctxm-item .ctxm-hint{font-size:11px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.62))}
.ctxm-item .ctxm-arrow{color:var(--dsw-alias-label-secondary,rgba(255,255,255,.62));margin-left:auto}
.ctxm-icon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center}
.ctxm-icon svg{width:15px;height:15px;display:block}
.ctxm-sep{height:1px;margin:4px 8px;background:var(--dsw-alias-border-l1,rgba(255,255,255,.1));flex:none}
.ctxm-note{padding:4px 10px 3px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,rgba(255,255,255,.62));white-space:normal}
.ctxm-error{padding:5px 10px 3px;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary,#ff6b6b);white-space:normal;word-break:break-word;max-width:340px}
.ctxm-toast{position:fixed;transform:translate(-50%,-140%);padding:5px 12px;border-radius:999px;background:var(--dsw-alias-bg-overlay,#1b1b1f);color:var(--dsw-alias-label-primary,#f5f5f7);border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.18));box-shadow:0 8px 24px rgba(0,0,0,.32);font-size:12px;line-height:18px;white-space:nowrap;pointer-events:none}
`

    const URL_SCHEMES = /^(?:https?:\/\/|mailto:)/i

    const ICONS = {
      open: 'M6 3h9v9M15 3 8 10M13 13v5H3V8h5',
      reveal: 'M2 6h7l2 2h11v10H2z',
      apps: 'M12 3l1.2 4.8L18 9l-4.8 1.2L12 15l-1.2-4.8L6 9l4.8-1.2z',
      copyPath: 'M8 8h10v12H8zM6 16H4V4h10v2',
      copyRelative: 'M4 12h16M12 4l4 4-4 4M12 20l-4-4 4-4',
      copySelection: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
      copyMessage: 'M4 4h16v12H7l-3 3z',
      image: 'M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6',
      save: 'M12 3v12M7 10l5 5 5-5M4 21h16',
      link: 'M10 14a5 5 0 0 1 0-7l2-2a5 5 0 0 1 7 7l-2 2M14 10a5 5 0 0 1 0 7l-2 2a5 5 0 0 1-7-7l2-2',
      folder: 'M2 6h7l2 2h11v10H2z',
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

    function basenameOf(value) {
      const at = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
      return at === -1 ? value : value.slice(at + 1)
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
      const deduped = []
      for (const token of tokens) {
        if (deduped.some((entry) => entry.raw.toLowerCase() === token.raw.toLowerCase())) continue
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

    function detectTextUrl(target, caret) {
      if (caret !== null) {
        const hit = caret.tokens.find((token) => caret.offset >= token.start - 1 && caret.offset <= token.end + 1)
        if (hit !== undefined) {
          if (/^https?:\/\//iu.test(hit.raw)) return { href: hit.raw, text: hit.raw }
        }
        return null
      }
      const block = target !== null && target !== undefined && typeof target.closest === 'function'
        ? target.closest('p, li, pre, blockquote, td, th, h1, h2, h3, h4, h5, h6')
        : null
      if (block === null || block === undefined) return null
      const urls = scanUrls(block.innerText !== undefined ? block.innerText : (block.textContent ?? ''))
      return urls.length === 1 ? { href: urls[0].href, text: urls[0].href } : null
    }

    function buildCandidates(target, x, y, messageEl, hint) {
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

      const caret = caretInfoAt(x, y)
      if (caret !== null) {
        const hit = caret.tokens.find((token) => caret.offset >= token.start - 1 && caret.offset <= token.end + 1)
        if (hit !== undefined && hit.kind !== 'url' && !/^https?:\/\//iu.test(hit.raw)) {
          const extended = extendAbsoluteToken(caret.text, hit)
          if (extended !== null) push(extended, 'high', 'caret-extended')
          push(hit.raw, hit.absolute ? 'high' : 'low', 'caret')
        }
      }
      if (hint !== null && typeof hint.path === 'string') push(hint.path, 'high', 'element')

      let block = null
      if (target !== null && target !== undefined && typeof target.closest === 'function') {
        block = target.closest('p, li, pre, blockquote, td, th, h1, h2, h3, h4, h5, h6, code, summary, a')
      }
      if (block === null || block === undefined) block = messageEl
      const blockIsCode = block !== null && block !== undefined && (block.tagName === 'PRE' || block.tagName === 'CODE')
      const blockText = block === null || block === undefined ? '' : String(block.innerText !== undefined ? block.innerText : (block.textContent ?? ''))
      const blockTokens = scanPaths(blockText).filter((token) => token.kind !== 'url')
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

    function backgroundImageUrl(value) {
      if (typeof value !== 'string' || value === '' || value === 'none') return null
      const match = /url\(\s*(['"]?)(.*?)\1\s*\)/u.exec(value)
      if (match === null) return null
      const url = match[2].trim()
      return url === '' ? null : url
    }

    /**
     * Resolve the image under the pointer. Covers the rendered message image,
     * the frame button's padding, a canvas frontend, a single-image lightbox
     * dialog and CSS background-image thumbnails.
     */
    function resolveImageTarget(target, allowBackground) {
      if (target === null || target === undefined || typeof target.closest !== 'function') return null
      const describeImage = (img) => {
        const src = typeof img.currentSrc === 'string' && img.currentSrc !== '' ? img.currentSrc : (typeof img.src === 'string' ? img.src : '')
        if (src === '') return null
        return {
          element: img,
          kind: 'img',
          src,
          alt: typeof img.getAttribute === 'function' ? (img.getAttribute('alt') ?? '') : '',
          width: img.naturalWidth || 0,
          height: img.naturalHeight || 0,
        }
      }
      const img = target.tagName === 'IMG' ? target : target.closest('img')
      if (img !== null && img !== undefined) {
        const described = describeImage(img)
        if (described !== null) return described
      }
      const canvas = target.tagName === 'CANVAS' ? target : target.closest('canvas')
      if (canvas !== null && canvas !== undefined) {
        return { element: canvas, kind: 'canvas', src: '', alt: '', width: canvas.width, height: canvas.height }
      }
      // The click target may be the frame button's padding around the image.
      const frame = target.closest('button')
      if (frame !== null && frame !== undefined) {
        const inside = frame.querySelector('img')
        if (inside !== null) return resolveImageTarget(inside, allowBackground)
      }
      // A single-image preview dialog (lightbox) renders through a portal.
      const dialog = target.closest('[role="dialog"], [aria-modal="true"]')
      if (dialog !== null && dialog !== undefined) {
        const images = dialog.querySelectorAll('img')
        if (images.length === 1) return resolveImageTarget(images[0], allowBackground)
      }
      // CSS background images are only content inside the conversation or a
      // dialog; a page skin may paint decorative imagery on the frame itself.
      if (allowBackground !== true) return null
      let node = target
      for (let depth = 0; depth < 3 && node !== null && node !== undefined && node.nodeType === 1; depth += 1) {
        let computed = ''
        try {
          computed = window.getComputedStyle(node).backgroundImage || ''
        } catch {
          computed = ''
        }
        const url = backgroundImageUrl(computed)
        if (url !== null) {
          return { element: node, kind: 'background', src: url, alt: '', width: 0, height: 0 }
        }
        node = node.parentElement
      }
      return null
    }

    const IMAGE_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/avif': 'avif' }

    function imageBaseName(target) {
      const alt = typeof target.alt === 'string' ? target.alt.trim() : ''
      let stem = alt
      if (stem === '' && typeof target.src === 'string' && target.src !== '') {
        try {
          const parsed = new URL(target.src, window.location.href)
          const last = parsed.pathname.split('/').filter(Boolean).pop() ?? ''
          stem = decodeURIComponent(last).replace(/\.[A-Za-z0-9]{1,6}$/u, '')
        } catch {
          stem = ''
        }
      }
      return (stem === '' ? `image-${Date.now()}` : stem).replace(/[\\/:*?"<>|]+/gu, '_').slice(0, 120)
    }

    function imageFileName(target, mimeType) {
      const extension = IMAGE_EXTENSIONS[mimeType] ?? 'png'
      return `${imageBaseName(target)}.${extension}`
    }

    function drawToPngBlob(canvas, source, width, height) {
      canvas.width = Math.max(1, Math.round(width))
      canvas.height = Math.max(1, Math.round(height))
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('canvas-unavailable')
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob === null) reject(new Error('encode-failed'))
          else resolve(blob)
        }, 'image/png')
      })
    }

    async function fetchImageBitmap(src) {
      if (typeof createImageBitmap !== 'function') throw new Error('bitmap-unavailable')
      const response = await fetch(src, { credentials: 'include' })
      if (response.ok !== true) throw new Error(`image-fetch-${response.status}`)
      const blob = await response.blob()
      const bitmap = await createImageBitmap(blob)
      return bitmap
    }

    /** Render any supported image target to a PNG blob the clipboard accepts. */
    async function imageToPngBlob(target) {
      const canvas = document.createElement('canvas')
      if (target.kind === 'img') {
        const element = target.element
        if (element.complete === true && element.naturalWidth > 0) {
          try {
            return await drawToPngBlob(canvas, element, element.naturalWidth, element.naturalHeight)
          } catch {
            // A canvas-tainted image is retried through fetch/createImageBitmap.
          }
        }
        if (target.src === '') throw new Error('image-not-ready')
        const bitmap = await fetchImageBitmap(target.src)
        try {
          return await drawToPngBlob(canvas, bitmap, bitmap.width, bitmap.height)
        } finally {
          if (typeof bitmap.close === 'function') bitmap.close()
        }
      }
      if (target.kind === 'canvas') return drawToPngBlob(canvas, target.element, target.element.width, target.element.height)
      if (target.kind === 'background' && target.src !== '') {
        const bitmap = await fetchImageBitmap(target.src)
        try {
          return await drawToPngBlob(canvas, bitmap, bitmap.width, bitmap.height)
        } finally {
          if (typeof bitmap.close === 'function') bitmap.close()
        }
      }
      throw new Error('image-unsupported')
    }

    /** Raw bytes for "save as", preserving the original format when possible. */
    async function imageRawBlob(target) {
      if (target.kind === 'img' && typeof target.src === 'string' && target.src !== '' && !target.src.startsWith('blob:')) {
        try {
          const response = await fetch(target.src, { credentials: 'include' })
          if (response.ok === true) {
            const blob = await response.blob()
            if (typeof blob.type === 'string' && blob.type.startsWith('image/')) return blob
          }
        } catch {
          // fall through to the canvas conversion
        }
      }
      if (target.kind === 'background' && target.src !== '') {
        try {
          const response = await fetch(target.src, { credentials: 'include' })
          if (response.ok === true) {
            const blob = await response.blob()
            if (typeof blob.type === 'string' && blob.type.startsWith('image/')) return blob
          }
        } catch {
          // fall through to the canvas conversion
        }
      }
      const png = await imageToPngBlob(target)
      return png
    }

    async function copyImageTarget(target) {
      const png = await imageToPngBlob(target)
      if (typeof ClipboardItem !== 'function' || navigator.clipboard === undefined || typeof navigator.clipboard.write !== 'function') {
        return { ok: false, reason: 'clipboard-image-unsupported' }
      }
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: 'clipboard-write-failed', message: String(error) }
      }
    }

    /** Everything the menu needs, computed synchronously before preventing default. */
    function prepareMenu(x, y, target, messageEl) {
      const selectionText = readSelectionWithin(messageEl)
      const messageText = extractMessageText(messageEl)
      const link = detectLink(target)
      const hint = detectElementHint(target)
      const candidates = buildCandidates(target, x, y, messageEl, hint)
      const urlHit = link !== null ? link : detectTextUrl(target, caretInfoAt(x, y))
      return { x, y, selectionText, messageText, link: urlHit, candidates }
    }

    async function copyToClipboard(root, text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // fall through to the selection based fallback
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '-1000px'
        area.style.opacity = '0'
        const host = root !== null && root !== undefined ? root : document.body
        host.appendChild(area)
        area.select()
        const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
        host.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    async function rpc(action, args) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), 6000)
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
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    function icon(name) {
      return h('span', { className: 'ctxm-icon', 'aria-hidden': true },
        h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: ICONS[name] || ICONS.open })))
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

    /**
     * The Session snapshot may expose the active id as `current`, or only as
     * `ids`/`byId` with a retained-by-mainView flag. Support both shapes.
     */
    function currentSessionId(snapshot) {
      if (snapshot === undefined || snapshot === null) return undefined
      if (typeof snapshot.current === 'string') return snapshot.current
      if (!Array.isArray(snapshot.ids)) return undefined
      for (const id of snapshot.ids) {
        const row = snapshot.byId !== undefined && snapshot.byId !== null ? snapshot.byId[id] : undefined
        if (row === undefined || row === null) continue
        const retained = row.retainedBy !== undefined && row.retainedBy !== null ? row.retainedBy.mainView : undefined
        if (typeof retained === 'number' && retained > 0) return id
      }
      return snapshot.ids.length > 0 ? snapshot.ids[0] : undefined
    }

    // ------------------------------------------------------------------
    // Menu component
    // ------------------------------------------------------------------

    function MenuHost(props) {
      const t = typeof props.__ctxmenuTranslate === 'function' ? props.__ctxmenuTranslate : (key) => key
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : undefined

      const sessionId = useSessions === undefined ? undefined : useSessions((snapshot) => currentSessionId(snapshot))
      const cwd = useSessions === undefined
        ? undefined
        : useSessions((snapshot) => {
          const id = currentSessionId(snapshot)
          if (id === undefined) return undefined
          const row = snapshot.byId !== undefined && snapshot.byId !== null ? snapshot.byId[id] : undefined
          return row !== undefined && row !== null && typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined
        })

      const rootRef = React.useRef(null)
      const menuRef = React.useRef(null)
      const subRef = React.useRef(null)
      const statusRef = React.useRef(null)
      const tokenRef = React.useRef(0)
      const entriesRef = React.useRef([])
      const toastTimerRef = React.useRef(null)

      const [menu, setMenu] = React.useState(null)
      const [pos, setPos] = React.useState(null)
      const [submenu, setSubmenu] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [activeIndex, setActiveIndex] = React.useState(0)
      const themeMode = props.__ctxmenuTheme === 'light' ? 'light' : 'dark'

      React.useEffect(() => {
        rpc('status', {}).then((reply) => {
          if (reply !== undefined && reply !== null && reply.ok === true) statusRef.current = reply
        }).catch(() => {})
      }, [])

      const closeAll = React.useCallback(() => {
        tokenRef.current += 1
        setMenu(null)
        setSubmenu(null)
        setError(null)
        setBusy(false)
        setActiveIndex(0)
      }, [])

      const showToast = React.useCallback((text, x, y) => {
        setToast({ text, x, y })
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
        toastTimerRef.current = setTimeout(() => setToast(null), 1500)
      }, [])

      React.useEffect(() => () => {
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current)
      }, [])

      const resolveFile = React.useCallback(async (candidates, token) => {
        if (candidates.length === 0) return
        const reply = await rpc('resolve', { paths: candidates.map((entry) => entry.raw), cwd, sessionId })
        if (tokenRef.current !== token) return
        if (reply === undefined || reply === null || reply.ok !== true || !Array.isArray(reply.results)) {
          setMenu((current) => (current === null || current.token !== token ? current : { ...current, resolving: false }))
          return
        }
        let found = null
        let highMissing = null
        for (let index = 0; index < candidates.length; index += 1) {
          const info = reply.results[index]
          if (info === undefined || info === null || info.error !== undefined) continue
          if (info.exists === true) {
            found = { raw: candidates[index].raw, line: candidates[index].line, confidence: candidates[index].confidence, absolute: info.absolute, exists: true, isDir: info.isDir === true }
            break
          }
          if (highMissing === null && candidates[index].confidence === 'high') {
            highMissing = { raw: candidates[index].raw, line: candidates[index].line, confidence: 'high', absolute: info.absolute, exists: false, isDir: false }
          }
        }
        const resolved = found !== null ? found : highMissing
        if (tokenRef.current !== token) return
        setMenu((current) => (current === null || current.token !== token ? current : { ...current, file: resolved, resolving: false }))
      }, [cwd, sessionId])

      const openMenu = React.useCallback((prepared) => {
        const token = tokenRef.current + 1
        tokenRef.current = token
        setPos(null)
        setSubmenu(null)
        setError(null)
        setBusy(false)
        setActiveIndex(0)
        setMenu({
          token,
          x: prepared.x,
          y: prepared.y,
          messageText: prepared.messageText ?? '',
          selectionText: prepared.selectionText ?? '',
          link: prepared.link ?? null,
          image: prepared.image ?? null,
          file: null,
          resolving: Array.isArray(prepared.candidates) && prepared.candidates.length > 0,
        })
        if (Array.isArray(prepared.candidates) && prepared.candidates.length > 0) resolveFile(prepared.candidates, token).catch(() => {})
      }, [resolveFile])

      React.useEffect(() => {
        const onContextMenu = (event) => {
          const raw = event.target
          const target = raw instanceof Element ? raw : (raw !== null && raw !== undefined && raw.parentElement instanceof Element ? raw.parentElement : null)
          if (target === null) return
          if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') !== null) return
          // Images are copied in place, including inside the preview lightbox.
          let image = null
          try {
            const contentScope = target.closest('[data-chat-flow-kind], [role="dialog"], [aria-modal="true"]') !== null
            image = resolveImageTarget(target, contentScope)
          } catch {
            image = null
          }
          if (image !== null) {
            event.preventDefault()
            event.stopPropagation()
            openMenu({ x: event.clientX, y: event.clientY, image, candidates: [] })
            return
          }
          const messageEl = target.closest('[data-chat-flow-kind]')
          if (messageEl === null) return
          let prepared
          try {
            prepared = prepareMenu(event.clientX, event.clientY, target, messageEl)
          } catch {
            return
          }
          const actionable = prepared.selectionText !== '' || prepared.messageText !== '' || prepared.link !== null || prepared.candidates.length > 0
          if (!actionable) return
          event.preventDefault()
          event.stopPropagation()
          openMenu(prepared)
        }
        document.addEventListener('contextmenu', onContextMenu, true)
        return () => document.removeEventListener('contextmenu', onContextMenu, true)
      }, [openMenu])

      // Close on outside interaction, scroll, resize, blur; Escape and arrows.
      React.useEffect(() => {
        if (menu === null) return undefined
        const onPointerDown = (event) => {
          const menuEl = menuRef.current
          const subEl = subRef.current
          const inMenu = menuEl !== null && menuEl.contains(event.target)
          const inSub = subEl !== null && subEl.contains(event.target)
          if (!inMenu && !inSub) closeAll()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (submenu !== null) setSubmenu(null)
            else closeAll()
            return
          }
          const list = entriesRef.current
          if (list.length === 0) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const currentEntry = list[activeIndex]
            const from = currentEntry === undefined ? (event.key === 'ArrowDown' ? -1 : 0) : list.indexOf(currentEntry)
            let next = from
            for (let step = 0; step < list.length; step += 1) {
              next = event.key === 'ArrowDown' ? (next + 1) % list.length : (next - 1 + list.length) % list.length
              if (list[next] !== undefined && list[next].disabled !== true) break
            }
            setActiveIndex(next)
            return
          }
          if (event.key === 'Enter') {
            const entry = list[activeIndex]
            if (entry !== undefined && entry !== null && entry.disabled !== true && typeof entry.run === 'function') {
              event.preventDefault()
              entry.run()
            }
            return
          }
          if (event.key === 'ArrowRight' && list[activeIndex] !== undefined && list[activeIndex].onHover !== undefined) {
            event.preventDefault()
            list[activeIndex].onHover({ currentTarget: menuRef.current })
          }
        }
        const onScroll = () => closeAll()
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        window.addEventListener('blur', onScroll)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          window.removeEventListener('blur', onScroll)
        }
      }, [menu, submenu, activeIndex, closeAll])

      // Clamp the menu inside the viewport once its size is known.
      React.useLayoutEffect(() => {
        if (menu === null) return
        const element = menuRef.current
        if (element === null) return
        const width = element.offsetWidth
        const height = element.offsetHeight
        const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))
        const top = Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))
        setPos((current) => (current !== null && current.left === left && current.top === top ? current : { left, top }))
      }, [menu, submenu, error])

      React.useLayoutEffect(() => {
        if (submenu === null) return
        const element = subRef.current
        if (element === null) return
        const width = element.offsetWidth
        const height = element.offsetHeight
        const left = submenu.x + width > window.innerWidth - 8 ? Math.max(8, submenu.x - width - 300) : submenu.x
        const top = Math.max(8, Math.min(submenu.y, window.innerHeight - height - 8))
        if (left !== submenu.x || top !== submenu.y) setSubmenu((current) => (current === null ? current : { ...current, x: left, y: top }))
      }, [submenu])

      const toastNode = toast === null ? null : h('div', { key: 'toast', className: 'ctxm-toast', style: { left: toast.x, top: toast.y } }, toast.text)

      if (menu === null) {
        return h('div', { ref: rootRef, className: 'ctxm-root', style: { display: 'contents' } },
          h('style', { key: 'css' }, MENU_CSS),
          toastNode)
      }

      const file = menu.file
      const link = menu.link
      const image = menu.image
      const canOpen = statusRef.current === null || statusRef.current === undefined ? true : statusRef.current.canOpen !== false
      const relative = file === null ? '' : relativePath(cwd, file.absolute)
      const outsideWorkspace = file !== null && relative === ''
      const fileOpenable = file !== null && file.exists === true && canOpen
      const items = []
      const current = menu

      const guardToken = (token) => tokenRef.current === token

      const closeThenToast = (text) => {
        const x = current.x
        const y = current.y
        closeAll()
        showToast(text, x, y)
      }

      const runCopy = async (text) => {
        const ok = await copyToClipboard(rootRef.current, text)
        if (ok) closeThenToast(t('copied'))
        else setError(t('copyFailed'))
      }

      const imageLinkable = image !== null && typeof image.src === 'string' && image.src !== '' && !image.src.startsWith('blob:')

      const runCopyImage = async () => {
        if (image === null) return
        const token = tokenRef.current
        setBusy(true)
        setError(null)
        try {
          const result = await copyImageTarget(image)
          if (!guardToken(token)) return
          if (result.ok === true) {
            setBusy(false)
            closeThenToast(t('imageCopied'))
            return
          }
          // Some environments refuse image clipboard items; a link is still useful.
          if (imageLinkable) {
            const copied = await copyToClipboard(rootRef.current, image.src)
            if (!guardToken(token)) return
            if (copied === true) {
              setBusy(false)
              closeThenToast(t('imageCopiedAsLink'))
              return
            }
          }
          setBusy(false)
          setError(t('copyImageFailed'))
        } catch {
          if (!guardToken(token)) return
          setBusy(false)
          setError(t('copyImageFailed'))
        }
      }

      const runSaveImage = async () => {
        if (image === null) return
        const token = tokenRef.current
        setBusy(true)
        setError(null)
        try {
          const blob = await imageRawBlob(image)
          if (!guardToken(token)) return
          const objectUrl = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = objectUrl
          anchor.download = imageFileName(image, blob.type)
          anchor.rel = 'noopener'
          const host = rootRef.current !== null ? rootRef.current : document.body
          host.appendChild(anchor)
          anchor.click()
          host.removeChild(anchor)
          setTimeout(() => URL.revokeObjectURL(objectUrl), 4000)
          setBusy(false)
          closeThenToast(t('saveStarted'))
        } catch {
          if (!guardToken(token)) return
          setBusy(false)
          setError(t('saveImageFailed'))
        }
      }

      const runFileAction = async (mode) => {
        if (file === null) return
        const token = tokenRef.current
        setBusy(true)
        setError(null)
        const reply = await rpc(mode === 'reveal' ? 'reveal' : 'open', { path: file.absolute, cwd, sessionId })
        if (!guardToken(token)) return
        setBusy(false)
        if (reply !== undefined && reply !== null && reply.ok === true) {
          closeAll()
          return
        }
        setError(describeError(reply, t('openFailed'), t))
      }

      const openWith = async (application) => {
        if (file === null) return
        const token = tokenRef.current
        setBusy(true)
        setError(null)
        const reply = await rpc('openWith', { path: file.absolute, cwd, sessionId, application })
        if (!guardToken(token)) return
        setBusy(false)
        if (reply !== undefined && reply !== null && reply.ok === true) closeAll()
        else setError(describeError(reply, t('openFailed'), t))
      }

      const openWithDialog = async () => {
        if (file === null) return
        const token = tokenRef.current
        setBusy(true)
        setError(null)
        const reply = await rpc('openWithDialog', { path: file.absolute, cwd, sessionId })
        if (!guardToken(token)) return
        setBusy(false)
        if (reply !== undefined && reply !== null && reply.ok === true) closeAll()
        else setError(describeError(reply, t('openFailed'), t))
      }

      const loadApps = async (event) => {
        if (file === null) return
        const token = tokenRef.current
        const rect = event !== null && event !== undefined && event.currentTarget !== null && event.currentTarget !== undefined
          ? event.currentTarget.getBoundingClientRect()
          : { right: current.x + 200, top: current.y }
        setSubmenu({ x: rect.right + 4, y: rect.top, loading: true, items: [], canDialog: false })
        const reply = await rpc('apps', { path: file.absolute, cwd, sessionId })
        if (!guardToken(token)) return
        const apps = reply !== undefined && reply !== null && reply.ok === true && Array.isArray(reply.apps) ? reply.apps : []
        setSubmenu({
          x: rect.right + 4,
          y: rect.top,
          loading: false,
          items: apps.filter((entry) => entry !== null && typeof entry.id === 'string' && typeof entry.name === 'string'),
          canDialog: reply !== undefined && reply !== null && reply.canOpenWithDialog === true,
        })
      }

      const openLink = async () => {
        if (link === null) return
        const token = tokenRef.current
        setBusy(true)
        setError(null)
        const reply = await rpc('openUrl', { url: link.href })
        if (!guardToken(token)) return
        setBusy(false)
        if (reply !== undefined && reply !== null && reply.ok === true) {
          closeAll()
          return
        }
        try {
          window.open(link.href, '_blank', 'noopener,noreferrer')
          closeAll()
        } catch {
          setError(describeError(reply, t('openFailed'), t))
        }
      }

      const pushItem = (entry) => {
        if (entry === null) {
          items.push({ separator: true })
          return
        }
        items.push(entry)
      }

      if (image !== null) {
        pushItem({ id: 'copyImage', icon: 'image', label: t('copyImage'), disabled: busy, run: runCopyImage })
        if (imageLinkable) {
          pushItem({ id: 'copyImageLink', icon: 'copyPath', label: t('copyImageLink'), disabled: busy, run: () => runCopy(image.src) })
        }
        pushItem({ id: 'saveImage', icon: 'save', label: t('saveImage'), disabled: busy, run: runSaveImage })
      } else if (file !== null) {
        pushItem({
          id: 'open',
          icon: file.isDir ? 'folder' : 'open',
          label: file.isDir ? `${t('open')} (${t('folder')})` : t('open'),
          disabled: !fileOpenable || busy,
          run: () => runFileAction('open'),
        })
        pushItem({
          id: 'reveal',
          icon: 'reveal',
          label: t('reveal'),
          disabled: !fileOpenable || busy,
          run: () => runFileAction('reveal'),
        })
        pushItem({
          id: 'apps',
          icon: 'apps',
          label: t('openWith'),
          submenu: true,
          disabled: !fileOpenable || busy,
          run: () => {},
          onHover: loadApps,
        })
        if (file.exists !== true) pushItem({ id: 'note-missing', note: t('missing') })
        else if (!canOpen) pushItem({ id: 'note-unsupported', note: t('unsupported') })
        if (file.absolute !== undefined) {
          pushItem({ separator: true })
          pushItem({ id: 'copyPath', icon: 'copyPath', label: t('copyPath'), disabled: busy, run: () => runCopy(file.absolute) })
          pushItem({
            id: 'copyRelative',
            icon: 'copyRelative',
            label: t('copyRelative'),
            hint: outsideWorkspace ? t('outside') : relative,
            disabled: busy || outsideWorkspace || relative === '',
            run: () => runCopy(relative),
          })
        }
        pushItem({ separator: true })
      } else if (menu.resolving) {
        pushItem({ id: 'resolving', note: t('resolving') })
        pushItem({ separator: true })
      }

      if (menu.selectionText !== '') {
        pushItem({ id: 'copySelection', icon: 'copySelection', label: t('copySelection'), disabled: busy, run: () => runCopy(menu.selectionText) })
      }
      if (menu.messageText !== '') {
        pushItem({ id: 'copyMessage', icon: 'copyMessage', label: t('copyMessage'), disabled: busy, run: () => runCopy(menu.messageText) })
      }
      if (link !== null) {
        pushItem({ separator: true })
        pushItem({ id: 'openLink', icon: 'link', label: t('openLink'), disabled: busy, run: openLink })
        pushItem({ id: 'copyLink', icon: 'copyPath', label: t('copyLink'), disabled: busy, run: () => runCopy(link.href) })
      }

      entriesRef.current = items.filter((entry) => entry !== null && entry.separator !== true && entry.note === undefined)
      const entries = entriesRef.current
      const activeEntry = entries[activeIndex]

      const headerTitle = image !== null
        ? (typeof image.alt === 'string' && image.alt.trim() !== '' ? image.alt.trim() : t('imageLabel'))
        : (file !== null
          ? basenameOf(file.raw)
          : (link !== null ? link.href.replace(/^https?:\/\//iu, '').split('/')[0] : t('titleText')))
      const headerSub = image !== null
        ? `${image.width > 0 ? `${image.width}×${image.height} · ` : ''}${String(image.src ?? '').slice(0, 160)}`
        : (file !== null
          ? `${file.absolute ?? file.raw}${file.line !== undefined && file.line !== '' ? `:${file.line}` : ''}${file.isDir ? ` (${t('folderTag')})` : ''}`
          : (link !== null ? link.href : (menu.selectionText !== '' ? menu.selectionText : menu.messageText).slice(0, 120)))

      const renderItem = (entry, index) => {
        if (entry === null) return null
        if (entry.separator === true) return h('div', { key: `sep-${index}`, className: 'ctxm-sep', role: 'separator' })
        if (entry.note !== undefined) return h('div', { key: entry.id ?? `note-${index}`, className: 'ctxm-note' }, entry.note)
        const isActive = entry === activeEntry
        return h('button', {
          key: entry.id,
          type: 'button',
          role: 'menuitem',
          className: `ctxm-item${isActive ? ' ctxm-active' : ''}`,
          disabled: entry.disabled === true,
          onMouseEnter: (event) => {
            const position = entries.indexOf(entry)
            if (position !== -1) setActiveIndex(position)
            if (entry.onHover !== undefined) entry.onHover(event)
            else if (submenu !== null) setSubmenu(null)
          },
          onClick: (event) => {
            if (entry.onHover !== undefined) {
              entry.onHover(event)
              return
            }
            entry.run()
          },
        },
        icon(entry.icon),
        h('span', { className: 'ctxm-label' }, entry.label),
        entry.hint !== undefined && entry.hint !== '' ? h('span', { className: 'ctxm-hint' }, entry.hint) : null,
        entry.submenu === true ? h('span', { className: 'ctxm-arrow' }, '\u203A') : null)
      }

      const menuNode = h('div', {
        key: 'menu',
        ref: menuRef,
        className: 'ctxm-menu',
        role: 'menu',
        tabIndex: -1,
        'data-ctxm-theme': themeMode,
        style: pos === null ? { left: menu.x, top: menu.y } : { left: pos.left, top: pos.top },
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
        },
      },
      h('div', { className: 'ctxm-head' },
        h('div', { className: 'ctxm-title', title: headerTitle }, headerTitle),
        headerSub !== '' ? h('div', { className: 'ctxm-sub', title: headerSub }, headerSub) : null),
      items.map(renderItem),
      error !== null ? h('div', { className: 'ctxm-error', role: 'alert' }, error) : null)

      const submenuNode = submenu === null ? null : h('div', {
        key: 'submenu',
        ref: subRef,
        className: 'ctxm-menu',
        role: 'menu',
        'data-ctxm-theme': themeMode,
        style: { left: submenu.x, top: submenu.y },
        onContextMenu: (event) => {
          event.preventDefault()
          event.stopPropagation()
        },
      },
      submenu.loading
        ? h('div', { className: 'ctxm-note' }, t('appsLoading'))
        : (submenu.items.length === 0
          ? h('div', { className: 'ctxm-note' }, t('appsEmpty'))
          : submenu.items.map((entry) => h('button', {
            key: `app-${entry.id}`,
            type: 'button',
            role: 'menuitem',
            className: 'ctxm-item',
            disabled: busy,
            onClick: () => openWith(entry.id),
          }, icon('apps'), h('span', { className: 'ctxm-label' }, entry.name), entry.isDefault === true ? h('span', { className: 'ctxm-hint' }, t('defaultApp')) : null))),
      submenu.canDialog
        ? h(React.Fragment, null,
          h('div', { className: 'ctxm-sep', role: 'separator' }),
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'ctxm-item',
            disabled: busy,
            onClick: () => { openWithDialog() },
          }, icon('apps'), h('span', { className: 'ctxm-label' }, t('chooseApp'))))
        : null)

      return h('div', { ref: rootRef, className: 'ctxm-root', 'data-ctxm-theme': themeMode },
        h('style', { key: 'css' }, MENU_CSS),
        menuNode,
        submenuNode,
        toastNode)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined || slots === null) return
        const locale = ctx.get('locale')
        const language = detectLanguage(locale)
        const dictionary = STRINGS[language] !== undefined ? STRINGS[language] : STRINGS.zh
        const translate = (key) => (dictionary[key] !== undefined ? dictionary[key] : (STRINGS.en[key] ?? key))
        let initialTheme = 'dark'
        try {
          const theme = ctx.get('theme')
          const snapshot = theme !== undefined && theme !== null && typeof theme.getTheme === 'function' ? theme.getTheme() : undefined
          const active = snapshot !== undefined && snapshot !== null ? snapshot.active : undefined
          const scheme = active !== undefined && active !== null ? active.colorScheme : undefined
          if (scheme === 'light') initialTheme = 'light'
        } catch {
          // dark is the safe default for an unknown theme
        }
        if (locale !== undefined && locale !== null && typeof locale.register === 'function') {
          try {
            const dictionaries = {}
            for (const [id, values] of Object.entries(STRINGS)) dictionaries[id] = values
            const dispose = locale.register('chat-ctxmenu', dictionaries)
            if (typeof dispose === 'function') ctx.effect(() => dispose)
          } catch {
            // the local dictionary above is the fallback; never break the slot
          }
        }
        const Component = (props) => h(MenuHost, { ...props, __ctxmenuTranslate: translate, __ctxmenuTheme: initialTheme })
        slots.inject('shell.overlay', () => slots.register({
          name: 'shell.overlay',
          id: 'chat-ctxmenu',
          order: 80,
        }, Component))
      },
    }
  },
})
