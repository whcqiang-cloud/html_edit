// DOM 路径定位 + 源码级精准回填
// 用户只在 iframe 里可视化改文字/图片/删除区块。
// 保存时：用「源码级标签扫描」按 path 在原始 HTML 字符串中定位节点区间，
// 仅替换该区间，其余字节原样保留 —— 未改处 100% 不动，不依赖任何 DOM 序列化。

// 计算元素在文档中的稳定 CSS 路径：tag + nth-of-type，不依赖易变的 id/class。
export function getNodePath(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== "html") {
    const tag = node.tagName.toLowerCase();
    let nth = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName.toLowerCase() === tag) nth++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(tag + ":nth-of-type(" + nth + ")");
    node = node.parentElement;
  }
  return "html > " + parts.join(" > ");
}

export interface HtmlEdit {
  path: string;
  outerHtml?: string; // 新的 outerHTML（edit / set-img 用）
  remove?: boolean; // 删除该节点
  appendHtml?: string; // 在节点内部末尾追加
}

interface Range {
  start: number; // 开标签 '<' 位置
  end: number; // 闭标签 '>' 之后
  innerStart: number; // 开标签 '>' 之后
  innerEnd: number; // 闭标签 '<' 之前
  depth: number;
}

// 自闭合/void 标签
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// 在源码字符串中按 path 定位节点区间。
// 用标签栈扫描，按 tag + nth-of-type 计数匹配。
export function findNodeRange(html: string, path: string): Range | null {
  const segments = path.split(" > ").slice(1); // 去掉 "html"
  const targetTags = segments.map((s) => {
    const m = s.match(/^([a-z0-9]+):nth-of-type\((\d+)\)$/);
    return m ? { tag: m[1], nth: parseInt(m[2], 10) } : null;
  });
  if (targetTags.some((t) => !t)) return null;

  const counters: Record<string, number>[] = [{}];
  const openStack: { tag: string; start: number; innerStart: number }[] = [];
  let pending: (Range & { depth: number }) | null = null;
  let i = 0;
  const n = html.length;

  while (i < n) {
    if (html[i] !== "<") {
      i++;
      continue;
    }
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
    if (html.startsWith("</", i)) {
      const e = html.indexOf(">", i);
      if (e === -1) break;
      const tag = html.slice(i + 2, e).trim().toLowerCase().split(/\s/)[0];
      if (openStack.length && openStack[openStack.length - 1].tag === tag) {
        const node = openStack[openStack.length - 1];
        // pop 之前：openStack.length 应为 pending.depth + 1
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
    // 开标签
    const e = html.indexOf(">", i);
    if (e === -1) break;
    const tagRaw = html.slice(i + 1, e);
    const tag = tagRaw.trim().split(/\s/)[0].toLowerCase();
    // 根元素 <html> 作为路径边界，不入栈（路径从 body 起算层级）
    if (tag === "html") {
      i = e + 1;
      continue;
    }
    const selfClose = /\/\s*$/.test(tagRaw);
    const isVoid = VOID_TAGS.has(tag);
    const depth = openStack.length;
    const cnt = (counters[depth][tag] || 0) + 1;
    counters[depth][tag] = cnt;

    const tt = targetTags[depth];
    if (tt && tt.tag === tag && cnt === tt.nth && depth === targetTags.length - 1) {
      if (isVoid || selfClose) {
        return {
          start: i,
          end: e + 1,
          innerStart: e + 1,
          innerEnd: e + 1,
          depth,
        };
      }
      pending = {
        start: i,
        end: 0,
        innerStart: e + 1,
        innerEnd: 0,
        depth,
      };
    }
    if (!isVoid && !selfClose) {
      openStack.push({ tag, start: i, innerStart: e + 1 });
      counters.push({});
    }
    i = e + 1;
  }
  return null;
}

// 精准回填：按 path 在源码中定位节点区间，替换/删除/追加。
export function applyEdits(originalHtml: string, edits: HtmlEdit[]): string {
  if (edits.length === 0) return originalHtml;
  let result = originalHtml;
  for (const edit of edits) {
    const range = findNodeRange(result, edit.path);
    if (!range) continue;
    let replacement = result.slice(range.start, range.end);
    if (edit.remove) {
      replacement = "";
    } else if (edit.outerHtml !== undefined) {
      replacement = edit.outerHtml;
    } else if (edit.appendHtml !== undefined) {
      const inner = result.slice(range.innerStart, range.innerEnd) + edit.appendHtml;
      replacement =
        result.slice(range.start, range.innerStart) +
        inner +
        result.slice(range.innerEnd, range.end);
    }
    result =
      result.slice(0, range.start) + replacement + result.slice(range.end);
  }
  return result;
}
