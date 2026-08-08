# SyncAnchor — VS Code 扩展设计方案

> 本地 ↔ 远程 SSH 增量复制同步：双端锚点 + 相对路径覆盖，只覆盖不删除，杜绝远程数据丢失。

## 1. 概述

**SyncAnchor** 是一个 VS Code 扩展，解决"本地改代码 → 推到服务器测试"场景下最繁琐的一步：选路径、传文件。

- 在本地选一个基础文件夹（锚点），在远程选对应基础文件夹
- 本地多选文件/文件夹，按**相对路径**覆盖到远程对应位置
- 只动选中的文件，远程其它文件一概不碰 → **天然不会丢数据**
- 已有 SSH 连接配置即可用（`~/.ssh/config` / Remote-SSH 最近连接 / 当前远程窗口），**零参数输入**

## 2. 核心语义

| 概念 | 定义 |
|---|---|
| 双端锚点 (Base) | 本地 base（如 `D:\Projects\ISRA`）↔ 远程 base（如 `~/ISRA`），成对存储 |
| 相对路径覆盖 | 选中项相对本地 base 的路径（`src/model.py`、`utils/`）→ 目标 = `远程base/该路径` |
| 文件粒度 | **最终操作单位永远是文件**；选文件夹只是递归展开成文件集合的快捷方式 |
| 覆盖语义 | 远程无此文件 → 新建；有 → 覆盖；**从不删除任何远程文件** |
| 增量 | 上传前 SFTP stat 比较 size + mtime，相同则跳过 |

## 3. 技术栈与架构

- **语言/环境**：TypeScript + VS Code Extension API（Node 运行时）
- **传输**：`ssh2` npm 包（SFTP）——纯 JS 跨平台，逐文件可控，不依赖系统 scp
- **扩展类型**：**dual-host 扩展**（本地窗口 / Remote-SSH 远程窗口都能跑），`vscode.env.remoteName` 区分行为
- **无运行时框架**：webview 前端用原生 HTML/CSS/TS，保持轻量（用户偏好最简单方案）

```
┌─────────────────────── 插件进程 ───────────────────────┐
│ extension.ts (激活/命令注册)                            │
│   ├─ panel.ts    全屏 Webview 主界面（前后端 postMessage）│
│   ├─ activitybar.ts  图标入口（容器可见→开面板→收侧栏）   │
│   ├─ connection.ts  连接管理（来源合并/握手/复用）        │
│   ├─ syncEngine.ts  同步引擎（展开/对比/上传队列）        │
│   └─ relative.ts    相对路径计算 + 越界防护              │
└──────────────┬────────────────────────────┬───────────┘
               │ vscode.workspace.fs        │ ssh2 (SFTP)
       本地文件系统（本地 base）       远程文件系统（远程 base）
```

## 4. UI 设计

### 4.1 全屏 Webview Panel（唯一主界面）

编辑器区打开独立 tab（`createWebviewPanel`，`ViewColumn.One`），可拖出为独立 OS 窗口，放大到任意尺寸 / 第二显示器。布局：

```
┌────────────────────────────────────────────────────────────────┐
│ [连接▾ ●featurize] [本地 base ▾] [远程 base ▾] [☑备份] [▸上传] [🔃] │ ← 顶栏工具条
├──────────────┬─────────────────┬─────────────────┬──────────────┤
│ 本地文件树    │ 远程文件树       │ 传输队列         │ 日志(可折叠)   │
│ checkbox多选  │ 只读参考         │ 相对路径+状态徽标 │ 滚动          │
│ 惰性加载      │ SFTP实时拉取     │ 覆盖/新建/跳过   │ 双写Output    │
├──────────────┴─────────────────┴─────────────────┴──────────────┤
│ 进度条 ▓▓▓▓▓░░░░░ 5/8 · 已用 12s · 剩余 ~6s                     │
└────────────────────────────────────────────────────────────────┘
```

- **本地文件树**：以本地 base 为根，webview 内 checkbox 勾选，勾选即入队
- **远程文件树**：SFTP `readdir` 拉取，只读参考；队列命中项实时标"将覆盖/将新建/跳过"
- **传输队列**：文件粒度清单，上传前可视确认区（动手前先展示将覆盖什么）
- **日志**：webview 内滚动区 + 双写 `OutputChannel`（关窗可查）
- **状态徽标**：`将覆盖`(橙) / `将新建`(蓝) / `跳过·远端一致`(灰) / `成功`(绿) / `失败`(红)

### 4.2 Activity Bar 图标入口（无侧边栏，主入口）

VS Code 没有"图标点击直接触发命令"的公开 API（Activity Bar 图标必须挂 view container），
用"容器可见性监听"实现等效的全屏展开体验：

