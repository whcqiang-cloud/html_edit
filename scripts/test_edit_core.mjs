// edit-core 测试：attrPatch / stylePatch 字节保真、四层校验、applyPlan 硬失败拒绝与软失败降级固化。
// 用法：node scripts/test_edit_core.mjs
import { JSDOM } from "jsdom";
import esbuild from "esbuild";
import { readFileSync } from "fs";
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
  const code = res.outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const htmlPatch = await loadTs("../src/lib/htmlPatch.ts");
const core = await loadTs("../src/lib/editCore/index.ts");
const { applyEdits, getNodePath, attrPatch, stylePatch } = htmlPatch;
const { applyPlan, validatePlan, dryRun, VersionLock, RollbackStore } = core;

let failed = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failed++;
}

const html = `<!DOCTYPE html><html><body><div class="card" id="c" style="color:red;font-size:12px">hello</div></body></html>`;
const doc = new JSDOM(html).window.document;
const div = doc.querySelector("#c");
const divPath = getNodePath(div);

// ---- attrPatch：只改开标签，字节级保真 ----
const outAttr = applyEdits(html, [attrPatch(divPath, [{ name: "class", value: "panel" }])]);
check("attrPatch：class 已更新", outAttr.includes('class="panel"'));
check("attrPatch：id 原样保留", outAttr.includes('id="c"'));
check("attrPatch：style 原样保留", outAttr.includes('style="color:red;font-size:12px"'));
check("attrPatch：文本原样保留", outAttr.includes("hello"));
check("attrPatch：元素前字节不变", outAttr.startsWith(html.slice(0, html.indexOf("<div"))));

// ---- stylePatch：只改一个样式属性 ----
const outStyle = applyEdits(html, [stylePatch(divPath, [{ prop: "color", value: "blue" }])]);
check("stylePatch：color 已更新", outStyle.includes('style="color:blue;font-size:12px"'));
check("stylePatch：其余样式保留", outStyle.includes("font-size:12px"));
check("stylePatch：class/id 保留", outStyle.includes('class="card"') && outStyle.includes('id="c"'));

// ---- 删除样式属性 ----
const outStyleDel = applyEdits(html, [stylePatch(divPath, [{ prop: "color", value: null }])]);
check("stylePatch：删除后只剩 font-size", outStyleDel.includes('style="font-size:12px"'));

// ---- 多个样式属性固化时不能互相覆盖 ----
const { buildFreezeOps } = htmlPatch;
const multiStyleOps = buildFreezeOps([stylePatch(divPath, [
  { prop: "border-radius", value: "50%" },
  { prop: "background", value: "red" },
])]);
check("固化脚本：多个样式属性各自保留", multiStyleOps.length === 2 && multiStyleOps[0].prop === "border-radius" && multiStyleOps[1].prop === "background");

// ---- applyPlan 单字段文字改动：四层通过 ----
const field = {
  kind: "text",
  field: "value",
  fieldLabel: "数值",
  fieldPath: divPath,
  textNodeIndex: 0,
  textFrom: "hello",
  blockPath: divPath,
};
const plan = {
  intent: "改成 hi",
  fieldTarget: field,
  edits: [{ path: divPath, textFrom: "hello", textTo: "hi", textNodeIndex: 0 }],
  assertions: [{ fieldPath: divPath }],
};
const rb = new RollbackStore();
const vl = new VersionLock();
const res = applyPlan(plan, html, { rollbacks: rb, versions: vl });
check("applyPlan：状态 applied", res.status === "applied");
check("applyPlan：目标文本已改", res.html.includes("hi"));
check("applyPlan：四层校验 pass", res.report.pass && res.report.layer4.ok);
check("applyPlan：版本号已递增", res.version === 1);
check("applyPlan：回滚句柄已生成", typeof res.rollbackHandle === "string");

