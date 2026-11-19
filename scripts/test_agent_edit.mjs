// 让 Agent 修改 流程测试：单字段、意图分类（明确/含糊/多件事/样式）、四层校验拦截、CLI 适配器抽取。
// 用法：node scripts/test_agent_edit.mjs
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

const core = await loadTs("../src/lib/editCore/index.ts");
const agent = await loadTs("../src/lib/agentEdit.ts");
const cli = await loadTs("../src/lib/adapters/cliAdapter.ts");
const { runAgentEdit, classifyIntent, LocalPlanGenerator } = agent;
const { CliPlanGenerator, extractPlan } = cli;

let failed = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failed++;
}

const html = `<!DOCTYPE html><html><body><div class="kpi"><span class="v" data-k="1">分类规模</span><b>101</b></div></body></html>`;
const doc = new JSDOM(html).window.document;
const label = doc.querySelector(".v");
const { getNodePath } = await loadTs("../src/lib/htmlPatch.ts");
const lp = getNodePath(label);
const field = {
  kind: "text",
  field: "label",
  fieldLabel: "分类规模",
  fieldPath: lp,
  textNodeIndex: 0,
  textFrom: "分类规模",
};

// 意图分类
check("意图：明确指令", classifyIntent("把分类规模改成分类数量") === "explicit");
check("意图：含糊描述", classifyIntent("这个数字调高一点") === "ambiguous");
check("意图：一句话多件事", classifyIntent("把标题改成X，同时把数值改成Y") === "multi");
check("意图：样式布局被识别", classifyIntent("将选择的内容转换为圆形布局") === "style");

// 单字段明确指令 → 应用
const gen = new LocalPlanGenerator(async () => ({ textTo: "分类数量" }));
const r1 = await runAgentEdit("把分类规模改成分类数量", field, gen, html);
check("单字段：状态 applied", r1.status === "applied");
check("单字段：文本已改", r1.result?.html.includes("分类数量"));
check("单字段：四层通过", r1.dryRun?.report.pass === true);

// 含糊 → 拒绝（不自动猜）
const r2 = await runAgentEdit("调高一点", field, gen, html);
check("含糊：拒绝并给出原因", r2.status === "rejected" && /补充目标值/.test(r2.reason || ""));

// 多件事 → 拒绝（不拆子任务）
const r3 = await runAgentEdit("改成A，同时改成B", field, gen, html);
check("多件事：拒绝并给出原因", r3.status === "rejected" && /分多次操作/.test(r3.reason || ""));

// 样式/布局 → 生成 stylePatches 并应用（精准改开标签，不碰文字）
const styleGen = {
  generate: async (desc, f) => ({
    intent: desc,
    intentType: "style",
    fieldTarget: f,
    edits: [{ path: f.fieldPath, stylePatches: [{ prop: "border-radius", value: "50%" }] }],
    assertions: [{ fieldPath: f.fieldPath }],
  }),
};
const rStyle = await runAgentEdit("将选择的内容转换为圆形布局", field, styleGen, html);
check("样式布局：生成 stylePatches 计划", rStyle.plan?.edits[0]?.stylePatches?.[0]?.value === "50%");
check("样式布局：四层通过并应用", rStyle.status === "applied" && rStyle.dryRun?.report.pass === true);
check("样式布局：CSS 写入开标签", /border-radius:\s*50%/.test(rStyle.result?.html || ""));
check("样式布局：原文字未被替换", rStyle.result?.html.includes("分类规模"));

// 计划生成器越出字段 → 拒绝
const badGen = {
  generate: async () => ({
    intent: "x",
    fieldTarget: { ...field, fieldPath: "html > body:nth-of-type(1) > div:nth-of-type(9)" },
    edits: [{ path: "html > body:nth-of-type(1) > div:nth-of-type(9)", textFrom: "x", textTo: "y", textNodeIndex: 0 }],
    assertions: [{ fieldPath: "html > body:nth-of-type(1) > div:nth-of-type(9)" }],
  }),
};
const r4 = await runAgentEdit("越界", field, badGen, html);
check("越界计划：拒绝", r4.status === "rejected");

// CLI 适配器：抽取计划块（fake executor）
const fakeExecutor = async () => "思考中...\n```json\n{\"textTo\":\"新名字\"}\n```\n完成";
const cliGen = new CliPlanGenerator(
  { command: "codex", args: ["<instruction>"], template: "codex <instruction>" },
  fakeExecutor
);
const cliPlan = await cliGen.generate("重命名", field);
check("CLI 抽取：textTo 正确", cliPlan.edits[0].textTo === "新名字");
check("CLI 抽取：字段路径一致", cliPlan.edits[0].path === lp);

// 直接测试 extractPlan：从散落文本里找 JSON
const extracted = extractPlan('噪音 {"textTo":"Z"} 噪音', field);
check("extractPlan：从散落文本解析", extracted.edits[0].textTo === "Z");

// 模型输出样式/属性补丁：extractPlan 正确抽取
const stylePlan = extractPlan('{"stylePatches":[{"prop":"border-radius","value":"50%"},{"prop":"background","value":"red"}]}', field);
check("extractPlan：解析 stylePatches", stylePlan.edits[0].stylePatches?.length === 2 && stylePlan.edits[0].stylePatches[0].prop === "border-radius");
const attrPlan = extractPlan('{"attrPatches":[{"name":"class","value":"v round"}]}', field);
check("extractPlan：解析 attrPatches", attrPlan.edits[0].attrPatches?.[0]?.name === "class");
let badStyleRejected = false;
try { extractPlan('{"stylePatches":[{"prop":"color","value":"<script>"}]}', field); } catch { badStyleRejected = true; }
check("extractPlan：拒绝含 HTML 的样式值", badStyleRejected);

// 加固：模型返回 HTML 标签 / 越界 HTML 操作一律拒绝
let htmlRejected = false;
try { extractPlan('{"textTo":"<div style=...>114,762</div>"}', field); } catch { htmlRejected = true; }
check("extractPlan：拒绝含 HTML 标签的 textTo", htmlRejected);
let outerRejected = false;
try { extractPlan('{"edits":[{"path":"' + lp + '","outerHtml":"<div>x</div>"}]}', field); } catch { outerRejected = true; }
check("extractPlan：拒绝越界 outerHtml", outerRejected);
let errRejected = false;
try { extractPlan('{"error":"样式和布局改动请使用源码模式"}', field); } catch { errRejected = true; }
check("extractPlan：拒绝模型的 error 响应", errRejected);

console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项失败"));
process.exitCode = failed === 0 ? 0 : 1;