1. 注册极简 view container：一个图标 + 一个启动视图（仅显示当前连接状态一行字，纯兜底，不承载功能）
2. 用 `TreeView.onDidChangeVisibility`（**stable API**，1.51+）监听：用户点 Activity Bar 图标 → 侧边栏容器展开 → status 视图变为可见 → 打开全屏 webview panel（`ViewColumn.One`）→ 立即 `workbench.action.closeSidebar` 收起侧边栏
   - 注：`window.onDidChangeViewContainerVisibility` 只是 proposed API（不在 @types/vscode stable 类型里），故不用
3. 若面板已存在 → 不重复创建，`reveal()` 聚焦已有面板
4. 用户感知：**点图标 = 全屏面板展开**，侧边栏只是瞬态闪现（甚至不可见）

全部重 UI 放全屏面板；侧边栏容器仅作为图标载体，不做任何功能堆积。
命令面板与快捷键作为次要入口（面板关闭后最可靠的找回方式）。

## 5. 连接管理（只显示当前已连接）

下拉框**只显示当前正在连接的 SSH 服务器**（动态检测），不含 config/历史候选：

| 来源 | 获取方式 | 说明 |
|---|---|---|
| **活动 SSH 连接**（主） | 扫描运行中的 `ssh`/`ssh.exe` 进程命令行（Windows: PowerShell `Get-CimInstance`；POSIX: `ps`），解析目标 host/port/user，经 `~/.ssh/config` 补全 user/port/key | 连上就出现，断开就消失；5 秒自动刷新 |
| 当前远程窗口 | `vscode.env.remoteName === 'ssh-remote'` 时，从 workspace URI authority 或 whoami/hostname 兜底 | 在 Remote-SSH 窗口内运行时置顶 |

- **认证链**：`~/.ssh/id_rsa`（默认）→ ssh-agent → 密码（InputBox 一次，仅本次会话）
- **握手**：连接后 `echo OK` 探活，状态灯 `已连接(绿) / 可连接(黄，未握手) / 不可达(红)`
- **刷新**：webview 每 5 秒请求一次连接列表（进程扫描约 100–300ms，开销可忽略）
- **边界（诚实说明）**：config/历史连接不再出现在下拉（用户明确只要"当前已连接"）；未开任何 ssh 连接时显示提示"先 ssh 连接"

## 6. 同步引擎数据流

```
勾选(文件|文件夹)
  → 递归展开为文件集合（统一文件粒度；应用排除规则）
  → 每文件: path.relative(localBase) → 远程目标路径（越界校验：含 .. 一律拒绝）
  → SFTP stat 远程: 不存在=将新建 / size+mtime 相同=跳过 / 不同=将覆盖
  → 队列渲染（预览确认）
  → 上传: 逐文件流式传输（fastPut/createWriteStream），自动创建父目录
  → 报告: 成功/跳过/失败清单 + 日志
```

- **排除规则（默认）**：`.git`、`node_modules`、`venv`、`__pycache__`、`.vs`、`*.zip`（可配置）
- **覆盖前备份（开关，默认关）**：远程将被覆盖的文件先移入 `~/.sync-anchor-backup/<时间戳>/` 再覆盖
- **断线处理**：报告已完成/未完成清单，不自动回滚（远程原文件本来就在，重连续传）
- **大文件**：流式传输，不整文件读内存

## 7. 目录结构

```
SyncAnchor/
├── package.json            # 命令/视图/配置项声明（含 engines.vscode、publisher）
├── tsconfig.json
├── .vscodeignore           # 打包排除（src/、test/ 等；ssh2 运行时依赖必须保留）
├── .vscode/launch.json     # F5 调试配置（Extension Development Host）
├── README.md               # 商店展示（中文+英文可选）
├── LICENSE                 # MIT
├── CHANGELOG.md
├── media/                  # webview 静态资源（panel.html / panel.css / panel.js）
└── src/
    ├── extension.ts        # 激活入口、命令注册、视图注册
    ├── connection.ts       # 连接来源合并、ssh2 连接管理、握手
    ├── sshconfig.ts        # ~/.ssh/config 解析
    ├── syncEngine.ts       # 展开/对比/队列/上传
    ├── relative.ts         # 相对路径 + 越界防护
    ├── picker.ts           # showOpenDialog / InputBox / QuickPick
    ├── panel.ts            # Webview 面板生命周期 + postMessage 协议
    ├── activitybar.ts      # 图标容器 + 可见性监听（开面板/收侧栏/reveal）
    └── types.ts            # 共享类型（队列项、连接信息、消息协议）
```

## 8. 安全设计（防丢数据）

1. **无删除语义**：代码路径中不存在 `unlink`/`rmdir`，结构上杜绝误删
2. **越界防护**：相对路径硬校验，含 `..` 一律拒绝，保证落在远程 base 内
3. **预览确认**：上传前队列展示全部将覆盖目标，确认才动手
4. **排除规则**：巨型/无关目录默认跳过
5. **可选备份**：覆盖前备份，多一层后悔药
6. **不跟随符号链接**：默认跳过（防意外覆盖面）