// ---- 非目标区域漂移：第四层软失败 → 降级 frozen ----
const orig2 = `<!DOCTYPE html><html><body><div id="a">A</div><p id="b">B</p></body></html>`;
const aPath = getNodePath(new JSDOM(orig2).window.document.querySelector("#a"));
const driftApplied = orig2.replace(">B<", ">C<"); // 改了非目标的 p
const report = validatePlan(
  { intent: "x", fieldTarget: { ...field, fieldPath: aPath }, edits: [{ path: aPath, textFrom: "A", textTo: "A" }], assertions: [{ fieldPath: aPath }] },
  orig2,
  driftApplied
);
check("第四层：非目标漂移被检出（软失败）", report.layer4.ok === false);
check("第二层：非目标区间字节变化被硬层拦截", report.layer2.ok === false);
check("第四层：pass=false（需降级）", report.pass === false);

// ---- 漂移守卫：outerFrom 不匹配时 applyEdits 跳过，不破坏格式 ----
const wrongFrom = applyEdits(html, [
  { path: divPath, outerHtml: '<div class="card">x</div>', outerFrom: "<div>完全不同的东西</div>" },
]);
check("漂移守卫：outerFrom 不符整条跳过", wrongFrom === html);

// ---- 动态渲染节点：源码中无对应节点，走固化脚本重放，不硬失败 ----
const dynPlan = {
  intent: "把动态数字改成新值",
  fieldTarget: { kind: "dynamic", field: "value", fieldLabel: "数字", fieldPath: "html > body:nth-of-type(1) > div:nth-of-type(9) > strong:nth-of-type(1)", textFrom: "1,052", dynamicNode: true },
  edits: [{ path: "html > body:nth-of-type(1) > div:nth-of-type(9) > strong:nth-of-type(1)", textFrom: "1,052", textTo: "1,045", textNodeIndex: 0, dynamicNode: true }],
  assertions: [{ fieldPath: "html > body:nth-of-type(1) > div:nth-of-type(9) > strong:nth-of-type(1)" }],
};
const dynRes = applyPlan(dynPlan, html, { versions: new VersionLock(), rollbacks: new RollbackStore() });
check("动态节点：applyPlan 不再硬失败", dynRes.status !== "failed");
check("动态节点：状态为 frozen（固化重放）", dynRes.status === "frozen");
check("动态节点：注入了固化脚本", dynRes.html.includes("__hve_freeze_ops__") && dynRes.html.includes('"action":"text"'));
check("动态节点：固化操作含目标文本", dynRes.html.includes("1,045"));
check("动态节点：四层报告通过", dynRes.report.pass === true);

// ---- 删除 / 清空字段：文本叶子减少应被声明的删除解释，不判结构漂移 ----
const delPath = getNodePath(doc.querySelector(".card"));
const delPlan = {
  intent: "删除选择的内容",
  fieldTarget: { kind: "text", field: "value", fieldLabel: "文本", fieldPath: delPath, textFrom: "hello", dynamicNode: false },
  edits: [{ path: delPath, textFrom: "hello", textTo: "", textNodeIndex: 0, dynamicNode: false }],
  assertions: [{ fieldPath: delPath }],
};
const delRes = applyPlan(delPlan, html, { versions: new VersionLock(), rollbacks: new RollbackStore() });
check("删除字段：四层校验通过", delRes.report.pass === true);
check("删除字段：状态 applied", delRes.status === "applied");
check("删除字段：目标文本被清空", /<div class="card" id="c"[^>]*><\/div>/.test(delRes.html));

// ---- 第一层硬校验：文字改动夹带 HTML 标签必须拒绝 ----
const htmlPath = getNodePath(doc.querySelector(".card"));
const badHtmlPlan = {
  intent: "转换为圆形布局",
  fieldTarget: { kind: "text", field: "value", fieldLabel: "文本", fieldPath: htmlPath, textFrom: "hello" },
  edits: [{ path: htmlPath, textFrom: "hello", textTo: '<div style="border-radius:50%">hello</div>', textNodeIndex: 0 }],
  assertions: [{ fieldPath: htmlPath }],
};
const badHtmlRes = applyPlan(badHtmlPlan, html, { versions: new VersionLock(), rollbacks: new RollbackStore() });
check("HTML 标签：layer1 硬失败", badHtmlRes.report.layer1.ok === false);
check("HTML 标签：整条计划被拒绝", badHtmlRes.status === "failed");
check("HTML 标签：源码未被污染", badHtmlRes.html === html && !badHtmlRes.html.includes("border-radius"));

console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项失败"));
process.exitCode = failed === 0 ? 0 : 1;
