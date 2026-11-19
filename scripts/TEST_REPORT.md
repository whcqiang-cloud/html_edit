# 测试与修复记录

> 本文件是按时间累积的修复与验证记录，**最新记录在最下方**。顶部快照为早期版本，仅供历史参考；当前应以下方 2026-11-19 各节的结论为准。

## 当前测试基线（2026-11-19）

| 检查项 | 结果 |
|--------|------|
| `npm run test:all`（8 套模块测试） | 全部通过 |
| `node scripts/test_full_e2e.mjs`（真实 HTML 端到端） | 55 / 55 通过 |
| `npx tsc --noEmit` | 通过 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `npm run tauri build` | 成功 |

---

## 历史快照（2026-08-05，早期版本）

**生成时间**: 2026-08-05T08:42:44.018Z
**执行耗时**: 0.45s

| 指标 | 数值 |
|------|------|
| 总用例数 | 108 |
| 通过 | 108 |
| 失败 | 0 |
| **通过率** | **100.0%** |

覆盖模块：imageResize.ts（resizeImage, getIframeContentWidth）、htmlPatch.ts（normalizeHtml, applyEdits, findNodeRange, getNodePath）。

---

## GUI 使用说明验收对照（2026-11-13）

按 `docs/GUI使用说明.md` 的验收点，逐项确认实现与测试状态。

| 使用说明验收点 | 实现位置 | 验证方式 | 状态 |
|---|---|---|---|
| 两大区：左轨 编辑器 / 设置 | `src/App.tsx` 左轨 | `tsc` 通过；桌面 GUI 需 `cargo tauri build` 后人工走查 | ✅ 代码就绪 |
| 编辑器三模式：可视化 / 源码 / 预览 | `App.tsx` `changeMode` | 源码模式按路径精准 patch（见下） | ✅ 代码就绪 |
| 字段级点选 + 浮动工具条 | `App.tsx` `onDocClick` / `showToolbar` | 沿用既有能力，纳入 editCore 四层校验 | ✅ |
| 上下文面板：目标（字段级）/ 人工修改 / 让 Agent 修改 | `App.tsx` 右栏 | 单字段流程经 `test_agent_edit.mjs` | ✅ |
| 设置中心三页签：代理 / 模型 / 外部调用 | `App.tsx` 设置视图 | 配置经 `test_config.mjs` | ✅ |
| 配置持久化（不写进 HTML、不含明文凭证） | `lib/config` + `tauriApi` | `test_config.mjs` 凭证过滤断言 | ✅ |
| 让 Agent 修改（单字段、不自动拆子任务） | `lib/agentEdit.ts` | `test_agent_edit.mjs`：明确/含糊/多件事分类、越界拒绝 | ✅ |
| 属性级 / 样式级精准改动（N8） | `htmlPatch.attrPatch/stylePatch` | `test_edit_core.mjs` 字节保真断言 | ✅ |
| 修改记录 + 逐条撤销 / 重做 | `App.tsx` 修改记录 | 保留并接入 | ✅ |
| 四层校验（指令合法 / 字节保真 / 结构等价 / 渲染回归） | `lib/editCore.validatePlan` | `test_edit_core.mjs` 全层断言 | ✅ |
| 外部调用能力清单 / 路径白名单 / 单文件单写者 | `App.tsx` 外部调用页签 | 能力清单与白名单 UI 就绪；单写者/幂等由后端 `call_agent` 落实 | ⚠️ 待构建 |

### 新增自动化测试覆盖

| 模块 | 测试文件 | 结果 |
|---|---|---|
| edit-core（四层校验 / apply / 回滚 / 漂移守卫） | `scripts/test_edit_core.mjs` | 全部通过 |
| 配置（Agent / 模型 / 绑定联动 / 凭证过滤） | `scripts/test_config.mjs` | 全部通过 |
| 让 Agent 修改（意图分类 / CLI 抽取 / 越界拒绝） | `scripts/test_agent_edit.mjs` | 全部通过 |

`npm run test:all` 串联 `test_patch → test_insert → test_e2e_insert → test_edit_core → test_config → test_agent_edit`，六项全绿。

### 构建验证（2026-11-16）

`npm run tauri build`（等价 `cargo tauri build`，本机 CLI 由 `@tauri-apps/cli` 提供）**构建成功**（含后续 UI 修复后的重新构建）：

- 前端 `tsc && vite build`：47 模块，产物 183KB 主包。
- Rust `release` profile：`Finished ... in 41.20s`，二进制 `src-tauri/target/release/html-visual-editor`（11MB）。
- 打包产物：
  - `src-tauri/target/release/bundle/macos/HTML可视化编辑器.app`
  - `src-tauri/target/release/bundle/dmg/HTML可视化编辑器_1.0.0_aarch64.dmg`（6.6MB）

构建过程中修复的两处后端问题：
1. `capabilities/default.json` 里自定义命令的授权标识（`com.local...:allow-*`）不符合 Tauri v2 标识规范而解析失败 —— 已移除；应用自定义命令默认允许，无需显式授权。
2. `src/main.rs` 未导入 `tauri::Manager` 导致 `AppHandle::path()` 编译错误 —— 已补 `use tauri::Manager;`。

### GUI 缺陷修复（2026-11-16）：可视化点选无反应 / 点击弹出页面自身对话框

用户反馈：可视化模式点内容不进编辑，反而触发页面按钮/链接弹出新页面。

- **根因**：重写 `App.tsx` 时丢失了原版的 iframe 桥接；`onClick` 绑在 `<iframe>` 元素上收不到 iframe 内部事件，页面自身脚本照常执行。
- **修复**：新增 `src/lib/iframeBridge.ts`，在 iframe 加载后于其 Document 上安装捕获阶段监听：`preventDefault`/`stopPropagation` 拦截页面行为、悬停高亮、点中元素回传 React（`selectElement`）；预览模式通过 `setEnabled(false)` 放行页面自身交互；加入可视化操作提示条。
- **测试**：新增 `scripts/test_iframe_bridge.mjs`（14 断言：拦截/回传/高亮/预览放行/启停），`test:all` 现为 7 套件全绿。

### 自定义模型表单补全（2026-11-16）

按用户提供的界面规格补全「设置 / 模型」页签的添加表单：

- `ModelDef` 扩展字段：供应商、接口地址、`apiKey`、`modelName`、工具调用 / 图片输入 / 思考模式 / 仅思考模式 / 允许关闭思考 / 自定义协议、`defaultReasoningEffort`、`supportedReasoningEfforts`、输入 / 输出默认值。
- `App.tsx` 模型页签改为受控表单：基础区（供应商下拉 / 显示名 / 接口地址 / API Key 密码框 / 模型名称）+ 可折叠「高级配置」区（能力勾选、思考强度下拉、思考强度多选、输入/输出默认值）。
- 凭证策略调整：`sanitizeForSave` 不再误删 `maxInputTokens`/`maxOutputTokens`；`models[].apiKey` 允许保存在本机配置（界面掩码、不写 HTML/导出），其他位置的凭证字段仍剔除。`test_config.mjs` 新增 4 项断言覆盖新字段与 apiKey 策略。
- 同步更新 `GUI使用说明.md` 与 `技术方案.md` 的模型表单字段说明。

### AI 修改报错修复（2026-11-16）

