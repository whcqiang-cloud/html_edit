// 块级结构重排测试：安全清洗、整块替换、块外字节不变、四层校验、预览渲染。
// 用法：node scripts/test_block_rearrange.mjs
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
globalThis.document = window.document;

async function loadTs(rel) {
  const res = await esbuild.build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true,
    format: "esm",
    write: false,
    platform: "node",
  });
  return import("data:text/javascript;base64," + Buffer.from(res.outputFiles[0].text).toString("base64"));
}

const htmlPatch = await loadTs("../src/lib/htmlPatch.ts");
const core = await loadTs("../src/lib/editCore/index.ts");
const agent = await loadTs("../src/lib/agentEdit.ts");
const cli = await loadTs("../src/lib/adapters/cliAdapter.ts");
const renderer = await loadTs("../src/lib/blockRenderer.ts");
const { getNodePath, applyEdits, buildFreezeOps } = htmlPatch;
const { applyPlan, VersionLock, RollbackStore } = core;
const { extractPlan } = cli;
const { renderSafeBlockHtml, collectStyleHints } = renderer;

let failed = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failed++;
}

// 场景：一排 4 张 KPI 卡片，用户选中第一张的数字，要求重排成四层金字塔
const html = `<!DOCTYPE html><html><head><style>.kpi{color:#333}.v{font-size:20px}</style></head><body><div id="wrap"><section class="kpi-row">
<div class="kpi"><span class="v">114,762</span>总条数</div>
<div class="kpi"><span class="v">142,454</span>应拆目标</div>
<div class="kpi"><span class="v">8</span>CMT域</div>
<div class="kpi"><span class="v">0.247</span>DQ均值</div>
</section><p id="outside">表格在下面，不能动</p></div></body></html>`;
const doc = new JSDOM(html).window.document;
const block = doc.querySelector(".kpi-row");
const blockPath = getNodePath(block);
const field = {
  kind: "text", field: "value", fieldLabel: "总条数",
  fieldPath: getNodePath(doc.querySelector(".v")),
  textNodeIndex: 0, textFrom: "114,762",
  blockPath, blockFromHtml: block.outerHTML,
};

// 意图识别
check("意图：金字塔是结构重排", agent.classifyIntent("将选择内容转换为四层金字塔结构") === "structure");
check("意图：圆形布局仍是样式", agent.classifyIntent("将选择的内容转换为圆形布局") === "style");
// 回归：「图形转纵向柱状图」曾误判为普通文字，模型只能用字符画，页面出现 █▮| 乱码
check("意图：图形转纵向柱状图是结构重排", agent.classifyIntent("将选择的图形转换为纵向柱状图。") === "structure");
check("意图：改成柱状图是结构重排", agent.classifyIntent("改成柱状图") === "structure");
check("意图：转成图表是结构重排", agent.classifyIntent("转成图表") === "structure");

// 安全渲染器：保留展示内容，剔除可执行内容
const dirty = `<div class="kpi" onclick="alert(1)">114,762<script>alert(2)</script><iframe src="x"></iframe><a href="javascript:alert(3)">x</a><span class="v">0.247</span></div>`;
const safe = renderSafeBlockHtml(dirty);
check("安全渲染：保留 normal 标签与文字", safe.includes("<div") && safe.includes("114,762") && safe.includes("0.247"));
check("安全渲染：剔除 class（防止继承原页面冲突样式）", !safe.includes("class="));
check("安全渲染：剔除 script", !safe.includes("<script"));
check("安全渲染：剔除 iframe", !safe.includes("<iframe"));
check("安全渲染：剔除事件属性", !safe.includes("onclick"));
check("安全渲染：剔除 javascript 链接", !safe.includes("javascript:"));

// 回归：AI 用绝对定位画金字塔时，必须剥掉定位，否则新结构会浮在页面上而不是替换原块
const positioned = renderSafeBlockHtml(
  '<div style="position:absolute;top:10px;left:20px;z-index:999;transform:translateX(-50%);width:60%;background:#fff">第一层 114,762</div>'
);
check("安全渲染：剥掉绝对定位与位移", !/position|top:|left:|z-index|transform/.test(positioned));
check("安全渲染：保留内容与非定位样式", positioned.includes("114,762") && positioned.includes("width:60%"));

// 回归：AI 复用原页面 class（bars 带 flex-direction:column）会让柱状图竖排散乱
const reusedClass = renderSafeBlockHtml(
  '<div class="bars" style="display:flex;flex-direction:row;height:200px"><div class="bar" style="width:40px;height:120px;background:#0a7">柱</div></div>'
);
check("安全渲染：复用原页面 class 被剔除（不再竖排散乱）", !reusedClass.includes("class=") && reusedClass.includes("flex-direction:row") && reusedClass.includes("background:#0a7"));

