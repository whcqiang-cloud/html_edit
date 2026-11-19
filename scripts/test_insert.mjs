// 离线测试：验证插入（insert）功能的源码级精准回填
// 用法：node scripts/test_insert.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import esbuild from "esbuild";

const { window } = new JSDOM("");
globalThis.DOMParser = window.DOMParser;
globalThis.document = window.document;

// 用 esbuild 即时转译 TS 模块
const src = readFileSync(new URL("../src/lib/htmlPatch.ts", import.meta.url), "utf8");
const out = await esbuild.transform(src, { loader: "ts", format: "esm" });
const { applyEdits, findNodeRange, getNodePath } = await import(
  "data:text/javascript;base64," + Buffer.from(out.code).toString("base64")
);

function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) process.exitCode = 1;
}

const html = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
  <div class="box">
    <p class="first">Hello</p>
    <p class="second">World</p>
  </div>
  <img src="old.png" alt="old" />
</body>
</html>`;

const dom = new JSDOM(html);
const doc = dom.window.document;

// ---- 测试1：在 p.first 前面插入 ----
const pFirst = doc.querySelector("p.first");
const pFirstPath = getNodePath(pFirst);
const out1 = applyEdits(html, [
  { path: pFirstPath, insertHtml: "<p>Inserted Before</p>", insertPosition: "before" },
]);
const out1Doc = new JSDOM(out1).window.document;
check("前面插入：新增内容在 p.first 之前", out1Doc.querySelector("p.first").previousElementSibling?.textContent === "Inserted Before");
check("前面插入：p.first 仍在", !!out1Doc.querySelector("p.first"));
check("前面插入：字节级前面保留", out1.startsWith(html.slice(0, findNodeRange(html, pFirstPath).start)));

// ---- 测试2：在 p.first 后面插入 ----
const out2 = applyEdits(html, [
  { path: pFirstPath, insertHtml: "<p>Inserted After</p>", insertPosition: "after" },
]);
const out2Doc = new JSDOM(out2).window.document;
check("后面插入：新增内容在 p.first 之后", out2Doc.querySelector("p.first").nextElementSibling?.textContent === "Inserted After");

// ---- 测试3：在 div.box 开头插入（prepend）----
const divBox = doc.querySelector("div.box");
const divBoxPath = getNodePath(divBox);
const out3 = applyEdits(html, [
  { path: divBoxPath, insertHtml: "<p>Prepended</p>", insertPosition: "prepend" },
]);
const out3Doc = new JSDOM(out3).window.document;
check("开头插入：作为 div.box 第一个子节点", out3Doc.querySelector("div.box").firstElementChild?.textContent === "Prepended");

// ---- 测试4：在 div.box 末尾插入（append）----
const out4 = applyEdits(html, [
  { path: divBoxPath, insertHtml: "<p>Appended</p>", insertPosition: "append" },
]);
const out4Doc = new JSDOM(out4).window.document;
check("末尾插入：作为 div.box 最后一个子节点", out4Doc.querySelector("div.box").lastElementChild?.textContent === "Appended");

// ---- 测试5：插入图片 ----
const img = doc.querySelector("img");
const imgPath = getNodePath(img);
const out5 = applyEdits(html, [
  { path: imgPath, insertHtml: '<img src="new.png" alt="new" />', insertPosition: "after" },
]);
const out5Doc = new JSDOM(out5).window.document;
const imgs = out5Doc.querySelectorAll("img");
check("插入图片：图片数量 +1", imgs.length === 2);
check("插入图片：新图片 src 正确", [...imgs].some((i) => i.getAttribute("src") === "new.png"));

// ---- 测试6：多条组合插入（before + after + prepend + append）----
const out6 = applyEdits(html, [
  { path: pFirstPath, insertHtml: "<p>A</p>", insertPosition: "before" },
  { path: pFirstPath, insertHtml: "<p>B</p>", insertPosition: "after" },
  { path: divBoxPath, insertHtml: "<p>C</p>", insertPosition: "prepend" },
  { path: divBoxPath, insertHtml: "<p>D</p>", insertPosition: "append" },
]);
const out6Doc = new JSDOM(out6).window.document;
const boxChildren = [...out6Doc.querySelector("div.box").children].map((c) => c.textContent.trim());
check("组合插入：顺序正确 C, A, Hello, B, World, D",
  JSON.stringify(boxChildren) === JSON.stringify(["C", "A", "Hello", "B", "World", "D"]));

// ---- 测试7：与删除/替换混合 ----
const out7 = applyEdits(html, [
  { path: pFirstPath, insertHtml: "<p>NEW</p>", insertPosition: "before" },
  { path: doc.querySelector("p.second").outerHTML ? getNodePath(doc.querySelector("p.second")) : pFirstPath, remove: true },
]);
const out7Doc = new JSDOM(out7).window.document;
check("混合：p.second 被删除", !out7Doc.querySelector("p.second"));
check("混合：插入的新段落存在", [...out7Doc.querySelectorAll("p")].some((p) => p.textContent === "NEW"));

// ---- 测试8：在列表中间某条 li 之后插入图片，必须紧邻该 li，不能跑到整个 ul 后面 ----
{
  const listHtml = `<!DOCTYPE html><html><body><ul class="rules">
  <li id="a">第一条</li>
  <li id="b">注塑实例口径：设计实例</li>
  <li id="c">第三条</li>
</ul><p id="tail">页尾</p></body></html>`;
  const ld = new JSDOM(listHtml).window.document;
  const liBPath = getNodePath(ld.getElementById("b"));
  const out = applyEdits(listHtml, [
    { path: liBPath, insertHtml: '<img src="data:image/png;base64,AAA">', insertPosition: "after" },
  ]);
  const od = new JSDOM(out).window.document;
  const ul = od.querySelector("ul.rules");
  const kids = [...ul.children].map((k) => k.id || k.tagName.toLowerCase());
  check("按选中位置插入：图片紧邻所选 li 之后", kids.join(",") === "a,b,img,c");
  check("按选中位置插入：图片在 ul 内，没跑到列表后面", od.querySelector("ul.rules img") !== null && od.querySelector("img") === od.querySelector("ul.rules img"));
  check("按选中位置插入：页尾仍在 ul 之后", out.indexOf("</ul>") < out.indexOf('id="tail"'));
}

console.log("\n插入功能测试完成。");
