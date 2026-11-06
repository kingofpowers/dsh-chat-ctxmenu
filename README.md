# dsh-chat-ctxmenu — 对话右键菜单（官方菜单增强）

给 DeepSeek Harness 的对话区右键加**只有它才能提供**的能力，其余右键交给 DSH 官方菜单。

从 **2.0.0** 起，本插件不再绘制自己的菜单，也不再安装捕获阶段的全局 `contextmenu` 监听：DSH 0.2.2 的官方右键菜单框架（`@deepseek-ai/dsh-client-ui-context-menu`）负责手势、视口定位、键盘导航、图标与提示，本插件只向官方菜单**贡献条目**，并为官方没有接管的正文手势提供一层兜底。

- **手势 hook 归官方**：右键事件的绑定、视口定位、键盘导航、图标与提示都由官方 `@deepseek-ai/dsh-client-ui-context-menu` 负责；本插件不再安装捕获阶段监听，也不再绘制菜单。对话内 Markdown 文件 / 链接 / 图片 / 引用 chip / 工具文件控件，以及工作区行、工作区文件树，都由官方 `ui-open-in-app`、`ui-file-actions` 触发和渲染。
- **本插件只贡献官方没有的条目**（官方按 target kind 分发，所以 file/directory 条目同样会出现在工作区文件树等官方 file/directory 目标上，属于增量而非接管）：
  - 文件：**复制相对路径**、**用其他应用打开 ▸**（系统为该文件注册的应用列表 + Windows「选择其他程序…」）；
  - 目录：**复制相对路径**；
  - 图片：**复制图片链接**（仅 http(s) 来源）；
  - 正文纯文本：**复制选中内容**、**复制整条消息**（插件自定义的 `chatMessage` 目标）。
- **正文里的路径识别仍然保留**：右键落在正文里的 `src/app.ts`、`./dist/x.js`、`~/…`、UNC、驱动器路径、`path:line:col`、代码块里的裸文件名时，先由 Host 校验存在性，再交给**官方文件菜单**打开（因此打开/显示/复制路径仍走官方实现）；正文里的 http(s) URL 交给**官方链接菜单**。

## 菜单内容（2.0.0）

| 右键位置 | 谁提供 | 菜单项 |
| --- | --- | --- |
| 正文纯文本 / 工具结果 | 本插件 | 复制选中内容（有选区时）· 复制整条消息 |
| 正文里的路径 token（经 Host 校验存在） | 本插件识别 → 官方菜单 | 打开 · 在文件管理器中显示 · 默认应用打开 · 复制路径 · **复制相对路径** · **用其他应用打开 ▸** · 在侧栏/浮窗打开 |
| Markdown 文件 / 引用 chip / 工具文件控件 | 官方触发/渲染 | 官方文件条目 + 本插件的**复制相对路径**、**用其他应用打开 ▸** |
| 链接（Markdown / 正文 URL） | 官方 | 在侧栏打开 · 浏览器打开 · 复制链接 |
| 图片（消息图片、原图预览） | 官方 + 本插件 | 复制图片 · 下载 · 另存为 · 显示位置 · **复制图片链接** |
| 工作区行 | 官方 | 官方工作区条目；本插件不注册 workspace 目标 |
| 工作区文件树 | 官方触发/渲染 | 官方文件/目录条目 + 本插件的**复制相对路径**、**用其他应用打开 ▸**（同 file/directory 目标，属增量） |

- 目录（folder）目前只有官方「在文件管理器中显示 / 复制目录路径」与本插件「复制相对路径」；「用默认应用打开 / 用其他应用打开 / 侧栏浮窗打开」是文件专属条目。

- `用其他应用打开 ▸` 的应用 id 必须先出现在系统的「打开方式」注册列表里；未注册的 id 一律拒绝（防止伪造请求拉起任意程序）。Windows 上对「已注册、且 id 就是 exe 路径」的应用直接 `spawn(exe, [file])`——Harness 原生 `IHandler::Invoke` 对多数 Win32 处理器无效；UWP/AUMID 等非 exe id 仍走原生通道。选择前会校验注册关系，直接启动失败时再回退原生通道并回报具体错误。

## 实现方式