用户反馈：点「生成计划」报 `计划生成失败：调用 Agent 失败：No such file or directory (os error 2)`。

- **根因**：当前 Agent 为 `workbuddy` 且未绑定模型，后端 `call_agent` 回退到本地 CLI 拉起 `workbuddy`，本机无此二进制。
- **修复**：
  - `Cargo.toml` 加 `reqwest`（rustls + blocking）；`main.rs` 的 `call_agent` 新增 `model`/`current_text` 参数：有模型时调用 OpenAI 兼容 `/chat/completions`（自动补 `/chat/completions`、Bearer Key、系统提示词要求返回 `{"textTo":...}`），无模型时 CLI 回退并给出可操作错误提示。
  - `tauriApi.callAgent` 传模型配置对象；`App.tsx` 的 `boundModel()` 解析当前 Agent 绑定模型并传入接口/Key/模型名 + 字段当前内容；`onAgentPlan` 加模型预检与 `catch`，直接暴露后端错误。
  - 新增模型后若当前 Agent 未绑定则自动绑定，确保「生成计划」立即可用。
- **验证**：`cargo check` / `npm run tauri build` 成功（二进制 15MB）；新 DMG 已安装到 `/Applications`，SHA-256 一致。Rust HTTP 调用路径不在 Node 测试覆盖范围。

### 动态渲染字段四层校验修复（2026-11-16）

用户反馈：对数据驱动页面上 JS 渲染出的 `1,052` 执行 AI 修改，报「四层校验未通过」。

- **根因**：`1,052` 是页面 JS 从内嵌数据 `partNos:1052` 渲染出来的，源码里只有脚本数据、没有对应的 `<strong>` 节点。选中节点的 DOM 路径无法在源码中定位，layer2 硬失败。原版应用靠「固化脚本」在页面渲染后重放改动，新版 edit-core 丢失了这条动态节点通道。
- **修复**：
  - `HtmlEdit` / `FieldTarget` 增加 `dynamicNode` 标记：点选时若 `findNodeRange(sourceHtml, path)` 找不到，就标记为动态节点（人工编辑与 AI 计划两路都传递）。
  - `validateByteFidelity` 对 `dynamicNode` 跳过源码定位校验；`applyPlan` 对含动态节点的计划强制注入固化脚本并返回 `frozen` 状态。
  - `test_edit_core.mjs` 新增 5 项断言；并用真实文件 `紧固件showcase汇报.html` 验证：渲染出的 `<strong>` 路径源码不可定位，修复后四层全过、状态 `frozen`、固化脚本含目标文本 `1,045`。
- **验证**：`npm run test:all` EXIT 0，`npm run tauri build` 成功，新 DMG 已安装到 `/Applications`（SHA-256 一致）。

### 删除字段四层校验修复（2026-11-17）

用户反馈：对「HVAC热管理9,425…」执行「删除选择的内容」时提示「四层校验未通过」。

- **根因**：把字段文本删成空串会少一个文本叶子，第三层 DOM 结构指纹把它当成结构漂移硬失败（`文本叶子数变化：673 → 672`）。删除是合法改动，不该算结构破坏。
- **修复**：`sameFingerprint` 接收计划，按声明的 `remove` / `textTo === ""` 扣除允许减少的叶子数；动态节点由固化脚本重放，源码无叶子变化同样允许。
- **验证**：用真实文件 `运营监控视角_备份_202ddd60915_094504.html` 复现，修复后四层全过、`status: applied`；新增 3 项删除回归断言；`npm run test:all` EXIT 0，`npm run tauri build` 成功。
- **安装状态**：新 DMG 已构建（8.5MB，17:12），用户选择暂不安装，应用保持运行；新 DMG 保留在 `src-tauri/target/release/bundle/dmg/`，待用户手动退出应用后安装。

### AI 样式意图误改修复 + 样式支持（2026-11-18）

用户反馈：对 KPI 字段输入「将选择的内容转换为圆形布局」，页面被写入大量 HTML 源码文本，渲染全乱；随后明确表示「我自己手工修改，那我要AI何用」，不接受把样式/布局改动直接拒绝掉。

- **根因**：`classifyIntent` 把样式/布局指令判为 explicit 发给模型；模型返回带 HTML 标签的 `textTo`；`extractPlan` 原样采纳，layer1 只校验"有没有改动"未校验内容类型，四层全过，HTML 被当文本写进页面。
- **最终方案（防误写 + 真正支持样式）**：
  1. 保留防御：`extractPlan` 拒绝含 `<`/`>` 的 `textTo`、拒绝 `outerHtml`/`insertHtml`/`remove` 越界操作、拒绝越界 path 与模型 `error` 响应；`editCore` layer1 对含 HTML 标签的 `textTo` 硬失败，源码不会被污染。
  2. 打通能力：`PLAN_SYSTEM_PROMPT` 要求样式/布局返回 `{"stylePatches":[{"prop":"border-radius","value":"50%"}]}`（改 class 用 `attrPatches`）；`extractPlan` 抽取并校验样式/属性补丁。
  3. UI 接通：`agentPlan` 保存完整 `EditPlan`，计划预览逐条显示「样式：prop = value」；`Modification.edits` 保存模型原始编辑，`finalize()` 原样重放（含 `dynamicNode`），不再按纯文本重建。
  4. 固化脚本合并键加入 `prop`，同一元素的多个样式属性不会互相覆盖。
- **验证**：`test_agent_edit.mjs` 用「圆形布局」验证生成 `stylePatches` → 四层通过 → `border-radius:50%` 写入开标签且原文字不变；新增 `extractPlan` 样式/属性抽取与非法样式值拒绝断言；`test_edit_core.mjs` 新增多样式属性固化断言。`npm run test:all` 全绿，`npm run tauri build` 成功。
- **用户文件**：确认 `/Users/johnny.chen/Documents/Lemur数据运营/` 下所有 HTML 均未被写坏（无损坏文本、修改时间为旧），损坏只在运行中的应用内存里。
- **安装状态**：用户此前选择暂不安装；新 DMG 已重新构建，待用户手动退出应用后安装。

### 块级结构重排（2026-11-18）

用户提出完整流程：AI 理解需求 → 找到选中部分的代码 → 生成新代码 → 替换原有代码 → 融入整页风格；并指出改布局必然影响一整块，不该被「单字段」约束卡住。

- **根因**：上一版只允许改一个字段的文字/CSS 属性，无法表达「把四张 KPI 卡片重排成四层金字塔」；模型只能把结构写成文字塞进字段，才出现满屏说明文字。
- **方案**：
  1. 意图分类新增 `structure`（金字塔/结构/重排/层级/分成几层等），与样式 `style` 分开；「转换成圆形布局」仍走样式，不误判。
  2. 点选字段时列出向上 6 层可选「整块重排范围」，用户挑要改哪一整块（默认最近一层）。
  3. 后端 `call_agent` 新增 `contextHtml`：把原块 HTML + 页面已有 class/颜色/字号一起交给模型，提示词要求沿用原风格、保留所有数字，只返回 `{"blockHtml":"..."}`，禁止脚本/外链/事件。
  4. `blockRenderer.ts` 安全渲染器做白名单清洗：只留展示类标签，剔除 script/iframe/事件属性/javascript 链接/外链样式，超限拒绝。
  5. `HtmlEdit` 新增 `blockHtml`/`blockFrom`：整块替换时只换该块内部，外层标签与块外字节原样；四层校验对块级重排跳过「结构指纹不变」（结构本来就要变），块外字节仍由第二层守住。
  6. 固化脚本新增 `block` 操作，动态渲染页面也能重放；修改记录按整块事务，撤销整块回退。
  7. 计划预览用当前页面样式渲染新块的 iframe，用户先看到效果再点应用。
