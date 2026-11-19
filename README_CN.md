# HTML 可视化编辑器（本地桌面工具）

[English](./README_EN.md) | 简体中文

面向开发者的轻量桌面工具：像使用 Word 一样**可视化编辑 HTML**，点击页面元素即可修改文字 / 替换图片 / 插入 / 删除区块，保存时做**源码级精准回填**，未改动的原始字节完整保留。也可以把本地 HTML 文件连同选中元素交给本机 Agent（codex / cbc）**直接修改文件**，以改前自动备份 + 一键还原保证可回退。

基于 **Tauri 2 + React + TypeScript** 构建，纯本地运行，不依赖云端服务。

---

## 功能

### 人工编辑
- **点击即编辑**：悬停高亮、点击选中字段，右侧面板修改文字或替换图片
- **插入 / 删除**：以选中元素为锚点，在前面 / 后面 / 开头 / 末尾插入文字或图片；一键删除选中区块
- **回退 / 重做**：人工修改区提供「↩ 回退上一步 / ↪ 重做」，可撤销不满意的改动
- **源码级精准保存**：仅替换目标节点的源码区间，未改动处字节级保真，不依赖整页 DOM 序列化
- **修改记录**：记录每处改动，支持逐条撤销
- **三种模式**：可视化（点选编辑）/ 源码（直接改 HTML）/ 预览（页面自身功能可正常操作）

### Agent 修改（agentic 直改）
- **交给 Agent 修改**：填写一句话指令，可附加截图，把当前 HTML 文件交给本机 Agent（codex / cbc）直接读、改、保存
- **选中上下文传递**：你把选中元素时，元素名称、DOM 路径、原文片段会作为「唯一修改目标」传给 Agent，避免它改错章节
- **自动备份与还原**：调用前自动备份原文件（`.hve-backup-<时间戳>.html`），结果不满意可一键还原
- **隔离与超时**：Agent 在干净临时目录中启动，避免被工作区里的 `AGENTS.md` / `.ccg` 工作流劫持；异步执行不卡界面，超时自动终止

### 文件与配置
- **文件操作**：打开本地 `.html` / `.htm`、保存（覆盖）、另存为 / 导出
- **Agent 设置**：发现并注册本机 Agent，设置当前使用的 Agent
- **跨环境兼容**：Tauri 桌面端和纯浏览器环境均可运行（浏览器端自动降级为文件选择 / 下载 / localStorage 配置）

> 设置页只有 **Agent** 一项。旧版的「模型」「外部调用」页签已随 agentic 架构移除；HTTP 模型调用相关前后端代码已清理，配置文件里的 `models` / `proto` 字段仅为兼容旧配置保留，不再参与运行。

---

## 环境要求

- Node.js ≥ 18
- Rust 工具链（cargo / rustc）—— 用于 Tauri 桌面端编译
- macOS / Windows / Linux（Tauri 跨平台）

---

## 安装与运行

```bash
# 安装依赖
npm install

# 开发模式（热更新）
npm run tauri dev

# 仅跑前端预览（文件操作降级为浏览器文件选择/下载）
npm run dev

# 打包桌面应用
npm run tauri build
```

打包产物（macOS 示例）：

```
src-tauri/target/release/bundle/
├── dmg/      HTML可视化编辑器_1.0.0_aarch64.dmg
└── macos/    HTML可视化编辑器.app
```

> 未签名时 macOS 可能被 Gatekeeper 拦截，可右键「打开」，或在终端执行：
> `codesign --force --deep --sign - "src-tauri/target/release/bundle/macos/HTML可视化编辑器.app"`

---

## 使用流程

1. 打开应用，点左轨「编辑器」，点击顶栏「打开」载入本地 HTML 文件。
2. 在「可视化」模式下点击页面元素，右栏出现目标卡片和人工修改 / 让 Agent 修改区域。
3. 人工修改：编辑文字（整段替换）、替换图片（本地图转 base64 内联）、插入 / 删除区块；不满意可回退 / 重做。
4. Agent 修改：在右栏「让 Agent 修改」写一句话指令，可附加截图，点「交给 Agent 修改」。程序会把当前文件 + 选中元素上下文交给本机 Agent 直接改盘；完成后自动重新读取文件并跳回编辑器。若结果不满意，点「还原到修改前」用备份覆盖。
5. 顶栏「保存」覆盖原文件，「另存为 / 导出」生成新文件。

