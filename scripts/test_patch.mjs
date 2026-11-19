// 离线测试：验证 applyEdits 源码级精准回填的字节级保真
// 用法：node scripts/test_patch.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import esbuild from "esbuild";

const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
globalThis.document = window.document;

// 用 esbuild 即时转译 TS 模块
const src = readFileSync(new URL("../src/lib/htmlPatch.ts", import.meta.url), "utf8");
const out = await esbuild.transform(src, { loader: "ts", format: "esm" });
const {
  applyEdits,
  findNodeRange,
  getNodePath,
  serializeIframeHtml,
  injectFreezeScript,
  buildFreezeOps,
  stripEditorArtifactsFromSource,
} = await import(
  "data:text/javascript;base64," + Buffer.from(out.code).toString("base64")
);

// 目标文件：LeMUR 运营监控视角（含大量内嵌 JSON / JS，验证静态节点的源码级 patch）
const html = readFileSync(
  new URL("../运营监控视角_备份_202ddd60915_094504.html", import.meta.url),
  "utf8"
);

function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) process.exitCode = 1;
}

const dom = new JSDOM(html);
const doc = dom.window.document;

// ---- 测试1：改文字（topbar .name）----
const nameEl = doc.querySelector(".topbar .name");
const namePath = getNodePath(nameEl);
const range1 = findNodeRange(html, namePath);
check("定位 .topbar .name 成功", range1 !== null);
console.log("名称原始片段:", html.slice(range1.start, range1.end).slice(0, 60));

const out1 = applyEdits(html, [
  { path: namePath, outerHtml: '<div class="name">这是被测试改掉的名称文字</div>' },
]);

// 字节级：目标节点之前和之后的源码应完全不变
const beforeOrig = html.slice(0, range1.start);
const afterOrig = html.slice(range1.end);
check("改文字：前面字节完全保留", out1.startsWith(beforeOrig));
check("改文字：后面字节完全保留", out1.endsWith(afterOrig));
const out1Doc = new JSDOM(out1).window.document;
check("改文字：目标节点文字已更新", out1Doc.querySelector(".topbar .name").textContent === "这是被测试改掉的名称文字");
check("改文字：ver 节点未变", out1Doc.querySelector(".topbar .ver").textContent === doc.querySelector(".topbar .ver").textContent);

// ---- 测试2：删除区块（topbar）----
const topbar = doc.querySelector(".topbar");
const topbarPath = getNodePath(topbar);
const rangeTopbar = findNodeRange(html, topbarPath);
check("定位 .topbar 成功", rangeTopbar !== null);
const out2 = applyEdits(html, [{ path: topbarPath, remove: true }]);
check("删除：前面字节保留", out2.startsWith(html.slice(0, rangeTopbar.start)));
check("删除：后面字节保留", out2.endsWith(html.slice(rangeTopbar.end)));
check("删除：topbar 不在结果中", !out2.includes('class="topbar"'));
check("删除：topbar 之后源码字节保留", out2.endsWith(html.slice(rangeTopbar.end)));

// ---- 测试3：改图片（若文件有 img）----
const img = doc.querySelector("img");
if (img) {
  const imgPath = getNodePath(img);
  const rangeImg = findNodeRange(html, imgPath);
  const newImg = img.outerHTML.replace(/src="[^"]*"/, 'src="https://example.com/new.png"');
  const out3 = applyEdits(html, [{ path: imgPath, outerHtml: newImg }]);
  check("改图片：前面字节保留", out3.startsWith(html.slice(0, rangeImg.start)));
  check("改图片：后面字节保留", out3.endsWith(html.slice(rangeImg.end)));
  check("改图片：src 更新", out3.includes('src="https://example.com/new.png"'));
} else {
  console.log("SKIP 改图片（文件无 img）");
}