- **验证**：新增 `test_block_rearrange.mjs`（22 项：意图区分、安全清洗、风格线索、整块替换、块外字节不变、四层校验、固化重放）；`npm run test:all` 全绿，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`，用户手动退出应用后安装。

### 应用无变化 + 运行检查报错修复（2026-11-18）

用户反馈两处：点「应用」后文件没有任何变化；设置页「运行检查」报 `TypeError: Load failed`。

- **应用无变化的根因**：块级替换用 iframe 渲染后的 `outerHTML` 与源码做字节级比对，JS 给元素加属性/改文字后必然不等，于是 `applyEdits` 静默跳过整条编辑，但界面仍提示「已应用」。
- **修复**：
  1. 块级定位改为「路径优定位 + 标签名兜底」，不再拿渲染后的文字/属性做精确比对；JS 渲染差异不再导致跳过。新增 2 项回归断言（渲染差异仍真正替换、块外字节不变）。
  2. 整块重排的「动态节点」判断改用块路径（原来用字段路径），源码里没有该块时明确走固化脚本，提示改为「页面加载后重放新结构」，不再谎称已直接应用。
  3. 选中字段时自动把默认重排范围指向「一组相似兄弟」的那一层，避免默认落到太小的父元素（例如只替换筛选按钮而不是整排 KPI）。
- **运行检查报错的根因**：`probeModel` 在前端 webview 里 `fetch` 模型端点，被跨域/混合内容策略拦截。
- **修复**：新增后端 `probe_model` 命令用 reqwest 发最小 POST（带 Bearer Key），前端 Tauri 环境改走该命令；返回 HTTP 状态码，401/429 视为「端点可达但凭证/参数需检查」，连接失败才报不可达。
- **验证**：`npx tsc --noEmit` 无错误，`npm run test:all` 全绿，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 新结构浮在页面左上角、未替换原块（2026-11-18）

用户反馈：应用整块重排后，生成内容变成浮在页面左上角的竖排方块，原 KPI 行仍在，等于多出一份而不是替换。

- **根因**：
  1. AI 画金字塔时常用 `position:absolute;top;left;z-index;transform`，原安全渲染器没剥这些定位属性，插进原块后就脱离文档流盖在页面上。
  2. 固化脚本的 `block` 重放按 DOM 路径选择器命中，路径漂移时会把新结构塞进带定位的小容器里；且每次点击都重放，页面脚本重渲染后反复插入。
- **修复**：
  1. `safeStyle` 剥掉 `position` / `top/right/bottom/left` / `float` / `z-index` / `transform`，只保留正常文档流可用的样式（宽高、颜色、对齐、间距等）。
  2. `FreezeOp` 新增 `fromText`（原块文字签名）：固化重放时选择器命中元素若不含原块文字，就按文字在全页找真正的目标块；找不到就不动，绝不乱插。替换后打 `data-hve-block-done` 标记，避免重复重放。
  3. 后端结构提示词明确：这是替换不是新增、原块每个数字都要重新出现、金字塔用正常文档流逐层排列、禁止一切定位属性。
- **验证**：新增 3 项断言（剥绝对定位/保留内容样式、定位属性不残留）；`npx tsc --noEmit` 无错误，`npm run test:all` 全绿，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 修复已损坏的历史文件（2026-11-18）

用户反馈连续几轮修改后「没有任何改进」。实际排查发现：问题不在新生成的逻辑，而是用户打开的 `运营监控视角_备份_202ddd60915_094504.html` 本身早就被写坏了，新代码救不了已损坏的字节。

- **证据**：对比同目录两份备份——
  - `备份_202ddd...`（用户打开的）：含旧冻结脚本（把表格数字改成 `12,2005`）、表格前有游离文本 `12,200000<b>HVAC热管理9,42512,207.7%...`。
  - `备份_20260915...`：冻结脚本 0 处、游离文本 0 处，干净。
  - 截图里浮在左上角的竖排块，正是这段游离文本 + 旧冻结脚本造成的。
- **处理**：
  1. 生成修复副本 `运营监控视角_备份_202ddd60915_094504_修复.html`（SHA256 前缀 `23323c6e8f81525a`）：删除游离坏文本与旧冻结脚本，表格前恢复为直接的 `<table>`，与干净版一致，标签配平。
  2. `stripEditorArtifactsFromSource` 增加自愈规则：清除 `\n 数字<b>文本</b><table` 这类历史游离坏文本；`loadHtml` 打开任何文件时都先走一遍，历史损坏文件不再反复出问题。
- **验证**：新增回归断言，`npm run test:all` 全绿，`npm run tauri build` 成功。

### 第一次修改后无法再次点选（2026-11-18）

用户反馈：手工修改第一次可用，改完之后再怎么点，右栏还是第一次选中的内容。

- **根因**：每次修改后 `docHtml` 变化会让 iframe 重新加载，产生新 document；但旧 window 上残留着 `__hve_sel_bridge__` 桥接实例，`installSelectionBridge` 的幂等判断只看这个标记存在就复用旧实例。旧实例的点击监听绑在已销毁的旧 document 上，新页面没有任何监听，所以点击不进选择逻辑，`selectedField` 一直停在第一次的值。
- **修复**：`SelectionBridgeApi` 增加 `boundDoc()`；幂等复用改为「标记存在 **且** 绑定 document 与当前相同」才复用，否则重新安装监听。新增 3 项回归断言：重载后实例被换新、新页面点击能回传、监听绑在新 document。
- **验证**：`npm run test:all` 全绿，`npm run tauri build` 成功。

### 人工修改三处修复（2026-11-18）

用户反馈：点选了「样本口径 24,613」，人工修改框却还是第一次选中的内容；点「插入」没反应；文本框太小、内容多时需拖动、要求自动增高且禁止左右滚动条。

- **根因与修复**：
  1. **内容不更新**：输入框用 `defaultValue` 且 React 复用同一个 DOM 节点，defaultValue 变化不生效。改为受控 `textarea`（`editText` state），在 `selectElement` 和 `applyTextEdit` 时同步，选中即显示当前内容。
  2. **插入没反应**：按钮用浏览器 `prompt()`，Tauri webview 里被拦截。改为面板内插入：点「插入」展开一个文本域 + 位置下拉（之前/之后/开头/末尾），填好后点「确认插入」写入。
  3. **文本框太小**：单行 `input` 改为 `textarea`，`rows` 按内容长度自动增高（最多 12 行、280px），`white-space:pre-wrap` + `overflow-wrap:anywhere` 强制换行，`overflow-x:hidden`（无左右滚动条）、`overflow-y:auto`（内容多时上下滚动）。
- **验证**：`npx tsc --noEmit` 无错误，`npm run test:all` 全绿；DMG 首次打包遇到残留挂载卷 `/Volumes/dmg.BhMIEK`，卸载后重建成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 整段文字替换 + 插入图片（2026-11-18）

用户反馈：选中「执行摘要」整段文字，只在末尾加了 FFFF，应用后文字全乱——FFFF 出现在中间、原文又跟一遍；插入功能不能插入图片。

- **根因**：
  1. 选中的元素内部被 `<b>` 分成多个文本节点，编辑框显示的是合并后的整段文字，但代码用 `textTo` 只替换「第一个文本节点」，后面的原文本节点还在 → 文字叠加错位。`resolveTextLeaf` 里 `textNodeIndex` 的计算也是错的（拿元素去匹配文本节点，永远得 0）。
  2.  `resolveTextLeaf` 的字段显示区没有插入图片入口。
- **修复**：
  1. 人工编辑新增「整段文字替换」机制：`HtmlEdit` 增加 `innerText`/`innerFrom`，`applyEdits` 用整段纯文本替换元素内部全部内容（含内联 `<b>`），并用编辑前整段文字校验定位；固化脚本新增 `innertext` 操作，重放时也整段替换并按文字找正确元素。人工编辑 `applyTextEdit` 与 `finalize` 都改用这套机制，AI 的字段级 `textTo` 路径不变。
  2. 插入面板增加「选择图片插入」按钮：调 `selectLocalImage()` 选本地图片转 base64，自动填入 `<img src="data:..." style="max-width:100%;height:auto">` 到插入文本框，点确认插入。
- **验证**：新增 4 项断言（整段替换唯一、原文不重复、块外字节不变、固化操作为 innertext），`npx tsc --noEmit` 无错误，`npm run test:all` 全绿，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 图片插入锚点错误（2026-11-18）

用户反馈：选中列表里「注塑实例口径」那条 `<li>` 后插入图片，图片跑到了整个文档最后，而不是所选位置。

- **根因**：`applyInsert` 用 `selectedField.blockPath`（所属整块，这里是整个 `<ul>`）当锚点，而不是用户实际点选的元素 `fieldPath`。位置选「之后」时插到整个 `<ul>` 后面，看起来就像文档末尾。
- **修复**：插入锚点改用 `selectedField.fieldPath`，图片紧邻所选元素。新增 3 项回归断言：li 列表插入后顺序为 `a,b,img,c`、图片在列表内没跑到末尾、页尾仍在列表后。
- **验证**：`npx tsc --noEmit` 无错误，`npm run test:all` 全绿；DMG 打包遇到残留挂载卷，清理后重建成功。

### Agent 修改链路对齐重构（2026-11-19）

用户明确需求：工具里「选内容 + 语义描述 → Agent 修改」的过程和结果，要和直接把整个文件交给 Agent、让它读文件后修改完全一致。只改 Agent 链路，手工修改逻辑不动。

用户反馈的两个具体 bug（截图，文件 `~/Downloads/产品研发域_MCU本体三层落地评估_产品基座数据.html`）：
1. 预览里生成的柱状图有橙色「3」垃圾柱子——读取的选中对象不对；
2. 点「应用」后原始文件没被修改——没写盘。

- **根因 1**：`gen.generate` 结构重排时从选中块抠「数据清单」发给模型，而默认块选择用「标签类型 ≤ 2」会把单行 `.bar-row`（span+div+span）当成一组选中，清单退化成 `- （未命名）：45`，模型拿不到三项完整数据就编造出「3」。
- **根因 2**：`onAgentApply` 只把改动记进内存 `modifications` 并 `setDirty(true)`，从未调用 `saveHtmlFile`，写盘只发生在手工点「保存」时。

- **重构（仅 Agent 链路）**：
  1. 后端 `main.rs`：把 `PLAN_SYSTEM_PROMPT` / `STRUCTURE_SYSTEM_PROMPT` 两套碎片提示词合并为一套 `FILE_EDIT_SYSTEM_PROMPT`——模型收到「完整 HTML 文件 + 点选定位 + 一句语义指令」，像接管整个文件一样阅读理解；输出协议不变（textTo/stylePatches/attrPatches/blockHtml），四层校验与安全清洗照旧。`call_agent` 参数 `current_text`/`context_html` 改为 `full_html`/`locator`；CLI 回退也把完整文件经 stdin 交给本机 Agent。
  2. 前端 `tauriApi.callAgent` 参数同步为 `fullHtml`/`locator`。
  3. `App.tsx` `gen.generate`：不再抠数据清单/碎裂字段，改为发完整 `docHtml` + 定位信息（字段名、字段路径、块路径、当前内容；**不发块 HTML 原文**，避免旧结构二次污染）。
  4. 默认块选择从 `tags.size <= 2` 收紧为 `tags.size === 1`（只认同标签兄弟组），确保选中 `.bars` 整组而非单行 `.bar-row` 或混合的 `.card`。
  5. `onAgentApply` 改为「应用即写盘」：用包含新改动的列表经 `finalizeWith` 算出完整 HTML，`saveHtmlFile` 写回原文件；写盘成功后以该结果为新基线、清空改动记录与历史，避免下次重放重复应用。手工保存路径仍走等价的 `finalize()`，行为不变。

- **验证**：`npx tsc --noEmit` 无错误；`cargo check` 通过；`npm run build` 成功；`test_full_e2e.mjs` 42/42（新增 3 项默认块选择回归）；`npm run test:all` 全绿。手工逻辑（applyTextEdit/applyInsert/applyDelete/onSave/undo/redo）未改动。

### 源码定位写错位置修复（2026-11-19）

用户反馈：Agent 修改点应用后，原始文件「没有完成修改」。核查Downloads 文件发现文件其实被写入了（50085→57980 字节），但新柱状图塞进了 `<div class="brand-title">`（左上角品牌区，替换掉「MCU 三层落地评估」标题），真正的 bars 块原封未动。

- **根因**：`findNodeRange` 按 `tag + nth-of-type + depth` 匹配源码节点，只比嵌套深度、不校验父链。`<aside>` 与 `<main>` 是兄弟，内部元素 depth 相同；card 路径 `body>div>main>section>div` 的 depth 恰好与 `aside>div.brand>div.brand-mark` 相同，后者作为同 depth 的第 1 个 div 被误命中，新内容写进品牌区。复现：card 路径 `...section:nth-of-type(1)>div:nth-of-type(1)` 定位到 brand-mark。
- **修复**：`findNodeRange` 入栈时记录每层的 nth-of-type，命中前用 `chainMatches` 逐层校验完整父链（tag+nth 全部匹配才算命中），排除兄弟分支混淆。
- **验证**：复现脚本确认 card/bars/bar-k 路径均定位到正确节点；端到端写入验证：柱状图写入 bars 块、品牌区标题保留、`flex-direction:row` 只出现 1 次；`test_full_e2e.mjs` 新增 2 项父链回归断言，44/44 通过；`npm run test:all` 全绿，`cargo check` 通过，`npm run tauri build` 成功。
- **注意**：用户当前打开的 Downloads 文件已被旧版本写坏（品牌区被塞柱状图 + 固化脚本），需从干净副本重新打开后再操作。Documents 下的同名文件仍是干净基线（50085 字节）。

### Agentic 直改文件重构（2026-11-19）

用户澄清核心需求从一开始就是「直接把文件交给 Agent workbuddy，像桌面版添加文件一样，让 Agent 自己读、改、存」，而不是「Agent 产出计划 + 我们的 ts 落地」。改造前已备份项目源码到 `~/Documents/MyWork/html_edit_backup_20261119_104746/source.tar`。

- **查证**：读官方文档 + 本机 `codex exec --help` / `codebuddy --help` 确认两条 agentic CLI：
  - codex：`codex exec -C <dir> -s workspace-write --dangerously-bypass-approvals-and-sandbox [-i 截图] <prompt>`（本机实际参数，非文档里的 --full-auto）
  - workbuddy/codebuddy：`cbc -p <prompt> -y`（cwd=文件目录），本机 `codebuddy`/`cbc` 在 `/opt/homebrew/bin`
  - 本机没有单独的 `workbuddy` 可执行文件，桌面版 workbuddy 的 CLI 入口就是 codebuddy/cbc

- **改造（仅 Agent 链路，手工修改零改动）**：
  1. `main.rs` 新增 `agent_edit_file` 命令：校验绝对路径 → 备份原文件（`<名>.hve-backup-<时间戳>.html`）→ 按 agent_id 构造 agentic 命令 → 以文件所在目录为 cwd、可写模式启动 → 等待 Agent 自己改盘；`build_agent_command` 支持 codex / cbc 两条；新增 `restore_agent_backup` 一键还原；两者已注册到 invoke_handler。`discover_agents` 增加 cbc/codebuddy 发现。
  2. `tauriApi.ts` 新增 `agentEditFile` / `restoreAgentBackup` / `saveTempImage`（截图 data URL 落临时文件供 `-i`）。
  3. `App.tsx`：删掉 `gen`/`onAgentPlan`/`onAgentApply`/`buildBlockPreview` 与 `agentPlan`/版本锁/模型绑定等旧计划态；新增 `onAgentEdit`（备份→交给 Agent→重新读文件刷新）、`onAgentRestore`；UI 改为「附加截图（可选）+ 交给 Agent 修改 + 结果/还原」；设置页说明同步更新。手工的 `applyTextEdit`/`applyInsert`/`applyDelete`/`onSave`/`finalize`/撤销重做/修改记录 UI 全部未动（`describeEdits` 因被修改记录复用而保留）。
  4. `config/index.ts` 默认 Agent 命令模板更新为 agentic 形式；`styles.css` 增加 agentic UI 样式。

- **代价**：agentic 直改没有中间计划预览和四层校验（与桌面版一致），以调用前自动备份 + 一键还原替代。

- **验证**：`npx tsc --noEmit` 通过；`cargo check` 通过；`npm run test:all` 全绿；`npm run tauri build` 成功。**真实 agentic 验证**：临时 HTML 文件（`<h1>旧标题</h1>`）交给 `codex exec` 后，文件被真实改为 `<h1>新标题</h1>` 并保存，证明「Agent 自己读改写」链路打通。

### GUI 启动 Agent 报 No such file or directory 修复（2026-11-19）

用户实测报错：`启动 Agent「cbc」失败：No such file or directory (os error 2)`。

- **根因**：`cbc`/`codebuddy`/`codex` 都在 `/opt/homebrew/bin`，其 shebang 为 `#!/usr/bin/env node`（node 也在 homebrew）。终端能跑是因为 shell PATH 含 `/opt/homebrew/bin`；但 GUI 应用从 Finder/Dock 启动不继承 shell PATH（`launchctl getenv PATH` 为空），`Command::new("cbc")` 按裸名找不到，`env node` 同样找不到。
- **修复**（`main.rs`）：新增 `resolve_program` 把裸命令解析成绝对路径（先当前 PATH，再 `/opt/homebrew/bin`、`/usr/local/bin`、`$HOME/.local/bin`、`.cargo/bin`、`.codebuddy/bin` 等常见位置，校验可执行位）；新增 `augmented_path` 构造增强 PATH 并用 `.env("PATH", ...)` 注入子进程，保证 shebang 的 `env node` 能找到。`cargo check` 通过，`npm run tauri build` 成功。

