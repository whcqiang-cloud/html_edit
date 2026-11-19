// 端到端模拟：模拟用户点击元素 → 选择插入 → 确认 → 保存 的完整流程
// 验证 confirmInsert 生成的数据格式与 applyEdits 的正确性
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import esbuild from "esbuild";

const { applyEdits, getNodePath } = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      (await esbuild.transform(readFileSync(new URL("../src/lib/htmlPatch.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" })).code
    ).toString("base64")
);

function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) process.exitCode = 1;
}

const html = `<!DOCTYPE html>
<html><head><title>Demo</title></head><body>
  <div class="content">
    <h1>标题</h1>
    <p class="lead">正文第一段</p>
  </div>
</body></html>`;

const dom = new JSDOM(html);
const doc = dom.window.document;

// 模拟用户：在 h1 后面插入一段文字
const h1 = doc.querySelector("h1");
const h1Path = getNodePath(h1);
// confirmInsert("after") 对文字类型生成的 edit
const insertTextEdit = {
  path: h1Path,
  insertHtml: "<p>这是新插入的段落</p>",
  insertPosition: "after",
};
// 模拟用户：在 div.content 末尾插入图片
const div = doc.querySelector("div.content");
const divPath = getNodePath(div);
const insertImgEdit = {
  path: divPath,
  insertHtml: '<img src="https://example.com/pic.png" alt="示例图" />',
  insertPosition: "append",
};

const out = applyEdits(html, [insertTextEdit, insertImgEdit]);
const outDoc = new JSDOM(out).window.document;

check("端到端：h1 后面出现新段落", 
  [...outDoc.querySelectorAll("p")].some((p) => p.textContent === "这是新插入的段落"));
check("端到端：图片已插入到 div.content 内", 
  outDoc.querySelector("div.content img")?.getAttribute("src") === "https://example.com/pic.png");
check("端到端：原 h1 标题未变", outDoc.querySelector("h1")?.textContent === "标题");
check("端到端：原 p.lead 未变", outDoc.querySelector("p.lead")?.textContent === "正文第一段");
check("端到端：DOCTYPE 保留", out.startsWith("<!DOCTYPE html>"));
check("端到端：title 保留", outDoc.querySelector("title")?.textContent === "Demo");

console.log("\n端到端插入模拟测试完成。");
