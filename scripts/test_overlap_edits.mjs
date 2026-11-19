import { JSDOM } from "jsdom";

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: "dangerously" });

function findNodeRange(html, path) {
  const segments = path.split(" > ").slice(1);
  const targetTags = segments.map((s) => {
    const m = s.match(/^([a-zA-Z0-9\-]+)(?:\:(nth-of-type|first-child)\((\d+)\))?$/);
    if (!m) return null;
    return { tag: m[1], nth: m[3] ? parseInt(m[3], 10) : 1 };
  }).filter(Boolean);
  if (!targetTags.length) return null;

  const n = html.length;
  const openStack = [];
  const counters = [{}];
  let pending = null;

  const VOID_TAGS = new Set([
    "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr",
  ]);

  for (let i = 0; i < n; ) {
    if (html.startsWith("<!--", i)) {
      const e = html.indexOf("-->", i);
      i = e === -1 ? n : e + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const e = html.indexOf(">", i);
      i = e === -1 ? n : e + 1;
      continue;
    }
    if (!html.startsWith("<", i)) { i++; continue; }

    if (html.startsWith("</", i)) {
      const e = html.indexOf(">", i);
      if (e === -1) break;
      const tag = html.slice(i + 2, e).trim().toLowerCase().split(/\s/)[0];
      if (openStack.length && openStack[openStack.length - 1].tag === tag) {
        const node = openStack[openStack.length - 1];
        if (pending && pending.start === node.start && openStack.length === pending.depth + 1) {
          pending.end = e + 1;
          pending.innerEnd = i;
          const result = pending;
          pending = null;
          openStack.pop();
          counters.pop();
          return result;
        }
        openStack.pop();
        counters.pop();
      }
      i = e + 1;
      continue;
    }

    const e = html.indexOf(">", i);
    if (e === -1) break;
    const tagRaw = html.slice(i + 1, e);
    const tag = tagRaw.trim().toLowerCase().split(/\s/)[0];
    if (tag === "html") { i = e + 1; continue; }

    const isVoid = VOID_TAGS.has(tag);
    const selfClose = /\/\s*$/.test(tagRaw);
    const depth = openStack.length;
    counters[depth][tag] = (counters[depth][tag] || 0) + 1;
    const cnt = counters[depth][tag];
    const tt = targetTags[depth];

    if (tt && tt.tag === tag && cnt === tt.nth) {
      if (depth === targetTags.length - 1) {
        if (isVoid || selfClose) {
          return { start: i, end: e + 1, innerStart: e + 1, innerEnd: e + 1, depth };
        }
        pending = { start: i, end: 0, innerStart: e + 1, innerEnd: 0, depth };
      }
    }

    if (!isVoid && !selfClose) {
      openStack.push({ tag, start: i });
      counters.push({});
    }
    i = e + 1;
  }
  return null;
}

function applyEdits(originalHtml, edits) {
  const ops = [];
  for (const edit of edits) {
    const range = findNodeRange(originalHtml, edit.path);
    if (!range) {
      console.log("[DEBUG] findNodeRange 返回 null, path:", edit.path);
      continue;
    }
    if ("remove" in edit && edit.remove) {
      ops.push({ at: range.start, removeLen: range.end - range.start, insert: "" });
    } else if ("outerHtml" in edit) {
      ops.push({ at: range.start, removeLen: range.end - range.start, insert: edit.outerHtml });
    } else if ("insertHtml" in edit) {
      const pos = edit.insertPosition === "after" ? range.end : range.start;
      ops.push({ at: pos, removeLen: 0, insert: edit.insertHtml });
    } else if ("appendHtml" in edit) {
      ops.push({ at: range.innerEnd, removeLen: 0, insert: edit.appendHtml });
    }
  }
  ops.sort((a, b) => a.at - b.at);
  let result = originalHtml;
  let delta = 0;
  for (const op of ops) {
    const pos = op.at + delta;
    result = result.slice(0, pos) + op.insert + result.slice(pos + op.removeLen);
    delta += op.insert.length - op.removeLen;
  }
  return result;
}

function normalizeHtml(html) {
  const doc = new dom.window.DOMParser().parseFromString(html, "text/html");
  const match = html.match(/^<!DOCTYPE\s+[^>]*>/i);
  return (match ? match[0] : "") + doc.documentElement.outerHTML;
}

function getNodePath(el) {
  const path = [];
  let node = el;
  while (node && node.tagName) {
    let nth = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName.toLowerCase() === node.tagName.toLowerCase()) nth++;
      sib = sib.previousElementSibling;
    }
    path.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + nth + ")");
    node = node.parentElement;
  }
  return path.join(" > ");
}

// ========== 模拟用户场景：编辑 section 内的 h3，然后删除整个 section ==========
const userHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><title>Test</title></head>
<body>
<section>
<h3>阿斯顿发山东阿斯顿发</h3>
<p>section 内容...</p>
</section>
<section>
<h3>目录</h3>
<p>section 内容2...</p>
</section>
</body>
</html>`;

const normalized = normalizeHtml(userHtml);
console.log("=== 规范化后的 HTML ===");
console.log(normalized);
console.log();

const doc = new dom.window.DOMParser().parseFromString(normalized, "text/html");
const sections = doc.querySelectorAll("section");
const firstSection = sections[0];
const h3 = firstSection.querySelector("h3");

const h3Path = getNodePath(h3);
const sectionPath = getNodePath(firstSection);

console.log("h3 path:", h3Path);
console.log("section path:", sectionPath);

const edits = [
  // 先编辑 h3
  { path: h3Path, outerHtml: "<h3>修改后的标题</h3>" },
  // 再删除整个 section（注意：这和编辑 h3 是嵌套关系！）
  { path: sectionPath, remove: true },
];

console.log("\n=== 应用 edits（嵌套场景）===");
const result = applyEdits(normalized, edits);
console.log("结果:");
console.log(result);
console.log();
console.log("包含'修改后的标题':", result.includes("修改后的标题"));
console.log("包含'阿斯顿发':", result.includes("阿斯顿发"));
console.log("包含'section 内容...':", result.includes("section 内容..."));
console.log("包含'目录':", result.includes("目录"));

// ========== 场景2：编辑和删除不重叠 ==========
console.log("\n\n=== 场景2：编辑第一个 section 的 h3，删除第二个 section ===");
const edits2 = [
  { path: h3Path, outerHtml: "<h3>修改后的标题</h3>" },
  { path: getNodePath(sections[1]), remove: true },
];
const result2 = applyEdits(normalized, edits2);
console.log("包含'修改后的标题':", result2.includes("修改后的标题"));
console.log("包含'阿斯顿发':", result2.includes("阿斯顿发"));
console.log("包含'目录':", result2.includes("目录"));
console.log("包含'section 内容2':", result2.includes("section 内容2"));