### Agent 未登录却误报「已修改」修复（2026-11-19）

用户实测：界面显示「Agent 已直接修改并保存到文件」，但文件没变（修改时间停在 09:54，无备份文件）。当前 Agent 是 workbuddy。

- **根因**：实测 `cbc -p ... -y`（workbuddy 的 CLI）输出 `Authentication required. Please use /login command...` 到 stderr，但**退出码为 0**；后端只看 `status.success()` 就判定成功，前端据此显示「已修改」并重新读文件，视觉上毫无变化。上一轮只验证了 codex 已登录可用，未验证 cbc，属疏漏。
- **修复**（`main.rs` `agent_edit_file`）：
  1. 调用前用 `fs::read` 记录文件内容，调用后再次读取对比——**以文件是否真的变化为准**，未变化一律返回失败（错误里附 Agent 输出片段）；
  2. 检测 stdout+stderr 中的认证失败关键词（authentication required / please use /login / not logged in / unauthorized / 需要登录 / 未登录），命中则给出明确提示：`codex login` 或 `cbc /login`，并说明需先在终端登录。
- **验证**：`cargo check` 通过，`npm run tauri build` 成功。用户需先在终端登录 workbuddy/CodeBuddy（`cbc /login` 或桌面版登录后重试），或切换到已登录的 codex。

