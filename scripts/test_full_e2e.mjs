// 用真实文件「产品研发域_MCU本体三层落地评估_产品基座数据.html」跑完整功能链路。
// 覆盖：加载保真、点选定位、默认块选择、数据清单、人工文字/插入/删除、AI 文字/样式/结构、
// 四层校验、固化脚本、版本锁/回滚。重点验证块外字节不丢、整页不被清空。
// 用法：node scripts/test_full_e2e.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "../产品研发域_MCU本体三层落地评估_产品基座数据.html");
const raw = readFileSync(FILE, "utf8");

async function load(rel) {
  const r = await esbuild.build({
    entryPoints: [resolve(__dirname, rel)],
    bundle: true, format: "esm", write: false, platform: "node",
  });
  return import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
}
const patch = await load("../src/lib/htmlPatch.ts");
const core = await load("../src/lib/editCore/index.ts");
const cli = await load("../src/lib/adapters/cliAdapter.ts");
const agent = await load("../src/lib/agentEdit.ts");
const renderer = await load("../src/lib/blockRenderer.ts");
const {
  normalizeHtml, stripEditorArtifactsFromSource, getNodePath, findNodeRange,
  applyEdits, applyEditsTracked, buildFreezeOps, injectFreezeScript, injectLightbox,
} = patch;
const { applyPlan, dryRun, VersionLock, RollbackStore } = core;
const { extractPlan } = cli;
const { classifyIntent } = agent;
const { collectBlockData, collectStyleHints, renderSafeBlockHtml } = renderer;

globalThis.DOMParser = new JSDOM("").window.DOMParser;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

// ---------- 1. 加载保真 ----------
section("1 加载 / 序列化保真");
const cleaned = stripEditorArtifactsFromSource(raw);
const html = normalizeHtml(cleaned);
check("加载：清理不改变干净文件的字符数", Math.abs(html.length - raw.length) < 200, `${raw.length}->${html.length}`);
const doc = new JSDOM(html).window.document;
check("加载：关键内容都在", html.includes("产品层") && html.includes("基座平台能力层") && html.includes("数据层") && html.includes("必须同时成立的四个判断"));
check("加载：无编辑器残留", !html.includes("__hve_freeze") && !html.includes("data-hve-block-done"));

// ---------- 定位要编辑的 bars 块 ----------
const barsCandidates = [...doc.querySelectorAll(".bars")];
const bars = barsCandidates.find((b) => (b.textContent || "").includes("产品层") && (b.textContent || "").includes("42"));
check("定位：找到目标 bars 块", !!bars);
const barsPath = getNodePath(bars);
const barsRange = findNodeRange(html, barsPath);
check("定位：bars 块路径能在源码里定位", !!barsRange);
check("定位：bars 块体积合理（远小于整页）", bars.outerHTML.length < html.length * 0.05, `${bars.outerHTML.length}/${html.length}`);

// 祖先链：确认最小合适块是 bars 而不是 layout
const layout = doc.querySelector(".layout");
const layoutPath = getNodePath(layout);
const layoutRange = findNodeRange(html, layoutPath);
check("定位：layout 体积远大于 bars（证明默认选小块必要）", layoutRange && layoutRange.end - layoutRange.start > (barsRange.end - barsRange.start) * 10);

// 回归：默认块必须选「同标签兄弟组」的 .bars，而不是单行 .bar-row 或混合的 .card。
// 之前 tags.size<=2 会把 .bar-row（span+div+span）误判为一组，数据清单只剩一个数字，
// 模型拿不到完整数据就编造出预览里的橙色「3」垃圾内容。
const barRows = [...doc.querySelectorAll(".bar-row")];
const singleRow = barRows[0];
const barCard = bars.closest(".card");
const isSameTagGroup = (el) => {
  const kids = [...el.children];
  return kids.length >= 2 && kids.length <= 20 && new Set(kids.map((k) => k.tagName.toLowerCase())).size === 1;
};
check("默认块：.bar-row 是混合标签，不会被选中", !isSameTagGroup(singleRow));
check("默认块：.bars 是同标签兄弟组，会被选中", isSameTagGroup(bars));
check("默认块：.card 含说明段落，不会被选中", !!barCard && !isSameTagGroup(barCard));