```
Client（浏览器）
  ctx.contextMenus.register  ── 向官方目标贡献条目
      file      → 复制相对路径、用其他应用打开 ▸（Host RPC: apps/openWith/openWithDialog）
      directory → 复制相对路径
      image     → 复制图片链接
      chatMessage（插件自定义目标）→ 复制选中内容 / 复制整条消息
  document 'contextmenu'（冒泡阶段，兜底）
      官方已处理（event.defaultPrevented）→ 让位
      非对话正文 / 输入框 / 工作区           → 让位
      正文路径 token → Host resolve 校验 → 官方 file/directory 菜单
      正文 URL       → 官方 url 菜单
      其余正文       → chatMessage 菜单
Host（Node，仅保留官方菜单拿不到的能力）
  resolve  → fs.resolve + stat/lstat（相对路径按会话 cwd，~ 展开）
  apps     → sessionController.workspacePathApplications
  openWith / openWithDialog → 原生授权通道 + Windows 直接 spawn 兜底
  status   → 诊断
```

安全边界：

- 两个路由只接受 **loopback** 对端；带 `Origin` 时必须与 Harness 自身 origin 同源（未知 origin 直接拒绝）。
- 不做文件写入、不读文件内容：只做存在性校验与系统打开。
- 路径来自用户右键的文本，必须通过 Host `fs` 校验存在才会交给官方文件菜单；`用其他应用打开` 只接受系统已注册为该文件打开方式的应用 id。

## 环境要求

- DSH **>= 0.2.2-rc.1 < 0.3.0**（`engines.dsh`）。0.2.2 是本插件依赖官方 `contextMenus` 服务的最低版本；在 0.2.1 及更早版本上插件不会被加载。

## 安装

### 从 npm 安装

> 截至本分支，npm `latest` 仍是 **1.0.3**（自绘菜单，需要 DSH 0.2.1）。**2.0.0 尚未发布**；发布后再用下面的命令，或显式 `dsh-chat-ctxmenu@2.0.0`。在此之前请用本地目录 / tarball 安装。

```bash
dsh plugin --profile desktop add dsh-chat-ctxmenu@2.0.0
```

或在会话中让 agent 执行：

```text
plugin_manager action=install_bundle target=dsh-chat-ctxmenu
```

### 从本地目录 / tarball 安装

```bash
dsh plugin --profile desktop add <本目录绝对路径>
# 或
dsh plugin --profile desktop add ./release/dsh-chat-ctxmenu-2.0.0.tgz
```

在 DSH 会话中让 agent 执行（bundle 目录为本仓库）：

```text
plugin_manager action=install_bundle target=<本目录绝对路径>
```

安装后 Host 侧热加载；浏览器端刷新页面后生效（client 半在页面引导时加载）。

检查：

```text
GET /dsh-chat-ctxmenu/status                 # Host 半：应返回 ok:true，rev=5
浏览器 DevTools → Network 过滤 dsh-chat-ctxmenu/client.js   # Client 半：应能看到被加载
调试期可用 cordis_inspect_list 确认 chat-ctxmenu 行已激活
```

`shell.overlay` 里的 `context-menu` 是官方浮层，只能证明官方框架在、不能证明本插件客户端已加载。

卸载：`plugin_manager action=remove_bundle target=dsh-chat-ctxmenu`。