### 设置页与遗留前后端代码清理（2026-11-19）

用户确认 agentic 改造后「模型」「外部调用」两个设置页已无意义（Agent 直接调本机 CLI，不走 HTTP 模型；外部调用配置从未被消费），要求清理。清理前备份到 `~/Documents/MyWork/html_edit_backup_20261119_112633/source.tar`。

- **前端 `App.tsx`**：删掉「模型」「外部调用」两个 tab 及 tab 栏；删掉 Agent 页里的「模型选择」下拉、「运行检查」按钮与结果；顶栏和状态栏删除「模型：xxx」；删除相关 state（models/protoEnabled/protoWhitelist/probeResult/modelForm/advOpen）、handlers（onProbe/onAddModel/onProtoToggle）、常量 `PROTO_CAPS`；refreshConfig 只同步 Agent。手工编辑链路（applyTextEdit/applyInsert/applyDelete/onSave/finalize/撤销重做）未动。
- **前端 `tauriApi.ts`**：删除 `callAgent` / `ModelCallOptions` / `probeModel`。
- **后端 `main.rs`**：删除 `ModelCallConfig`、`FILE_EDIT_SYSTEM_PROMPT`、`call_openai_compatible`、`call_agent`、`probe_model`；从 invoke_handler 移除这两个命令；清理 `Duration`/`Deserialize` 导入。
- **依赖**：`Cargo.toml` 删除不再使用的 `reqwest`。
- **兼容性**：`config/index.ts` 的 `models`/`proto` 字段与 `ModelDef`/`ProtoSettings` 类型保留（仅数据定义，不参与运行），确保旧配置文件仍可读。
- **验证**：`npx tsc --noEmit` 通过；`cargo check` 通过；`npm run test:all` 全绿；`test_full_e2e.mjs` 44/44；`npm run tauri build` 成功。前端打包 JS 从 194.92 kB 降到 185.89 kB。

### 手工插入图片重复 + 回退功能（2026-11-19）