// ---- 测试4：多条组合（同层两个节点）----
const verEl = doc.querySelector(".topbar .ver");
const verPath = getNodePath(verEl);
const out4 = applyEdits(html, [
  { path: namePath, outerHtml: '<div class="name">组合测试名称</div>' },
  { path: verPath, outerHtml: '<span class="ver">v9.9</span>' },
]);
check("组合：不崩溃且为字符串", typeof out4 === "string" && out4.length > 0);
const out4Doc = new JSDOM(out4).window.document;
check("组合：名称已改", out4Doc.querySelector(".topbar .name").textContent === "组合测试名称");
check("组合：版本号已改", out4Doc.querySelector(".topbar .ver").textContent === "v9.9");

// ---- 测试5：重复同标签（验证 nth-of-type 正确性）----
const topbarDivs = doc.querySelectorAll(".topbar > div");
if (topbarDivs.length >= 2) {
  const s2 = topbarDivs[1];
  const s2Path = getNodePath(s2);
  const rangeS2 = findNodeRange(html, s2Path);
  check("定位第2个 div 成功", rangeS2 !== null);
  if (rangeS2) {
    const out5 = applyEdits(html, [
      { path: s2Path, outerHtml: '<div class="name">第二个 div 被替换</div>' },
    ]);
    check("重复标签：前面字节保留", out5.startsWith(html.slice(0, rangeS2.start)));
    check("重复标签：后面字节保留", out5.endsWith(html.slice(rangeS2.end)));
    // 第一个 div 不应被改
    const firstDivFragment = topbarDivs[0].outerHTML;
    check("重复标签：第1个 div 未变", out5.includes(firstDivFragment));
  }
}

// ---- 测试6：DOM 序列化保存路径必须应用编辑记录 ----
// 该文件 <script> 占比 > 60%，保存走 serializeIframeHtml；此前 edits 被忽略导致保存无变化
const fakeBar = doc.createElement("div");
fakeBar.className = "hve-bar";
fakeBar.textContent = "编辑器工具条";
doc.body.appendChild(fakeBar);

const domOut = serializeIframeHtml(doc, [
  { path: namePath, outerHtml: '<div class="name">DOM 序列化路径修改生效</div>' },
  { path: verPath, insertHtml: '<span class="hve-test-insert">插入生效</span>', insertPosition: "after" },
]);
check("DOM 序列化：文字修改已写入", domOut.includes('<div class="name">DOM 序列化路径修改生效</div>'));
check("DOM 序列化：插入已写入", domOut.includes('<span class="hve-test-insert">插入生效</span>'));
check("DOM 序列化：编辑器工具条未写入", !domOut.includes('class="hve-bar"'));
check("DOM 序列化：原有内容仍在", domOut.includes("lemur-db-snapshot"));
const domOutDoc = new JSDOM(domOut).window.document;
check("DOM 序列化：结果可解析且目标文字正确", domOutDoc.querySelector(".topbar .name")?.textContent === "DOM 序列化路径修改生效");

const domDeleteOut = serializeIframeHtml(doc, [{ path: topbarPath, remove: true }]);
check("DOM 序列化：删除已写入", !domDeleteOut.includes('class="topbar"'));
fakeBar.remove();

// ---- 测试7：动态渲染页的「修改固化」----
// 页面脚本会重绘 tbody，固化脚本须在重绘后把用户改动还原
const dynamicHtml = `<!DOCTYPE html><html><body><table><tbody id="t"><tr><td><span class="badge">84.4%</span></td></tr></tbody></table><script>document.getElementById("t").innerHTML = '<tr><td><span class="badge">0.0%</span></td></tr>';</script></body></html>`;
const baseDoc = new JSDOM(dynamicHtml, { runScripts: "dangerously" }).window.document;
const badgePath = getNodePath(baseDoc.querySelector(".badge"));
const frozen = injectFreezeScript(dynamicHtml, [
  { path: badgePath, outerHtml: '<span class="badge">99.9%</span>' },
]);
check("固化：写入 ops 节点", frozen.includes('id="__hve_freeze_ops__"'));
check("固化：写入执行脚本", frozen.includes('id="__hve_freeze_script__"'));
const opsNode = new JSDOM(frozen).window.document.getElementById("__hve_freeze_ops__");
const ops = JSON.parse(opsNode.textContent);
check("固化：操作内容与选择器正确", ops.length === 1 && ops[0].html.includes("99.9%") && ops[0].selector.includes("tbody:nth-of-type(1)"));

