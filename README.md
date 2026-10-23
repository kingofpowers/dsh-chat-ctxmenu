# dsh-chat-ctxmenu — 对话右键菜单

给 DeepSeek Harness 的对话区加一个真正好用的右键菜单：**复制文本 / 打开文件 / 在文件管理器中显示**。

现有市面插件（`dsh-filemenu`、`@z1995418/dsh-file-menu` 等）的主要问题是：只认绝对路径、只认助手消息气泡、命中不了就什么都不弹。这个插件针对这三点重做：

- **光标优先**：右键落点所在的文本 token 优先，其次元素 `title` 提示（产出文件 chip、内联引用、工具卡按钮），最后回退到所在文本块。
- **相对路径**：按会话工作目录（session cwd）解析，`src/app.ts`、`./dist/x.js`、反引号里的 `package.json` 都能用；`~/…`、UNC、驱动器路径、POSIX 绝对路径同样支持。
- **不误判**：所有候选路径都交给 Host 用真实 `fs` 校验；**只有确认存在**的路径才出现「打开 / 显示 / 其他应用」，「复制路径」也只在候选可信（绝对路径、代码块、显式提示）时出现。正文里的 `and/or` 这类文本不会产生文件菜单。
- **全消息类型**：用户消息、助手消息、工具调用结果都用同一套 `[data-chat-flow-kind]` 容器识别。

## 菜单内容

| 右键位置 | 菜单项 |
| --- | --- |
| 任意对话文本 | 复制选中内容（有选区时）· 复制整条消息 |
| 文件路径（正文 / 内联代码 / 产出文件 chip / 工具卡） | 打开 · 在文件管理器中显示 · 用其他应用打开 ▸（系统为该文件注册的应用 + 选择其他程序…）· 复制路径 · 复制相对路径 · 复制选中内容 · 复制整条消息 |
| 图片（消息里的图片、缩略图、点击预览后的原图） | 复制图片 · 复制图片链接 · 另存为图片 |
| 链接 | 在浏览器中打开 · 复制链接 |

- 文件夹：`打开` = 在文件管理器中打开该文件夹；`在文件管理器中显示` = 在父目录中选中它。
- 图片：`复制图片` 会把图片转成 PNG 写入剪贴板（可直接粘进微信/文档/画图）；如果当前环境拒绝图片剪贴板，会自动降级为复制图片链接并提示。`另存为图片` 优先保留原始格式。
- 菜单跟随光标并自动避开视口边缘；Esc / 点击外部 / 滚动关闭；支持 ↑↓/Enter 键盘操作。

## 实现方式

```
Client（浏览器）
  shell.overlay 条目：document capture 阶段的 contextmenu 监听
  → 光标 caret 定位 token / 元素提示 / 文本块扫描
  → POST /dsh-chat-ctxmenu/rpc  { action, args }
Host（Node）
  resolve  → fs.resolve + lstat + listDir（相对路径按会话 cwd）
  open / reveal / apps / openWith
           → sessionController.openWorkspacePath / workspacePathApplications
             （与会话头部 Open In… 同一条原生授权通道）
  openUrl  → Start-Process / open / xdg-open
```

回退：若 `sessionController` 服务不存在，`open`/`reveal` 退回 `node:child_process` 调系统打开器（explorer / open / xdg-open），并等待子进程真正 `spawn` 才报成功；若原生通道**明确拒绝**（`gateway/bad-request`、`gateway/cancelled`、`native-open-unavailable` 等），则视为终态、不回退，避免绕过 Harness 的授权判定。

会话工作目录取自 Client 的 `useSessions` 快照，同时兼容两种形状：`{ current }` 与 `{ ids, byId, retainedBy.mainView }`。

所有候选路径都先由 Host 的 `fs` 服务校验存在性（`path:line` 会先剥离行号，`~/` 会展开为 home），只有确认存在的路径才会出现打开类菜单。

## 安装

### 从 npm 安装（发布后）

```bash
dsh plugin --profile desktop add dsh-chat-ctxmenu
```

或在会话中让 agent 执行：

```text
plugin_manager action=install_bundle target=dsh-chat-ctxmenu
```

### 从本地目录 / tarball 安装

```bash
dsh plugin --profile desktop add <本目录绝对路径>
# 或
dsh plugin --profile desktop add ./release/dsh-chat-ctxmenu-1.0.0.tgz
```

在 DSH 会话中让 agent 执行（bundle 目录为本仓库）：

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后 Host 侧热加载；浏览器端刷新页面后生效（client 半在页面刷新时加载）。
检查：