用户反馈：手工插入图片时点击插入会同步插入两个图片进文件；并要求手工修改时增加「回退到修改前内容」功能。修改前备份到 `~/Documents/MyWork/html_edit_backup_20261119_120434/source.tar`。

- **根因（插入两次）**：`onSave`（和 `onSaveAs`）保存成功后把 `originalHtml`/`sourceHtml` 更新为已含插入的 HTML，但**没有清空 `modifications`**。而 `finalizeWith` 的逻辑是「有改动记录就基于 `originalHtml` 重放所有 edits」——保存后再次渲染/再保存时 insert edit 被重放第二次，图片翻倍。脚本验证：第一次 finalize 1 张图，保存后不清记录再 finalize 变 2 张。
- **修复**：`onSave`/`onSaveAs` 保存成功后清空 `modifications`/`history`/`redoStack`，并重置 modCount=0。新基线已含改动，记录归零，杜绝重复重放。
- **回退功能**：在「人工修改」区顶部新增回退工具栏（显示已修改处数 + 「↩ 回退上一步」「↪ 重做」按钮），复用现有 undo/redo（切换 reverted 标志，finalizeWith 跳过已回退 edit）。修改记录页原有撤销/重做保留。
- **验证**：`test_full_e2e.mjs` 新增第 12 节「保存后重置基线」3 项回归（第一次 1 张 / 未清记录会 2 张 / 修复后 1 张），47/47 通过；`npm run test:all` 全绿；`npx tsc --noEmit` 通过；`npm run tauri build` 成功。

### 界面自动跳转 + 移除浮动工具栏（2026-11-19）

用户反馈：1) Agent 改完文件后界面没自动跳转；2) 移除选中元素时的浮动「编辑/删除块/插入」三个按钮。