---

## 核心原理

### 源码级精准回填
传统富文本编辑器通过 DOM 序列化生成 HTML，会丢失原始格式。本项目在源码字符串上做精准替换：

1. **节点定位**：用 `tag:nth-of-type(n)` 路径描述元素位置（不依赖 id / class），并逐层校验父链防止兄弟分支误命中。
2. **标签栈扫描**：扫描源码字符串，得到目标节点的 `start/end` 偏移。
3. **字符串替换**：只替换目标区间，其余字节原样保留。

对源码里定位不到的动态渲染节点，用页面加载后重放的「固化脚本」兜底。保存时会过滤掉已由源码写入的插入操作，避免同一处插入两次。

### Agent 直改与防重写
`agent_edit_file` 在干净临时目录里启动本机 Agent，把目标文件用绝对路径传入，并附带选中元素上下文与「只改这一处」的强约束，防止 Agent 加载工作区里的 `AGENTS.md` / `.ccg` 任务后重写整页（历史问题：曾把局部修改放大成整页信息图转换）。调用前备份、调用后做文件内容前后对比，未实际改动一律判失败。命令为异步执行并带 600 秒超时，界面不会卡死。

---

## 目录结构

```
.
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── src/
│   ├── main.tsx                # React 入口
│   ├── App.tsx                 # 主界面：编辑器（可视化/源码/预览）+ 设置 + 上下文面板
│   ├── styles.css
│   └── lib/
│       ├── tauriApi.ts         # 文件/配置封装 + Agent 调用（桌面端 + 浏览器降级）
│       ├── htmlPatch.ts        # 源码级精准回填、路径定位、固化脚本、灯箱
│       ├── config/             # 配置管理（Agent 注册表 / 当前 Agent）
│       ├── editCore/           # 编辑内核（FieldTarget / 校验 / 回滚）
│       ├── iframeBridge.ts     # iframe 内点选桥接
│       ├── agentEdit.ts        # 旧计划链路（仅测试引用）
│       ├── adapters/           # 旧 CLI 计划抽取（仅测试引用）
│       ├── blockRenderer.ts    # 旧块级安全渲染（仅测试引用）
│       ├── providers/          # 旧模型供应商预设（无引用，兼容保留）
│       └── imageResize.ts      # 图片等比缩放工具
├── src-tauri/
│   ├── src/main.rs             # Rust 入口 + 5 个自定义命令
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/default.json
├── scripts/
│   ├── test_full_e2e.mjs       # 真实文件端到端测试（55 项）
│   ├── test_*.mjs              # 各模块测试
│   └── TEST_REPORT.md          # 修复与测试记录
└── docs/
    ├── 技术方案.md
    ├── GUI使用说明.md
    └── （历史 GUI 界面原型为本地文件，不纳入版本控制）
```

---

## Tauri 命令

| 命令 | 作用 |
|---|---|
| `read_config` / `write_config` | 读写本机应用配置目录下的 `config.json` |
| `discover_agents` | 扫描 PATH 中的 codex / cbc / codebuddy / workbuddy / dsh / cloud-cli |
| `agent_edit_file` | 备份 + 临时 cwd + 选中上下文，调用本机 Agent 直接改文件，异步 + 超时 + 内容校验 |
| `restore_agent_backup` | 用备份覆盖还原文件 |

---

## 测试

```bash
npm run test:all          # 8 套模块测试串行
node scripts/test_full_e2e.mjs   # 真实 HTML 端到端测试（55 项）
npx tsc --noEmit          # 类型检查
cargo check --manifest-path src-tauri/Cargo.toml   # Rust 编译检查
```

详细修复与验证记录见 [`scripts/TEST_REPORT.md`](./scripts/TEST_REPORT.md)。

---

## 文档

- [README_CN.md](./README_CN.md)（本文）
- [README_EN.md](./README_EN.md)
- [技术方案](./docs/技术方案.md)
- [GUI 使用说明](./docs/GUI使用说明.md)
- 历史 GUI 界面原型为本地文件，已排除出版本控制，不在仓库中提供。