const merged = injectFreezeScript(frozen, [
  { path: badgePath, outerHtml: '<span class="badge">77.7%</span>' },
]);
const mergedOps = JSON.parse(new JSDOM(merged).window.document.getElementById("__hve_freeze_ops__").textContent);
check("固化：二次保存合并且不重复脚本", mergedOps.length === 1 && mergedOps[0].html.includes("77.7%") && (merged.match(/__hve_freeze_script__/g) || []).length === 1);

// 实际执行：渲染脚本先改成 0.0%，固化脚本应还原为 77.7%
const live = new JSDOM(merged, { runScripts: "dangerously" });
await new Promise((r) => setTimeout(r, 50));
check("固化：页面重绘后用户修改仍生效", live.window.document.querySelector(".badge")?.textContent === "77.7%");

// ---- 测试8：P1 源码级文本节点替换（只改文字，标签/属性/空白零损耗）----
const srcHtml = `<!DOCTYPE html>
<html><body>
  <div   class = 'card'  id="c">
    <span class="v" data-k='1'>84.4%</span><b>元</b>
  </div>
</body></html>`;
const srcDoc = new JSDOM(srcHtml).window.document;
const vPath = getNodePath(srcDoc.querySelector(".v"));
const textEdit = {
  path: vPath,
  textFrom: "84.4%",
  textTo: "99.9%",
  textNodeIndex: 0,
  outerHtml: '<span class="v">99.9%</span>',
};
const out8 = applyEdits(srcHtml, [textEdit]);
check("文本级：源码只替换那一段文本", out8 === srcHtml.replace("84.4%", "99.9%"));
check(
  "文本级：属性与空白原样保留（未回退 outerHTML）",
  out8.includes(`<span class="v" data-k='1'>99.9%</span>`)
);
const mismatch = applyEdits(srcHtml, [{ ...textEdit, textFrom: "不存在的原文" }]);
check("文本级：原文不匹配时整条跳过，不破坏格式", mismatch === srcHtml);

// ---- 测试9：HTML 实体解码对齐 + 写回转义 ----
const entHtml = `<!DOCTYPE html><html><body><div id="a">A &amp; B &lt;x&gt;</div></body></html>`;
const entPath = getNodePath(new JSDOM(entHtml).window.document.querySelector("#a"));
const outEnt = applyEdits(entHtml, [
  { path: entPath, textFrom: "A & B <x>", textTo: "X & Y", textNodeIndex: 0 },
]);
check("文本级：实体解码对齐并转义写回", outEnt.includes('<div id="a">X &amp; Y</div>'));

// ---- 测试10：P1 字符串级清理不触发 DOM 序列化 ----
const malformed = `<!DOCTYPE html><html><body><table><tbody id="t"><tr><td>底盘</td>9,90344<td>2</td></tr></tbody></table><style id="__hve_style__">[data-hve-hover]{outline:1px}</style><div id="__hve_bridge__"></div><div class="hve-bar"><div>菜单</div><button>编辑</button></div></body></html>`;
const cleaned = stripEditorArtifactsFromSource(malformed);
check(
  "清理 P1：工具条 / style / bridge 已移除",
  !cleaned.includes("hve-bar") && !cleaned.includes("__hve_style__") && !cleaned.includes("__hve_bridge__")
);
check(
  "清理 P1：畸形表格的游离文本按原字节保留",
  cleaned.includes("<td>底盘</td>9,90344<td>2</td>")
);