## RPC 路由

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/dsh-chat-ctxmenu/rpc` | POST | `{action, args}`；动作：`resolve` `apps` `openWith` `openWithDialog` `status` |
| `/dsh-chat-ctxmenu/status` | GET | 诊断：平台、原生通道是否可用、`canOpen`、`rev`；`?probe=<path>&cwd=<dir>` 可验证路径解析 |

2.0.0 移除了 `open` / `reveal` / `openUrl`：这些能力由官方菜单承担，本插件不再提供第二条打开通道。

## 升级说明（1.x → 2.x）

- 自绘菜单、捕获阶段监听、图片复制/另存为、链接打开/复制、打开/显示/复制路径的**自有实现**均已移除，改由 DSH 0.2.2 官方右键菜单提供；本插件保留官方没有的条目（见上表）。
- 插件版本提升到 **2.0.0**，`engines.dsh` 收紧到 `>=0.2.2-rc.1 <0.3.0`：仍在 0.2.1 的机器请显式装回 1.0.3：
  ```bash
  dsh plugin --profile desktop add dsh-chat-ctxmenu@1.0.3
  ```
- 目录（folder）的「打开」条目由官方的「在文件管理器中显示」承担（效果相同）；不再有独立行。
- 设置项无变化；没有持久化数据。

## 已知限制

- 依赖对话节点带 `data-chat-flow-kind` 标记（官方 Chat 视图仍在用）；若未来 DSH 改动该标记，正文兜底会静默不触发（不会误弹）。
- 官方菜单的「复制路径」复制绝对路径；「复制相对路径」是本插件补充的独立条目，仅当目标位于会话工作区内时出现。
- 正文里的裸文件名（如「改一下 index.js」）只会在**会话工作目录下确实存在同名文件**时出现文件菜单——刻意避免误判。
- 一次右键最多解析 8 个候选路径，取第一个真实存在的；同一文本块出现多个候选时只接受唯一的绝对路径，避免「点 A 打开 B」。
- 未加引号、含空格的 Windows 路径会同时提交「截断版 + 扩展版」两个候选，由 Host 取存在的那个。
- `用其他应用打开 ▸` 的子项在官方菜单打开前异步读取（受官方 `resolutionTimeoutMs` 限制，默认 1s）；读取超时会被官方丢弃并显示失败提示，应用列表读取失败时该条目直接不出现（不弹空菜单）。
- 官方按 target kind 分发，因此本插件的「复制相对路径 / 用其他应用打开 ▸」也会出现在**工作区文件树**的 file/directory 菜单里（官方触发、官方渲染，本插件只是增量条目）；打开这类菜单同样会等一次 `apps` 查询，受上面 1s 预算影响。
- 本插件只在对话正文内做手势兜底；工作区行、工作区文件树、会话行等区域的右键触发完全由官方决定，插件不注册这些目标。
- `复制选中内容 / 复制整条消息 / 复制相对路径` 优先走 `navigator.clipboard`；在非安全上下文（如 http 远程访问）会被浏览器拒绝，此时退回旧版使用的 `document.execCommand('copy')` 后备路径。官方自己的复制条目没有这个后备。

## 开发自检

```bash
node --test
```

覆盖：Host 路由注册与状态（`rev=5`）、相对路径/`~` 解析、应用列表、`openWith` 注册校验、已移除动作、loopback/同源/跨站/请求体上限、卸载清理；Client 端官方贡献项的目标与 id、图标注册、capture/bubble 监听分工、兜底监听不抢官方手势（`defaultPrevented` / 工作区 / 输入框）、pending resolve 被新手势取消、正文纯文本 → `chatMessage`、无 Session 时仍可复制、正文路径 → 官方 `file` 菜单、正文 URL → 官方 `url` 菜单、缺失路径回退、相对路径与打开方式条目、剪贴板后备、卸载清理；包声明（`engines.dsh` / `dsh.client.inject` / `exports` / `files`）。

## 发布

```bash
cd plugins/dsh-chat-ctxmenu
# 版本号已在 package.json 中；发布前确认 engines.dsh 与目标 DSH 一致
DSH_VERSION=0.2.2-rc.1 node ../../tooling/check-all.mjs dsh-chat-ctxmenu
npm pack --dry-run          # 核对 files 清单（9 个文件）
npm publish
# 发布完成后把 2.0.0 的版本条目（version / publishTimestamp / 描述）补进 index.json，再提交
git push origin main
```

本机仍装 0.2.1-rc.5 时，`check-all` 需要 `DSH_VERSION=0.2.2-rc.1` 覆盖（否则 `engines.dsh` 会被判为不满足）；这是本机环境差异，不是插件问题。

## 文件结构

```text
dsh-chat-ctxmenu/
├── index.js            Host 半边：路径校验 + 应用列表 + 打开方式 + HTTP RPC
├── client.js           Client 半边：官方 contextMenus 贡献项 + 正文兜底监听
├── cordis.patch.yml    bundle 行（insert chat-ctxmenu，Host 行）
├── package.json        dsh.bundle / dsh.client / engines.dsh 声明
├── locale/{zh,en}.json 插件管理页的标题与描述
├── icon.svg            图标（原创）
├── test/plugin.test.mjs 无依赖自检
└── tools/asar-*.mjs    开发期读取本机已安装 DSH（当前为 0.2.1 asar）的小工具；0.2.2 官方包请用 `npm pack @deepseek-ai/dsh-client-ui-context-menu@0.2.2-rc.1` 获取，不参与插件运行
```