- **修复 1（自动跳转/刷新）**：`onAgentEdit` 与 `onAgentRestore` 在 `loadHtml` 后显式 `setView("editor")` + `setMode("visual")`，确保从任意页面跳回编辑器可视化视图。另新增 `frameKey` state，`loadHtml` 时递增并作为 iframe 的 `key`，保证文件内容变化后 iframe 强制重载显示最新内容（`srcDoc` 字符串恰好相同时也能刷新）。
- **修复 2（移除浮动按钮）**：删除 `.float-toolbar` DOM（编辑/删除块/插入三个按钮）、`toolbarRef`、`showToolbar`/`hideToolbar` 函数及调用点、`changeMode` 里的隐藏调用；`iframeBridge.ts` 删除 `hideToolbarSafe` 及 `setEnabled` 里的调用；`styles.css` 删除 `.float-toolbar` 样式。右栏「人工修改」里的人工编辑/插入/删除功能保留不变。
- **验证**：`npx tsc --noEmit` 通过；`npm run test:all` 全绿；`test_full_e2e.mjs` 47/47；`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 可视化模式下标签无法切换（2026-11-18）

用户反馈 `运营监控视角_副本5.html` 打开后只能静态显示，点标签切不了页面。

- **排查**：核实文件本身没坏——17 个 `onclick`（都是 `<button>` 的 `switchRole`/`switchTargetBrand`/`switchCmt`/`switchEdt`）、4 段脚本经序列化后完好。问题在可视化模式的点选桥接：它对所有点击都 `preventDefault`+`stopPropagation`，把这些标签按钮的 onclick 一起拦掉了。
- **修复**：桥接放行页面自身的交互元素——`button/a/input/select/textarea/label/summary`、带 `onclick`/`onchange`/`data-target-brand-switch`、`role=button/tab/link`、`contenteditable` 的元素及它们的子元素。这些点击交给页面处理（标签可切换）；普通文字/图片仍拦截用于点选字段。悬停高亮也跳过交互元素。更新界面提示为「标签按钮、链接仍可正常点击」。
- **验证**：桥接测试改写旧断言（原来断言按钮被拦截，现改为放行），新增带 `onclick` 的 div 与品牌切换按钮放行断言；`npm run test:all` 全绿（桥接 21 项通过），`npx tsc --noEmit` 无错误，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### AI 把「转柱状图」做成字符画乱码（2026-11-18）

用户对比 AI 修改前后：图一正常三层梯队横向进度条，图二变成 `50 50 |▮▮▮| ███ ▮ ...` 的字符乱码堆在页面上。

- **根因**：指令「将选择的图形转换为纵向柱状图。」里，「图形 / 柱状图 / 纵向」都不在 `STRUCTURE_PATTERN` 中，被判成 `explicit`（普通文字改动）。模型在「只返回纯文字」的提示词约束下，只能用 `█ ▮ |` 等字符拼了个假柱状图当文字返回，插入到字段后就成了一行乱码。
- **修复**：
  1. `STRUCTURE_PATTERN` 增加 柱状图/条形图/折线图/饼图/曲线图/雷达图/图表/纵向/横向/竖排/横排/图形/图示/可视化，这类指令改走结构重排通道，由 AI 生成整块 HTML。
  2. 结构提示词明确禁止用 `█ ▮ ▉ ░ | -` 等字符拼假图，必须用真实 HTML 元素 + inline style 画色块。
- **验证**：新增 3 项意图断言（图形转纵向柱状图/改成柱状图/转成图表均为 structure）；`npx tsc --noEmit` 无错误，`npm run test:all` 全绿，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 柱状图应用后竖排散乱（2026-11-18）

用户对比：图一预览是正常的纵向柱状图，图二应用后变成竖排文字 + 散落色块。

- **排查结论**：预览正确说明 AI 生成和渲染没问题；错在应用后的样式继承。查实际文件发现两条 `.bars` CSS：
  - `.bars{background:...;padding:18px 20px}`（原进度条容器）
  - `.bars{display:flex;flex-direction:column;gap:9px}`（原进度条行）
  - AI 用了 `class="bars"` 生成新柱状图（`display:flex` 但没写 `flex-direction:row`），被原 CSS 的 `flex-direction:column` 接管 → 竖排散乱。
- **定性**：主要是提示词 + 生成策略问题（让 AI「沿用原 class」却没让它覆盖全部布局属性）；工具侧安全渲染器未隔离样式放大了它。**不是 AI 工具不会生成**——预览能画出正确柱状图。
- **修复**：
  1. 结构提示词：明确禁止复用原页面任何 class（如 bars/kpi/row），颜色照抄具体色值但写 inline；用到 flex 必须把 display/flex-direction/align-items/justify-content 全部写明，自包含不依赖外部 CSS。
  2. 安全渲染器 `renderSafeBlockHtml`：剔除所有 `class` 和 `id` 属性，杜绝继承原页面同名样式。
- **验证**：更新 3 项旧断言 + 新增 2 项（剔除 class、复用 bars 被剔除），`npm run test:all` 全绿，`npx tsc --noEmit` 无错误，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 柱状图柱子竖着堆、不是从左到右并排（2026-11-18）

用户指出：AI 生成的「柱状图」是一个柱子接一个竖着排，而不是一个图里从左到右三根柱子（产品层 / 基座平台能力层 / 数据层）。

- **根因**：结构提示词第 7 条只说「用真实 HTML 画出色块」，没有规定柱状图的坐标结构——哪个容器横向排、柱子是不是直接子元素、标签放哪。模型只能自己理解，把三根柱子竖着堆起来。用户的「逆时针旋转90度 + 从左到右依次布局」又叠加了理解冲突（原图是横向条形图），模型把「层」从左到右排了，但每根柱子的方向没摆对。
- **修复**：提示词加入柱状图标准结构模板：外层容器 `display:flex;flex-direction:row;align-items:flex-end;gap:24px;height:240px`，N 根柱子作为直接子元素横向并排，每根柱子 `flex-direction:column` + 固定宽 + 按数值的高 + 背景色，柱内下方标签上方数值；明确「不是一根柱子+标签各占一行、不是套 bar-row 行、不是把三行文字竖着堆」。
- **验证**：`npx tsc --noEmit` 无错误，`npm run test:all` 全绿，`npm run tauri build` 成功（提示词里 HTML 示例的引号做了 Rust 转义）。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 发给模型的上下文污染导致图表照抄旧结构（2026-11-18）

用户指出：同一文件同一提示词，直接在 workbuddy 里用能得到正确柱状图，本工具调用却生成竖排散乱的柱子。

- **根因（非提示词措辞、非模型能力）**：工具构造请求时把**原块 HTML 样板**整段发给了模型：
  1. `要修改的那一块现有 HTML` 里是 `.bars > .bar-row ×3` 的旧结构，用户说「旋转90度/从左到右」时，模型最省力就是照抄旧结构换个方向 → 一根柱子+标签竖着堆。
  2. `字段当前内容：42 基座平台能力层50 数据层45` 是碎裂文本，分不清数值对应关系。
  3. `页面风格线索`列了 60 个 class 名（含 bars/bar-row），诱导模型复用同名 class，与提示词「禁止复用 class」自相矛盾。
  - 证明：workbuddy 直接用同一句提示词正常，说明模型没问题；问题在我喂给它的上下文。
- **修复**：
  1. 新增 `collectBlockData`：从选中块 DOM 提取干净清单（实测 `产品层：42 / 基座平台能力层：50 / 数据层：45`），结构重排时**只发清单 + 色值，不发原块 HTML**，也不再发碎裂的字段当前内容。
  2. `collectStyleHints` 去掉 class 名，只给具体色值；修掉颜色正则跨 CSS 规则匹配的噪声。
  3. 提示词改为「没有任何旧块 HTML、从零设计」的语气，数据清单为唯一权威来源，保留柱状图从左到右并排的标准结构说明。
- **验证**：新增 6 项断言（清单三项提取正确、清单无 HTML 标签、风格线索无 class），`npx tsc --noEmit` 无错误，`npm run test:all` 全绿，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 替换清空整页 + 数据清单提错（2026-11-18）

用户反馈：预览里柱子标签是「无数值 / 基线《产品研发域 MCU 本体落地评估》…」等无关长文本；应用后整页只剩三根柱子，其他内容全没了。

- **根因（实测复现）**：「整块重排范围」默认选到了 `div.layout`（整页布局容器，约 25k 字符），而不是 `div.bars`（456 字符、真正的一组柱状条）。原因是默认块选择逻辑用「有相似兄弟就选最外层」，一路推到最外层的整页容器。
  - 从 layout 提数据清单得到的是「基线《…》v实测 1.0 / 2026 / 11 / 05」这种垃圾 —— 造成图一的怪标签。
  - 把 layout 的内部整个换成新柱状图，等于清空整页 —— 造成图二只剩三根柱子。
- **修复**：
  1. 默认块改为「最小的同类兄弟组」：离选中元素最近、含 2~20 个同类子元素的那层，并只在候选更小时更新，不再选最外层。
  2. 加安全闸：所选块超过页面 30% 或大于 12000 字符时直接拒绝，提示「范围太大，会把其他内容清掉，请选更小的块」。
- **验证**：新增 3 项断言（大容器提垃圾数据、小容器提正确清单、小块体积小于大容器）；`npx tsc --noEmit` 无错误，`npm run test:all` 全绿，`npm run tauri build` 成功。
- **安装状态**：未安装；新 DMG 在 `src-tauri/target/release/bundle/dmg/`。

### 图片重复插入根因修复 + Agent 调用卡死修复（2026-11-19）

用户反馈两个问题：① 手工插入图片选一次图、点确认后仍插入两次；② 调用 Agent 修改时界面卡死约 20 分钟，鼠标转圈、无法操作，只能强制退出。

- **问题①根因（本次真正根因，区别于上一轮的「保存后未清记录」）**：`finalizeWith` 把同一批 edits 同时传给 `applyEdits()`（已把 insert 写入源码）和 `injectFreezeScript()`（又为同一 insert 生成 `action:"insert"` 固化操作）；页面加载时 FREEZE_RUNNER 的 `insertAdjacentHTML` 再插一次 → 图片两份。上一轮清空 `modifications` 只解决了「再次 finalize 重放」，没解决单次 finalize 内的双重写入。
- **修复①**：
  1. `htmlPatch.ts`：把 `applyEdits` 核心提取为 `applyEditsCore`，通过每条 edit 处理前后的 op 数量对比追踪它是否真正写入源码；新增 `applyEditsTracked()` 返回 `{html, applied, unapplied}`，原 `applyEdits()` 对外行为完全不变。
  2. `App.tsx` `finalizeWith`：只从固化脚本中剔除「已成功写入源码的插入类 edit」（`insertHtml`/`appendHtml` 且命中 `applied`）；文字/样式/图片/删除以及源码无锚点的动态节点仍保留固化兜底，不破坏「动态渲染页面防 JS 重渲染覆盖」的既有语义。
- **问题②根因**：`agent_edit_file` 是同步 `#[tauri::command]`，内部 `cmd.output()` 阻塞等待 Agent CLI；Agent 客户端慢时（用户实测 20 分钟）占住 Tauri 主线程，UI 完全无响应。
- **修复②**：
  1. `Cargo.toml` 增加 `tokio`（features: process/time/rt-multi-thread/macros）。
  2. `main.rs`：`agent_edit_file` 改为 `async fn`，用 `tokio::process::Command` + `.output().await`，命令在 tokio 线程池执行，UI 主线程立即释放；`.kill_on_drop(true)` + `timeout(600s)` 双保险，超时自动终止子进程并返回可操作错误（备份保留、原文件未动）。前端 `agentBusy` 按钮继续显示「Agent 修改中…」并禁用。
- **验证**：`test_full_e2e.mjs` 新增第 13 节 8 项断言（追踪/过滤/固化不含 insert/端到端 1 张/对照 2 张/动态节点兜底），**55/55 通过**；`npm run test:all` 全绿；`npx tsc --noEmit` 通过；`cargo check` 通过（Rust 异步改造编译验证）。

### CCG hook 劫持导致整页重写 + localhost 弹窗（2026-11-19）

用户反馈：通过 Agent 修改后文件结构被完全破坏——原文件 726 行 / 49847 字节、12 章 + 侧边栏导航，改后变成 306 行 / 23759 字节的全新「信息图」页面（标题、CSS、章节全部重写）；同时弹出无法访问的 `http://localhost:56380/`。