// ---- 测试11：P2 文本级固化重放不破坏结构 ----
const dyn2 = `<!DOCTYPE html><html><body><table><tbody id="t"><tr><td><span class="badge" data-k="1">84.4%</span><b>元</b></td></tr></tbody></table><script>document.getElementById("t").innerHTML = '<tr><td><span class="badge" data-k="1">0.0%</span><b>元</b></td></tr>';</script></body></html>`;
const dyn2Doc = new JSDOM(dyn2).window.document;
const badge2Path = getNodePath(dyn2Doc.querySelector(".badge"));
const froz2 = injectFreezeScript(dyn2, [
  {
    path: badge2Path,
    textFrom: "84.4%",
    textTo: "99.9%",
    textNodeIndex: 0,
    outerHtml: '<span class="badge">99.9%</span>',
  },
]);
const ops2 = JSON.parse(
  new JSDOM(froz2).window.document.getElementById("__hve_freeze_ops__").textContent
);
check(
  "固化 P2：文字编辑生成 text 操作",
  ops2.length === 1 && ops2[0].action === "text" && ops2[0].textTo === "99.9%"
);
check("固化 P2：不携带 outerHTML", ops2[0].html === undefined);
const live2 = new JSDOM(froz2, { runScripts: "dangerously" });
await new Promise((r) => setTimeout(r, 150));
const liveBadge = live2.window.document.querySelector(".badge");
check("固化 P2：页面重绘后文字仍生效", liveBadge?.textContent === "99.9%");
check(
  "固化 P2：元素属性与兄弟节点保留（未整体替换）",
  liveBadge?.getAttribute("data-k") === "1" &&
    liveBadge.parentElement.querySelector("b")?.textContent === "元"
);

// ---- 测试12：P2 结构性元素保护 ----
const td2Path = getNodePath(dyn2Doc.querySelector("td"));
check(
  "固化 P2：结构性元素不做 outerHTML 重放",
  buildFreezeOps([{ path: td2Path, outerHtml: "<td>整格替换</td>" }]).length === 0
);
check(
  "固化 P2：表格内的 before/after 插入改为内部末尾",
  buildFreezeOps([
    { path: td2Path, insertHtml: "<p>插入</p>", insertPosition: "before" },
  ])[0]?.position === "beforeend"
);
const tblHtml = `<!DOCTYPE html><html><body><table><tbody><tr><td>底盘</td></tr></tbody></table></body></html>`;
const tdSimplePath = getNodePath(new JSDOM(tblHtml).window.document.querySelector("td"));
const outTbl = applyEdits(tblHtml, [
  { path: tdSimplePath, insertHtml: "<p>插入</p>", insertPosition: "before" },
]);
check(
  "表格插入：内容留在单元格内，不会被 foster parenting 搬到表格外",
  new JSDOM(outTbl).window.document.querySelector("td p")?.textContent === "插入"
);

// ---- 测试：整段文字替换（元素被 <b> 分成多个文本节点，人工编辑只加几个字不能错位重复）----
{
  const seg = `<!DOCTYPE html><html><body><p id="sum">26 个统计维度，<b>三层分析漏斗</b>，逻辑上无可指摘。但落到数据上，只有 4 个维度能用现有数据算出来。</p></body></html>`;
  const d = new JSDOM(seg).window.document;
  const pPath = getNodePath(d.getElementById("sum"));
  const from = d.getElementById("sum").textContent;
  const to = from + " FFFF";
  const outSeg = applyEdits(seg, [{ path: pPath, innerText: to, innerFrom: from }]);
  const newP = new JSDOM(outSeg).window.document.getElementById("sum");
  check("整段替换：新文字完整且只出现一次", newP.textContent === to && (newP.textContent.match(/FFFF/g) || []).length === 1);
  check("整段替换：原文没有被重复拼接", !newP.textContent.includes("无可指摘。但落到数据上，只有 4 个维度能用现有数据算出来。26 个统计维度"));
  check("整段替换：块外字节不变", outSeg.startsWith(seg.slice(0, seg.indexOf("<p id=\"sum\""))) && outSeg.endsWith("</p></body></html>"));
  // 固化重放也要整段替换，不能再塞进第一个文本节点
  const segOps = buildFreezeOps([{ path: pPath, innerText: to, innerFrom: from }]);
  check("整段替换：固化操作是 innertext", segOps.length === 1 && segOps[0].action === "innertext" && segOps[0].innerText === to);
}