// 风格线索抽取
const hints = collectStyleHints(doc);
check("风格线索：含 CSS 变量或颜色", /#333|font-size/.test(hints));
check("风格线索：不含 class 名（避免诱导复用）", !hints.includes("已有 class") && !hints.includes("kpi-row"));

// 回归：发给模型的必须是干净数据清单，不是原 HTML 样板
{
  const barsHtml = `<div class="bars"><div class="bar-row"><span class="bar-k">产品层</span><div class="bar"><i style="width:42%"></i></div><span class="bar-v">42</span></div><div class="bar-row"><span class="bar-k">基座平台能力层</span><div class="bar"><i style="width:50%"></i></div><span class="bar-v">50</span></div><div class="bar-row"><span class="bar-k">数据层</span><div class="bar"><i style="width:45%"></i></div><span class="bar-v">45</span></div></div>`;
  const bd = new JSDOM(barsHtml).window.document;
  const list = renderer.collectBlockData(bd.body.firstElementChild);
  check("数据清单：提取产品层=42", list.includes("产品层：42"));
  check("数据清单：提取基座平台能力层=50", list.includes("基座平台能力层：50"));
  check("数据清单：提取数据层=45", list.includes("数据层：45"));
  check("数据清单：不含原 HTML 标签", !list.includes("<div") && !list.includes("bar-row"));

// 回归：选到整页容器 div.layout 时数据清单会变垃圾，且替换它会清空整页——
// 证明「默认选最小块 + 大块安全闸」是必要的
{
  const layoutHtml = `<div class="layout"><div class="card"><div class="bars">
    <div class="bar-row"><span>产品层</span><span>42</span></div>
    <div class="bar-row"><span>基座平台能力层</span><span>50</span></div>
    <div class="bar-row"><span>数据层</span><span>45</span></div>
  </div></div><section><p>基线《产品研发域 MCU 本体落地可行性评估》v实测 1.0 / 2026 / 11 / 05</p><p>这是整页里不该被替换的其它内容，占了大容器绝大部分体积，随便写长一点让大容器明显更大。必须同时成立的四个判断、应用证据与实物状态、落地任务总表等等都在这里，全都不该被这次重排动到。</p></section></div>`;
  const ld = new JSDOM(layoutHtml).window.document;
  const layout = ld.querySelector(".layout");
  const bars = ld.querySelector(".bars");
  const bigList = renderer.collectBlockData(layout);
  const smallList = renderer.collectBlockData(bars);
  check("块选择：大容器提取的是无关长文本", bigList.includes("基线") && !bigList.includes("产品层：42"));
  check("块选择：小容器提取的是正确数据清单", smallList.includes("产品层：42") && smallList.includes("数据层：45"));
  check("块选择：小块体积小于大容器（默认应选小块）", bars.outerHTML.length < layout.outerHTML.length);
}
}

// AI 产出 blockHtml → extractPlan 清洗并指向整块
const rawOutput = JSON.stringify({
  blockHtml: `<section class="kpi-row"><div class="level">第一层 114,762</div><div class="level">第二层 142,454</div><div class="level">第三层 8</div><div class="level">第四层 0.247</div><script>bad()</script></section>`,
});
const plan = extractPlan(rawOutput, field);
const edit = plan.edits[0];
check("计划：blockHtml 指向整块", edit.path === blockPath && typeof edit.blockHtml === "string");
check("计划：危险内容被清洗", !edit.blockHtml.includes("<script"));
check("计划：保留四层数据", ["114,762", "142,454", "8", "0.247"].every((s) => edit.blockHtml.includes(s)));

// 整块替换：块外字节不变，块内结构变成四层
const applied = applyEdits(html, [edit]);
check("替换：块外文字原样", applied.includes("表格在下面，不能动"));
check("替换：块外 open 标签原样", applied.includes('<div id="wrap">'));
check("替换：外层 section 保留", applied.includes('<section class="kpi-row">'));
check("替换：块内出现四层", (applied.match(/第一层|第二层|第三层|第四层/g) || []).length === 4);
check("替换：旧的单排 class 已不在块内", !applied.includes('<div class="kpi">'));

// 四层校验：块级重排合法通过（结构指纹不适用）
const result = applyPlan(plan, html, { versions: new VersionLock(), rollbacks: new RollbackStore() });
check("四层：块级重排校验通过", result.report.pass === true);
check("四层：状态 applied", result.status === "applied");
check("四层：回滚句柄生成", typeof result.rollbackHandle === "string");

// 固化脚本：块级操作可重放
const ops = buildFreezeOps([edit]);
check("固化：block 操作已生成", ops.length === 1 && ops[0].action === "block");
check("固化：包含新结构", ops[0].html.includes("第一层"));

// 回归：页面 JS 渲染让 iframe 里的块 HTML 与源码不一致，仍必须真正替换（不能静默跳过）
const jsRenderedFrom = '<section class="kpi-row"><div class="kpi"><span class="v">JS 渲染后的数字</span></div></section>';
const dynamicEdit = { ...edit, blockFrom: jsRenderedFrom };
const appliedDyn = applyEdits(html, [dynamicEdit]);
check("JS 渲染差异：仍真正替换（不再静默跳过）", appliedDyn.includes("第一层 114,762") && !appliedDyn.includes('<div class="kpi">'));
check("JS 渲染差异：块外字节不变", appliedDyn.includes("表格在下面，不能动"));

console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项失败"));
process.exitCode = failed === 0 ? 0 : 1;