```text
cordis_inspect_query client Slots.listSubTree root=shell.overlay   # 应出现 chat-ctxmenu
GET /dsh-chat-ctxmenu/status                                        # 应返回 ok:true
```

卸载：`plugin_manager action=remove_bundle target=dsh-chat-ctxmenu`。

## 发布

```bash
npm pack                       # 产物 release-*.tgz，先用 npm pack --dry-run 检查文件清单
npm publish                    # 需要先 npm login（或配置 //registry.npmjs.org/:_authToken）
```

发布后可用 `npm view dsh-chat-ctxmenu version` 校验；包内只包含 `index.js`、`client.js`、
`cordis.patch.yml`、`locale/*`、`icon.svg`、`README.md`、`LICENSE`、`package.json`（见 `files`）。

## RPC 路由

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-chat-ctxmenu/rpc` | POST | `{action, args}`；动作：`resolve` `open` `reveal` `apps` `openWith` `openWithDialog` `openUrl` `status` |
| `/dsh-chat-ctxmenu/status` | GET | 诊断：平台、原生通道是否可用、`canOpen`、`rev`；`?probe=<path>&cwd=<dir>` 可验证路径解析 |

## 安全边界

- 两个路由只接受 **loopback** 对端，且带 `Origin` 时必须与 Harness 自身 origin 同源；远程浏览器无法借此打开宿主机文件（与原生 `canOpenWorkspacePath` 的语义一致）。
- 不做任意路径写入：只做「存在性检查 + 交给系统打开器」，不读取文件内容。
- 路径来自用户右键的文本，且必须通过 `fs` 校验存在，避免把误识别文本变成打开动作。

## 已知限制

- 依赖对话节点带 `data-chat-flow-kind` 标记；若未来 DSH 改动该标记，菜单会静默不触发（不会误弹）。诊断时先看 `/status` 与会话 DOM。
- 纯正文里无分隔符、无反引号的单词文件名（如「改一下 index.js」）只有在**会话工作目录下确实存在同名文件**时才会出现打开项；这是刻意避免误判。
- 一次菜单最多解析 8 个候选路径，取第一个真实存在的；同一文本块出现多个候选时只接受唯一的绝对路径，避免「点 A 打开 B」。
- 未加引号、含空格的 Windows 路径会同时提交「截断版 + 扩展版」两个候选，由 Host 取存在的那个。
- 代码块内的 `path:line` / `path:line:col` 会剥离行号后再解析，行号只用于菜单标题展示。
- `用其他应用打开 ▸` 的列表来自系统注册信息（默认程序会标注「默认」）；列表为空时仍提供「选择其他程序…」（Windows）。
- **Windows 上「用其他应用打开」的实现**：系统注册信息里的应用 id 就是该应用的 exe 路径。Harness 原生的 `openFileApplication` 走 `IHandler::Invoke(IDataObject)`，多数 Win32 处理器没有实现该调用（会抛错或静默不启动），所以本插件对「已注册为打开方式且 id 是 exe 路径」的应用直接 `spawn(exe, [file])`；UWP/AUMID 等非 exe id 仍走原生通道。选择前会先用系统注册列表校验该 id 确实注册为此文件的打开方式，未注册的 id 一律拒绝（防止伪造请求拉起任意程序）。若直接启动失败，会再尝试一次原生通道并回报具体错误，不会假报成功。
- **修改插件代码后的生效方式**：`plugin_manager remove_bundle` → `install_bundle` 可让 Host 半边热更新；浏览器端需要刷新页面（client 半在页面引导时加载）。只改 `client.js` 也要重新安装，否则页面拿到的仍是旧 bundle。

## 开发自检

```bash
node test/plugin.test.mjs
```

覆盖：Host 路由注册、状态、相对路径解析（含 session cwd 兜底）、不存在的路径拒绝打开、应用列表、未知动作、非 loopback/跨源拒绝、卸载清理；Client bundle 工厂与 `shell.overlay` 注册。

## 文件结构

```text
dsh-chat-ctxmenu/
├── index.js            Host 半边：fs 解析 + 原生打开通道 + HTTP RPC
├── client.js           Client 半边：shell.overlay + 右键菜单 UI
├── cordis.patch.yml    bundle 行（insert chat-ctxmenu）
├── package.json        dsh.bundle / dsh.client 声明
├── locale/{zh,en}.json 插件管理页的标题与描述
├── icon.svg            图标（原创）
├── test/plugin.test.mjs 无依赖自检
└── tools/asar-read.mjs 开发期读取已安装 DSH（asar）实现的小工具，不参与插件运行
```