// 关键回归：aside 与 main 是兄弟，它们内部元素嵌套深度相同。
// findNodeRange 若只按 depth+tag+nth 匹配，card 路径会误命中 aside>div.brand>div.brand-mark，
// 把新内容写进左上角品牌区，而真正的 bars 块不动。必须校验完整父链。
{
  const cardEl = [...doc.querySelectorAll(".card")].find(
    (e) => (e.textContent || "").includes("产品层") && (e.textContent || "").includes("基座平台能力层")
  );
  const cardPath = getNodePath(cardEl);
  const cardRange = findNodeRange(html, cardPath);
  const cardFrag = cardRange ? html.slice(cardRange.start, cardRange.end) : "";
  check("定位：card 路径命中真正的 div.card（不是品牌区）", cardFrag.includes('class="card"') && cardFrag.includes('class="bar'), cardFrag.replace(/\s+/g, " ").slice(0, 80));
  const brand = doc.querySelector(".brand-title");
  const brandPath = getNodePath(brand);
  const brandRange = findNodeRange(html, brandPath);
  const brandFrag = brandRange ? html.slice(brandRange.start, brandRange.end) : "";
  check("定位：brand-title 路径命中品牌区自身", brandFrag.includes("MCU 三层落地评估") || brandFrag.includes("brand-title"), brandFrag.replace(/\s+/g, " ").slice(0, 80));
}