## 9. 里程碑

| 阶段 | 内容 |
|---|---|
| **MVP** | 全屏面板 + 连接选择（config/最近连接）+ 本地树勾选 + 队列 + 上传覆盖 + 日志 |
| **v2** | 增量跳过（stat 对比）、覆盖前备份、远程树只读渲染 |
| **v3** | 反向拉取（远程→本地，复用相对路径逻辑）、diff 高亮、多 base 预设 |

## 10. 测试与发布

### 10.1 本地开发测试（F5）

1. `npm install`（安装依赖，含 ssh2）
2. VS Code 打开项目 → `F5` → 启动 **Extension Development Host**（独立窗口，加载当前插件）
3. 在开发宿主窗口中验证：
   - 点 Activity Bar 的 SyncAnchor 图标 → 全屏面板展开、侧边栏自动收起
   - 命令面板 → `Sync Anchor: Open Panel` 也能打开
   - 设置双端 base（本地用对话框选；远程填 `~/...`）
   - 勾选文件 → 队列预览 → 上传 → 查看日志与远程结果
4. 调试：VS Code 调试器断点（src 内）、`Output` 面板选 SyncAnchor 频道、webview 内 `console.log` 可在开发宿主 DevTools 看（命令面板 → `Developer: Toggle Developer Tools`）
5. 改完代码 → `Ctrl+Shift+F5` 重启开发宿主重新加载

> 注意：开发宿主使用真实 `~/.ssh/config` 与密钥，可直接连你的两台服务器测试，无需额外配置。

### 10.2 打包测试（vsix）

```bash
npm i -g @vscode/vsce
vsce package            # 生成 SyncAnchor-<version>.vsix
code --install-extension SyncAnchor-<version>.vsix   # 正式 VS Code 安装验证
```

### 10.3 发布到 VS Code Marketplace

**一次性准备（约 10 分钟）：**

1. **注册 Publisher**：打开 https://marketplace.visualstudio.com/manage （用 GitHub/Microsoft 账号登录）→ 创建 Publisher，填唯一 ID（如 `donaldtrump-coder`）→ 勾选同意 Marketplace 协议
2. **创建 PAT**：登录 https://dev.azure.com → 右上头像 → Personal Access Tokens → New Token：
   - Organization: 任意（默认 all accessible）
   - Scopes: 自定义 → **Marketplace → Manage**（只勾这一个）
   - 复制生成的 token（只显示一次）
3. `vsce login <publisher-id>` → 粘贴 token（token 存于系统凭据，无需重复登录）

**每次发布：**

```bash
vsce publish patch     # 自动: 改版本号(patch) → package → 上传发布
# 或: vsce package && vsce publish
```

**发布前置要求（vsce 会校验）：**

| 项 | 要求 |
|---|---|
| `publisher` | 与注册的 publisher ID 一致 |
| `name` | 唯一，如 `sync-anchor` |
| `version` | semver |
| `engines.vscode` | `^1.85.0` 之类 |
| `README.md` | 必填（商店页展示） |
| `LICENSE` | 必填，MIT |
| `repository` | 建议填 GitHub 仓库地址 |
| `icon` | 可选，128×128 PNG |
| `files`/`.vscodeignore` | **ssh2 是运行时依赖，必须打进 vsix**（放 `dependencies`，不要放 `devDependencies`） |

**常见坑：**
- `vsce package` 报 `Activating extension ... failed` → 本地先 F5 确认可激活再打包
- 发布后商店不显示 → 检查 publisher 与 PAT 的 Organization 匹配、Marketplace 协议是否勾选
- 图标失真 → 用 128×128 整倍 PNG
- `vsce` 版本过旧 → `npm i -g @vscode/vsce@latest`（需 Node 18+，本机已有）

## 11. 风险与开放问题

| 问题 | 状态/对策 |
|---|---|
| 系统级 always-on-top 不可用 | VS Code 锁了 Electron 窗口 API；用"拖出独立窗口 + 手动置顶"替代 |
| Activity Bar 图标不能直接触发命令 | 用 `TreeView.onDidChangeVisibility`（stable API）实现"点图标=开全屏面板+收侧栏"的等效体验 |
| 本地窗口读不到 Remote-SSH 活跃连接 | 诚实边界：以 config + 最近连接为候选；远程窗口才精确置顶 |
| OpenSSH 新私钥格式 (`OPENSSH PRIVATE KEY`) | ssh2 支持；不兼容时提示 `ssh-keygen -p -m PEM` 转换或走 ssh-agent |
| Windows 本地 / POSIX 远程路径差异 | 远程路径统一 `/` 拼接，不用 `path.join` |