- **根因（两个现象同源）**：用户本机 codex 在 `~/.codex/hooks.json` 注册了 CCG Workflow 的 `UserPromptSubmit` hook（`~/.codex/hooks/ccg-workflow.py`）。编辑器以被编辑文件所在目录为 cwd 启动 codex，而 `/Users/johnny.chen/Downloads/.ccg/tasks/` 下当时有处于 `in_progress/review` 的任务 `convert-mcu-ontology-html-infographic`。hook 每次提交 prompt 都注入 `<ccg-state>`（「HTML 转换为信息图 / Review phase / 调用双模型审查」），覆盖了编辑器「只改局部」的指令 → codex 重写整页；审查阶段 hook 要求调用 `codeagent-wrapper`（`~/.claude/bin/codeagent-wrapper`）启动临时 Web UI（端口 56380）并弹浏览器，任务结束后服务退出 → `ERR_CONNECTION_REFUSED`。
- **修复**：
  1. `main.rs` 任务提示词强化为【局部定点编辑】：明确禁止重写整页、更换主题/标题、删减重排章节，替换图表时只换对应节点，其余内容逐字节保持一致。
  2. `main.rs` 给 codex 子进程注入环境变量 `CODEX_AGENT_TYPE=hve-editor` 与 `CODEX_FORK_TURNS=none`：hook 的 `is_sub_agent()` 命中后改注入 `SUB_AGENT_NOTICE`（「只执行指定任务、忽略 CCG 工作流、不运行外部模型、只改列出的文件」），从源头阻断劫持。该方式不改动用户全局 codex/CCG 配置，不影响其他场景。
- **验证**：实测 hook 在未设环境变量时输出 `<ccg-state>` 工作流指导，设变量后输出 `<ccg-sub-agent-notice>`；`cargo check` 通过。
- **文件恢复**：Downloads 中被改文件已用 backup 覆盖恢复（726 行 / 49847 字节，与 backup 逐字节一致），坏版本另存为 `产品研发域_MCU本体落地可行性评估.html.broken-20261119_141425.html` 供对照。

### 整页重写根因深挖 + 1+3 重构（2026-11-19）

用户追问：为何编辑器调 codex 会重写整页、而直接用 codex 客户端不会。深挖会话日志 `rollout-2026-11-19T13-48-43-*.jsonl` 得到完整证据链。

- **真正根因**：`codex exec` 的 cwd 被设成目标文件所在目录 `~/Downloads`，codex 按 cwd 自动加载了这里的 `.ccg/tasks/convert-mcu-ontology-html-infographic/`（处于 `review` 阶段，需求文件写着「完整改写为单页信息图」），再加上 `ccg-workflow.py` hook 注入的 `<ccg-state>` 和全局 `~/.codex/AGENTS.md` 的 CCG 多模型编排人设，codex 把「生成阶梯图替换选中内容」放大成「完成整个信息图转换项目」，最终用 `cat > 文件.html <<HTML` 整页覆盖。用户客户端的 cwd 不在 `~/Downloads`，不会加载这个具体任务，所以不出问题。
- **1+3 重构**（`main.rs`）：
  1. **隔离 cwd**：每次调用前创建干净的临时工作目录 `hve-agent-work-<pid>-<stamp>` 作为子进程 cwd（`TempWorkDir` guard 退出时自动清理），不再用文件所在目录。已实测干净 cwd 下 `ccg-workflow.py` 不注入任何内容。目标文件始终用绝对路径，与 cwd 无关。
  2. **强化局部约束 prompt**：明确禁止 `cat >`/重定向/整文件覆盖，要求用字符串替换或 apply_patch 只改目标片段；明确声明与 AGENTS.md / .ccg / 项目工作流 / 外部模型审查无关，只做一条要求。
  3. **保留原有防护**：`CODEX_AGENT_TYPE=hve-editor` + `CODEX_FORK_TURNS=none`（hook 走 sub-agent 分支注入「忽略工作流、不调外部模型、只改列出文件」）；异步命令 + 超时 + 文件前后对比验证。
- **真实端到端验证**：用干净 cwd + 完整约束 prompt 让 codex 改测试 HTML 的 `<title>`——行数 544→544 不变，字节 50085→50022（仅 title 差值），codex 自行用 `old.replace(needle,replacement,1)` 精确替换并断言只出现 1 次，章节结构完整保留，未调用外部模型/未建 CCG 任务。
- **回归**：`npm run test:all` EXIT 0；`test_full_e2e.mjs` 55/55；`npx tsc --noEmit` 通过；`cargo check` 通过。

### 选中目标未传给 Agent 导致改错位置（2026-11-19）

用户反馈：程序结束提示「Agent 已直接修改并保存文件」，但盯着的 02 节表格没有任何变化。

- **根因**：磁盘文件其实被改了（49847→51329 字节），但 codex 改的是【第 07 节成熟度总评】的表格，用户选中的是【第 02 节本体要求 vs 现状】。原因在编辑器：`onAgentEdit()` 只把文件路径 + 用户输入的文字（"阅读我选择内容，生成信息图替换现有表格"）传给 codex，**没有把当前选中的节点信息传过去**；"我选择内容"成了无指代的空话，codex 只能自己猜，猜到了 07 节。
- **修复**：把选中节点作为唯一权威目标传给 Agent。
  1. `App.tsx`：`onAgentEdit` 用 `selectedField` 构造 `selectionContext`（元素名称、fieldLabel、DOM 路径 fieldPath/blockPath、原文片段截断 400 字、元素类型），作为第 5 个参数传给 `agentEditFile`。
  2. `tauriApi.ts`：`agentEditFile` 增加 `selection` 参数并透传给后端命令。
  3. `main.rs`：`agent_edit_file` 增加 `selection: Option<String>`，注入 prompt 最前面的【最重要 — 唯一修改目标】块，明确「指令里的我选择内容/当前表格只指它，先按 DOM 路径或原文片段定位这唯一一处，其他章节相似内容一律不动」。
- **真实验证**：用干净临时 cwd + 带选中上下文的 prompt 让 codex 执行同样的「生成信息图替换现有表格」——codex 报告精确改的是 02 节第一张表，该节另一张表与目标区域外均未改动、12 章保留、HTML 可解析（修复前是错改到 07 节）。
- **回归**：`npm run test:all` EXIT 0；`test_full_e2e.mjs` 55/55；`npx tsc --noEmit` 通过；`cargo check` 通过。

### 环境限制与待办

- **桌面 GUI**：本环境无法运行 Tauri 窗口，UI 行为以 `tsc` 编译 + `vite build` + 原型 `docs/GUI界面原型.html`（已按同样 IA 用 jsdom 验证）为等价依据；构建已完成，剩余真机走查（点击字段、三模式切换、设置中心）需在装有 GUI 的桌面进行。
- **真实 Agent 接入**：`call_agent` 目前直接拉起二进制（stdio）；MCP Server / 本机回环 HTTP / CLI 适配器的完整协议层与幂等、单写者锁为 P1 待办。

## 测试场景分布

| 类型 | 用例数 | 说明 |
|------|--------|------|
| 单元测试 | 87 | 函数独立功能验证（resizeImage/原图保留/htmlPatch） |
| 集成测试 | 10 | 图片缩放→插入→灯箱/替换灯箱等完整流程 |
| 边界/异常 | 8 | 极值、降级、错误处理 |
| **合计** | **108** | |

## 失败用例

✅ 无失败

---

> JSON 详情: `scripts/test_report.json`