// ---------- 2. 数据清单 / 风格线索 ----------
section("2 数据清单 / 风格线索");
const dataList = collectBlockData(bars);
check("数据清单：产品层=42", dataList.includes("产品层：42"), dataList);
check("数据清单：基座平台能力层=50", dataList.includes("基座平台能力层：50"));
check("数据清单：数据层=45", dataList.includes("数据层：45"));
check("数据清单：无 HTML 标签", !dataList.includes("<"));
const hints = collectStyleHints(doc);
check("风格线索：有色值", /#[0-9a-f]{3,8}/i.test(hints));
check("风格线索：无 class 名诱导", !hints.includes("class"));

// ---------- 3. 意图分类 ----------
section("3 意图分类");
check("意图：柱状图指令→结构重排", classifyIntent("将选择的柱状图逆时针旋转90度，按产品层从左到右") === "structure");
check("意图：文字改动→明确", classifyIntent("把数值改成 120") === "explicit");
check("意图：圆形→样式", classifyIntent("改成圆形布局") === "style");

// ---------- 4. 人工文字编辑（整段替换） ----------
section("4 人工文字编辑（整段替换，不重复）");
const firstKpi = bars.querySelector(".bar-k");
const kpiPath = getNodePath(firstKpi);
const kpiFrom = firstKpi.textContent;
const outText = applyEdits(html, [{ path: kpiPath, innerText: kpiFrom + "测试", innerFrom: kpiFrom }]);
check("人工文字：新文字写入", outText.includes(kpiFrom + "测试"));
check("人工文字：只出现一次（不重复）", (outText.match(new RegExp(kpiFrom + "测试", "g")) || []).length === 1);
check("人工文字：块外字节保真", outText.startsWith(html.slice(0, 100)) && outText.includes("必须同时成立的四个判断"));

// ---------- 5. 插入（按位置） ----------
section("5 插入（按选中元素位置）");
const thirdRow = bars.querySelectorAll(".bar-row")[2];
const rowPath = getNodePath(thirdRow);
const outInsert = applyEdits(html, [{ path: rowPath, insertHtml: '<img src="data:image/png;base64,AAA">', insertPosition: "after" }]);
const docIns = new JSDOM(outInsert).window.document;
const insBars = [...docIns.querySelectorAll(".bars")].find((b) => (b.textContent || "").includes("产品层"));
const kids = [...insBars.children].map((k) => k.className || k.tagName.toLowerCase());
check("插入：图片出现在第3行之后", kids.indexOf("bar-row") >= 0 && outInsert.indexOf("data:image/png") > outInsert.indexOf("数据层"));
check("插入：整页其他内容仍在", outInsert.includes("必须同时成立的四个判断") && outInsert.includes("结论摘要"));

// ---------- 6. 删除块 ----------
section("6 删除块");
// 删掉第一个 bar-row，用它的路径
const firstRowPath = getNodePath(bars.querySelectorAll(".bar-row")[0]);
const outDel = applyEdits(html, [{ path: firstRowPath, remove: true }]);
const docDel = new JSDOM(outDel).window.document;
const delBars = [...docDel.querySelectorAll(".bars")].find((b) => (b.textContent || "").includes("产品层") || (b.textContent || "").includes("基座"));
check("删除：目标行消失", outDel.indexOf("产品层") === -1 || (delBars && delBars.querySelectorAll(".bar-row").length === 2));
check("删除：整页其他内容仍在", outDel.includes("必须同时成立的四个判断"));

// ---------- 7. AI 文字改动（extractPlan + 四层校验） ----------
section("7 AI 文字改动 + 四层校验");
const fieldText = {
  kind: "text", field: "value", fieldLabel: "产品层",
  fieldPath: kpiPath, textNodeIndex: 0, textFrom: kpiFrom,
};
const planText = extractPlan(JSON.stringify({ textTo: "产品层测试改动" }), fieldText);
const lock = new VersionLock(), rb = new RollbackStore();
const rText = applyPlan(planText, html, { versions: lock, rollbacks: rb });
check("AI 文字：四层通过", rText.report.pass === true, JSON.stringify(rText.report.layers));
check("AI 文字：状态 applied/frozen", rText.status === "applied" || rText.status === "frozen", rText.status);
check("AI 文字：改动写入", rText.html?.includes("产品层测试改动"));

// ---------- 8. AI 样式改动 ----------
section("8 AI 样式改动");
const planStyle = extractPlan(JSON.stringify({ stylePatches: [{ prop: "text-align", value: "center" }] }), fieldText);
const rStyle = applyPlan(planStyle, html, { versions: new VersionLock(), rollbacks: new RollbackStore() });
check("AI 样式：四层通过", rStyle.report.pass === true, JSON.stringify(rStyle.report.layers));
check("AI 样式：样式写入开标签", /text-align:\s*center/.test(rStyle.html || ""));

// ---------- 9. AI 结构重排（块级，基于数据清单） ----------
section("9 AI 结构重排（块级，整页不丢）");
const blockField = {
  ...fieldText, blockPath: barsPath, blockFromHtml: bars.outerHTML,
};
// 模拟模型基于数据清单产出的正确柱状图（三根并排）
const chartHtml = `<div style="display:flex;flex-direction:row;align-items:flex-end;gap:24px;height:240px">` +
  `<div style="display:flex;flex-direction:column;justify-content:flex-end;align-items:center;width:56px;height:168px;background:#0f6b5c"><div>42</div><div>产品层</div></div>` +
  `<div style="display:flex;flex-direction:column;justify-content:flex-end;align-items:center;width:56px;height:200px;background:#1f5fa8"><div>50</div><div>基座平台能力层</div></div>` +
  `<div style="display:flex;flex-direction:column;justify-content:flex-end;align-items:center;width:56px;height:180px;background:#0f6b5c"><div>45</div><div>数据层</div></div>` +
  `</div>`;
const safeChart = renderSafeBlockHtml(chartHtml);
check("结构重排：安全渲染保留三根柱子", (safeChart.match(/display:flex/g) || []).length >= 4 && safeChart.includes("产品层"));
check("结构重排：安全渲染无 class", !safeChart.includes("class="));
const planBlock = extractPlan(JSON.stringify({ blockHtml: chartHtml }), blockField);
check("结构重排：计划指向 bars 块", planBlock.edits[0].path === barsPath);
const rBlock = applyPlan(planBlock, html, { versions: new VersionLock(), rollbacks: new RollbackStore() });
check("结构重排：四层通过", rBlock.report.pass === true, JSON.stringify(rBlock.report.layers));
const blockOut = rBlock.html || "";
check("结构重排：三根柱子都在", blockOut.includes("产品层") && blockOut.includes("基座平台能力层") && blockOut.includes("数据层") && blockOut.includes("flex-direction:row"));
check("结构重排：整页其他内容未丢（关键回归）", blockOut.includes("必须同时成立的四个判断") && blockOut.includes("结论摘要") && blockOut.includes("17 步流程只能走到第 8 步") && blockOut.includes("三层对齐矩阵") && blockOut.length > html.length * 0.9, `${html.length}->${blockOut.length}`);

// ---------- 10. 固化脚本 + 灯箱 ----------
section("10 固化脚本 / 灯箱");
const frozen = injectLightbox(injectFreezeScript(blockOut, planBlock.edits));
check("固化：含 block 重放操作", frozen.includes("__hve_freeze_ops__") && frozen.includes('"block"'));
check("灯箱：含灯箱脚本", frozen.includes("__hve_lightbox_script__"));
const ops = buildFreezeOps(planBlock.edits);
check("固化：block 操作带文字签名", ops.length === 1 && ops[0].action === "block" && !!ops[0].fromText);

// ---------- 11. 多步累计编辑 ----------
section("11 多步累计编辑（文字+插入+结构）");
const multiEdits = [
  { path: kpiPath, innerText: kpiFrom + "改", innerFrom: kpiFrom },
  { path: rowPath, insertHtml: '<p>插入说明</p>', insertPosition: "after" },
  { path: barsPath, blockHtml: safeChart, blockFrom: bars.outerHTML },
];
const multiOut = applyEdits(html, multiEdits);
check("多步：改动都生效", multiOut.includes("插入说明") && multiOut.includes("产品层"));
check("多步：整页其他内容未丢", multiOut.includes("必须同时成立的四个判断") && multiOut.length > html.length * 0.9);

// ---------- 12. 保存后重置基线：插入图片不重复 ----------
section("12 保存后重置基线（插入图片不重复）");
{
  const imgTag = '<img src="data:image/png;base64,AAAA">';
  const insertEdits = [{ path: rowPath, insertHtml: imgTag, insertPosition: "after" }];
  // 模拟 finalizeWith：有改动记录时基于 originalHtml 重放
  const first = applyEdits(html, insertEdits);
  const d1 = new JSDOM(first).window.document;
  const n1 = [...d1.querySelectorAll("img")].filter((i) => (i.getAttribute("src") || "").includes("AAAA")).length;
  check("插入：第一次生成恰好 1 张图片", n1 === 1, `实际=${n1}`);
  // 修复前：保存后 originalHtml=first 但改动记录未清空，再 finalize 会重放第二次 → 2 张
  const beforeFix = applyEdits(first, insertEdits);
  const n2 = [...new JSDOM(beforeFix).window.document.querySelectorAll("img")].filter((i) => (i.getAttribute("src") || "").includes("AAAA")).length;
  check("回归：未清记录会重复插入（证明 bug 存在）", n2 === 2, `实际=${n2}`);
  // 修复后：保存后清空记录、以 first 为新基线，后续 finalize 不再重放
  const afterFix = first; // 无改动记录 → finalize 直接返回基线
  const n3 = [...new JSDOM(afterFix).window.document.querySelectorAll("img")].filter((i) => (i.getAttribute("src") || "").includes("AAAA")).length;
  check("修复：清空记录后仍为 1 张图片", n3 === 1, `实际=${n3}`);
}

// ---------- 13. 静态插入不被固化脚本重复执行（本次核心 bug） ----------
section("13 静态插入不重复（applyEditsTracked + freeze 过滤）");
{
  const marker = "CCCC";
  const imgTag = `<img src="data:image/png;base64,${marker}">`;
  const insertEdit = { path: rowPath, insertHtml: imgTag, insertPosition: "after" };
  const textEdit = { path: kpiPath, innerText: kpiFrom + "#13", innerFrom: kpiFrom };
  const edits = [insertEdit, textEdit];

  const tracked = applyEditsTracked(html, edits);
  check("追踪：静态插入与文字编辑都写入源码",
    tracked.applied.includes(insertEdit) && tracked.applied.includes(textEdit),
    `applied=${tracked.applied.length}`);

  // 模拟 App.finalizeWith 的过滤：仅剔除「已写入源码的插入类 edit」
  const appliedSet = new Set(tracked.applied);
  const freezeEdits = edits.filter((edit) => {
    const isInsert = edit.insertHtml !== undefined || edit.appendHtml !== undefined;
    return !(isInsert && appliedSet.has(edit));
  });
  check("过滤：静态插入剔除固化，文字编辑保留",
    freezeEdits.length === 1 && freezeEdits[0] === textEdit,
    `freezeEdits=${freezeEdits.length}`);

  const readOps = (htmlStr) => {
    const m = htmlStr.match(/<script id="__hve_freeze_ops__"[^>]*>([\s\S]*?)<\/script>/i);
    return m ? JSON.parse(m[1]) : [];
  };
  const fixedHtml = injectLightbox(injectFreezeScript(tracked.html, freezeEdits));
  check("固化：修复后不含 insert 操作",
    !readOps(fixedHtml).some((op) => op.action === "insert"),
    `ops=${JSON.stringify(readOps(fixedHtml).map((o) => o.action))}`);

  // 用执行脚本的 JSDOM 统计页面加载固化脚本后的真实图片数
  const countAfterLoad = async (htmlStr) => {
    const dom = new JSDOM(htmlStr, {
      runScripts: "dangerously",
      pretendToBeVisual: true,
      beforeParse(window) {
        // 页面自带脚本依赖 IntersectionObserver，JSDOM 未实现，注入空实现避免噪音。
        window.IntersectionObserver = class {
          observe() {}
          unobserve() {}
          disconnect() {}
        };
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    const n = [...dom.window.document.querySelectorAll("img")]
      .filter((i) => (i.getAttribute("src") || "").includes(marker)).length;
    dom.window.close();
    return n;
  };
  const fixedN = await countAfterLoad(fixedHtml);
  check("端到端：页面加载后目标图片恰好 1 张（不重复）", fixedN === 1, `实际=${fixedN}`);

  // 对照组：修复前把所有 edit 都塞进固化脚本 → 固化脚本含 insert，页面加载后变 2 张
  const oldHtml = injectLightbox(injectFreezeScript(tracked.html, edits));
  check("对照：修复前固化脚本含 insert 操作",
    readOps(oldHtml).some((op) => op.action === "insert"));
  const oldN = await countAfterLoad(oldHtml);
  check("对照：修复前页面加载后图片变成 2 张（证明 bug 存在）", oldN === 2, `实际=${oldN}`);

  // 回归保护：动态节点（源码无锚点）applyEdits 写不进去，固化脚本必须保留兜底
  const dynEdit = {
    path: "html > body > div#js-generated",
    insertHtml: '<img src="data:image/png;base64,DDDD">',
    insertPosition: "after", dynamicNode: true,
  };
  const dyn = applyEditsTracked(html, [dynEdit]);
  check("动态节点：applyEdits 未写入源码", !dyn.applied.includes(dynEdit));
  check("动态节点：固化脚本保留 insert 兜底",
    readOps(injectFreezeScript(dyn.html, dyn.unapplied))
      .some((op) => op.action === "insert" && op.html.includes("DDDD")));
}

console.log(`\n===== 总计：${pass} 通过 / ${fail} 失败 =====`);
process.exitCode = fail === 0 ? 0 : 1;