// ---- 测试13：真实文件端到端（源码级文字编辑零格式损耗）----
const e2eOut = applyEdits(html, [
  { path: namePath, textFrom: nameEl.textContent, textTo: "运营监控（测试改名）", textNodeIndex: 0 },
]);
check("真实文件：源码确实发生了修改", e2eOut !== html);
check("真实文件：目标节点之前字节完全不变", e2eOut.startsWith(html.slice(0, range1.start)));
check("真实文件：目标节点之后字节完全不变", e2eOut.endsWith(html.slice(range1.end)));
check(
  "真实文件：目标文字已写入",
  new JSDOM(e2eOut).window.document.querySelector(".topbar .name")?.textContent === "运营监控（测试改名）"
);
check("真实文件：内嵌 JSON 数据未损坏", e2eOut.includes("lemur-db-snapshot"));

// ---- 测试14：outerFrom 校验防止源码定位漂移误改 ----
const driftOut = applyEdits(srcHtml, [
  {
    path: vPath,
    outerHtml: '<span class="v">替换文字</span>',
    outerFrom: '<span class="v">完全不同的文字</span>',
  },
]);
check("漂移防护：outerFrom 不匹配时整条跳过", driftOut === srcHtml);
const okOut = applyEdits(srcHtml, [
  {
    path: vPath,
    outerHtml: '<span class="v">替换文字</span>',
    outerFrom: `<span class="v" data-k='1'>84.4%</span>`,
  },
]);
check("漂移防护：outerFrom 匹配时正常替换", okOut.includes("替换文字"));

// ---- 测试15：旧版破坏性固化脚本的迁移 ----
const legacy = `<!DOCTYPE html><html><body><table><tbody><tr><td>A</td></tr></tbody></table><script id="__hve_freeze_ops__" type="application/json">[{"selector":"body > table","action":"replace","html":"<body>bad</body>"}]</script><script id="__hve_freeze_script__">(function(){})();</script></body></html>`;
const healed = stripEditorArtifactsFromSource(legacy);
check(
  "旧版固化：打开时移除破坏性 ops 与 runner",
  !healed.includes("__hve_freeze_ops__") && !healed.includes("__hve_freeze_script__")
);
const cleanPage = `<!DOCTYPE html><html><body><span id="a">x</span></body></html>`;
const aPath = getNodePath(new JSDOM(cleanPage).window.document.querySelector("#a"));
const textOp = { path: aPath, textFrom: "x", textTo: "y", textNodeIndex: 0 };
const newFmt = injectFreezeScript(cleanPage, [textOp]);
check(
  "新版固化：打开时保留带 tag 的操作清单",
  stripEditorArtifactsFromSource(newFmt).includes("__hve_freeze_ops__")
);
// 回归：旧版把 HTML 当文本写进页面，<table> 前留下游离数字+<b>，打开时要自愈
const corrupted = `<!DOCTYPE html><html><body><div class="sub">说明</div>
                12,200000<b>HVAC热管理9,42512,207.7%0.0%3.6%</b><table id="p03"><tbody><tr><td>A</td></tr></tbody></table></body></html>`;
const cleanedCorrupt = stripEditorArtifactsFromSource(corrupted);
check(
  "历史损坏：打开时清除表格前的游离坏文本",
  !cleanedCorrupt.includes("12,200000") && !cleanedCorrupt.includes("HVAC热管理9,42512") &&
    cleanedCorrupt.includes('<table id="p03">')
);
const upgraded = injectFreezeScript(legacy, [textOp]);
check("旧版固化：保存时 runner 升级为文本级重放", upgraded.includes('action==="text"'));
check(
  "旧版固化：保存时丢弃历史破坏性操作",
  !upgraded.includes("<body>bad</body>")
);
check(
  "旧版固化：只保留一份 runner",
  (upgraded.match(/__hve_freeze_script__/g) || []).length === 1
);

console.log("\n测试完成。");
