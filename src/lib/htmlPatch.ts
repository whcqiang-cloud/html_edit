// DOM 路径定位 + 源码级精准回填
// 用户只在 iframe 里可视化改文字/图片/删除区块。
// 保存时：用「源码级标签扫描」按 path 在原始 HTML 字符串中定位节点区间，
// 仅替换该区间，其余字节原样保留 —— 未改处 100% 不动，不依赖任何 DOM 序列化。

/**
 * 用 DOMParser 规范化 HTML，消除浏览器自动修正（如嵌套 <p> 拆分）
 * 导致的 DOM 与原始字符串不一致问题。
 */
export function normalizeHtml(html: string): string {
  const doctypeMatch = html.match(/^<!DOCTYPE[^>]*>/i);
  const doctype = doctypeMatch ? doctypeMatch[0] : "";
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const serialized = doc.documentElement.outerHTML;
  return doctype ? doctype + "\n" + serialized : serialized;
}

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
  // 插入新元素：以 path 锚点元素为参照
  insertHtml?: string; // 要插入的 HTML 字符串
  insertPosition?: "before" | "after" | "prepend" | "append";
  // 文字编辑：只改文本节点，保留标签 / 属性 / 子元素结构
  textFrom?: string; // 原始文本节点值
  textTo?: string; // 新文本
  textNodeIndex?: number; // 目标文本节点在元素内的序号
  // 整段文字替换（人工编辑用）：元素内可能有多个文本节点（<b> 分段），
  // 用户看到的是合并后的整段文字，应用时也整段替换，不能只塞进第一个文本节点。
  innerText?: string;
  innerFrom?: string; // 编辑前的整段文字，用于校验定位
  // 选中元素时的原始 outerHTML，用于校验源码定位没有漂移到别的节点
  outerFrom?: string;
  // 属性级 / 样式级改动（N8）：只改开标签，不整体替换 outerHTML，避免重排格式
  attrPatches?: { name: string; value: string | null }[];
  stylePatches?: { prop: string; value: string | null }[];
  // 块级结构重排（AI 生成新代码替换选中块的 HTML）：整块替换，块外字节不动
  blockHtml?: string; // 新的整块 HTML（由安全渲染器产出）
  blockFrom?: string; // 选中时的原块 HTML，校验定位没有漂移到别的块
  // 动态渲染节点：该元素由页面 JS 生成，源码里没有对应节点，改动由固化脚本在渲染后重放
  dynamicNode?: boolean;
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
  const openNth: number[] = []; // 每层元素在父元素内同标签的 nth-of-type 序号
  let pending: (Range & { depth: number }) | null = null;
  let i = 0;
  const n = html.length;

  // 必须校验完整父链，不能只按 depth + tag + nth 匹配：
  // <aside> 与 <main> 这类兄弟分支内部元素的 depth 完全相同，
  // 只看 depth 会把 main>section>div 误命中成 aside>div>div（页面左上角品牌区），
  // 新内容就写进错误位置。逐层比对 tag+nth 才能锁定正确分支。
  const chainMatches = (tag: string, nth: number, depth: number): boolean => {
    if (depth !== targetTags.length - 1) return false;
    for (let k = 0; k < depth; k++) {
      const t = targetTags[k];
      if (!t || openStack[k].tag !== t.tag || openNth[k] !== t.nth) return false;
    }
    const last = targetTags[depth];
    return !!last && last.tag === tag && last.nth === nth;
  };

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
          openNth.pop();
          counters.pop();
          return result;
        }
        openStack.pop();
        openNth.pop();
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

    if (chainMatches(tag, cnt, depth)) {
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
      // <script>/<style> 等 raw text 元素内的 HTML 字符串不是真实标签，
      // 整段跳过，避免污染 nth-of-type 计数（数据驱动页面尤其常见）。
      if (!pending && RAW_TEXT_TAGS.has(tag)) {
        const rest = html.slice(e + 1);
        const close = new RegExp("</\\s*" + tag + "\\s*>", "i").exec(rest);
        if (close) {
          i = e + 1 + close.index + close[0].length;
          continue;
        }
      }
      openStack.push({ tag, start: i, innerStart: e + 1 });
      openNth.push(cnt);
      counters.push({});
    }
    i = e + 1;
  }
  return null;
}

// 表格结构标签：不能用 outerHTML 整体重放，也不能在行/格之间插入块级内容
// （浏览器会把非法子节点 foster parenting 搬到表格外，形成永久的结构错位）。
const TABLE_TAGS = new Set([
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
]);

// 这类元素内部是 raw text，扫描时不能把其中的 "<" 当作标签边界。
const RAW_TEXT_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);

/** 解码 HTML 实体，用于把源码文本片段与 DOM 文本节点的 nodeValue 对齐。 */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const num =
        code[1] === "x" || code[1] === "X"
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10);
      return Number.isFinite(num) && num > 0 && num <= 0x10ffff
        ? String.fromCodePoint(num)
        : whole;
    }
    switch (code.toLowerCase()) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return "\u00a0";
      default:
        return whole;
    }
  });
}

/** 块的粗略身份：标签名 + 归一化后的文字前缀，用于容忍 JS 渲染差异的定位校验。 */
function blockIdentity(html: string): { tag: string; text: string } {
  const tagMatch = /^\s*<([a-z0-9]+)/i.exec(html);
  const tag = tagMatch ? tagMatch[1].toLowerCase() : "";
  const text = decodeEntities(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 60);
  return { tag, text };
}

/** 写入文本节点时只需转义 & < >，避免用户输入被解析成标签。 */
function escapeTextContent(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lastTagOfPath(path: string): string {
  const seg = path.split(" > ").pop()?.trim() || "";
  const m = seg.match(/^([a-z0-9]+):nth-of-type\(/i);
  return m ? m[1].toLowerCase() : "";
}

/**
 * 在源码节点内部按标签边界切出文本节点，定位第 wantIndex 个文本片段。
 * 只有解码后与 expected 完全一致才返回区间：不匹配说明源码 DOM 与 iframe DOM 不同构，
 * 此时宁可不改源码（交给固化脚本兜底），也绝不整体替换元素而破坏原有格式。
 */
function findTextNodeRange(
  html: string,
  range: Range,
  wantIndex: number,
  expected: string
): { start: number; end: number } | null {
  const from = range.innerStart;
  const to = range.innerEnd;
  if (from >= to) return null;
  let i = from;
  let index = 0;
  while (i < to) {
    if (html[i] === "<") {
      if (html.startsWith("<!--", i)) {
        const e = html.indexOf("-->", i + 4);
        i = e === -1 || e + 3 > to ? to : e + 3;
        continue;
      }
      const e = html.indexOf(">", i);
      if (e === -1 || e >= to) break;
      const raw = html.slice(i + 1, e);
      const tag = raw.trim().split(/\s/)[0].toLowerCase().replace(/^\//, "");
      i = e + 1;
      if (!raw.startsWith("/") && RAW_TEXT_TAGS.has(tag)) {
        const rest = html.slice(i, to);
        const close = new RegExp("</\\s*" + tag + "\\s*>", "i").exec(rest);
        i = close ? i + close.index + close[0].length : to;
      }
      continue;
    }
    const next = html.indexOf("<", i);
    const end = next === -1 || next > to ? to : next;
    const piece = html.slice(i, end);
    if (piece.length) {
      if (index === wantIndex) {
        return decodeEntities(piece) === expected ? { start: i, end } : null;
      }
      index++;
    }
    i = end;
  }
  return null;
}

// ---- 属性级 / 样式级精准改动（N8）----
// 只重写开标签，innerHTML 与闭标签原样保留，避免整体替换 outerHTML 重排格式。

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseStyle(s: string): Record<string, string> {
  const map: Record<string, string> = {};
  s.split(";").forEach((part) => {
    const i = part.indexOf(":");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) map[k] = v;
  });
  return map;
}

function serializeStyle(map: Record<string, string>): string {
  return Object.keys(map)
    .map((k) => `${k}:${map[k]}`)
    .join(";");
}

function applyAttrPatches(
  head: string,
  patches?: { name: string; value: string | null }[]
): string {
  let h = head;
  for (const p of patches || []) {
    const re = new RegExp(
      `\\s${escapeReg(p.name)}(?:\\s*=\\s*("|')((?:\\\\.|[^\\\\])*?)\\1)?`,
      "i"
    );
    if (p.value === null) {
      h = h.replace(re, "");
      continue;
    }
    const m = re.exec(h);
    if (m) {
      const quote = m[1] || '"';
      h = h.replace(re, ` ${p.name}=${quote}${p.value}${quote}`);
    } else {
      h += ` ${p.name}="${p.value}"`;
    }
  }
  return h;
}

function applyStylePatches(
  head: string,
  patches?: { prop: string; value: string | null }[]
): string {
  if (!patches || !patches.length) return head;
  const styleRe = /\sstyle\s*=\s*("|')((?:\\.|[^\\])*?)\1/i;
  const m = styleRe.exec(head);
  let map = m ? parseStyle(m[2]) : {};
  for (const p of patches) {
    if (p.value === null) delete map[p.prop];
    else map[p.prop] = p.value;
  }
  const serialized = serializeStyle(map);
  if (m) {
    if (serialized) head = head.replace(styleRe, ` style="${serialized}"`);
    else head = head.replace(styleRe, "");
  } else if (serialized) {
    head += ` style="${serialized}"`;
  }
  return head;
}

/** 对开标签字符串做属性 / 样式级精准改动，返回新的开标签（含结尾 `>`）。 */
export function patchOpenTag(
  openTag: string,
  attrPatches?: { name: string; value: string | null }[],
  stylePatches?: { prop: string; value: string | null }[]
): string {
  const closeIdx = openTag.lastIndexOf(">");
  const head = openTag.slice(0, closeIdx);
  const tail = openTag.slice(closeIdx);
  let h = applyAttrPatches(head, attrPatches);
  h = applyStylePatches(h, stylePatches);
  return h + tail;
}

/** 构造一个属性级改动（不替换 outerHTML）。 */
export function attrPatch(
  path: string,
  patches: { name: string; value: string | null }[]
): HtmlEdit {
  return { path, attrPatches: patches };
}

/** 构造一个样式级改动（不替换 outerHTML）。 */
export function stylePatch(
  path: string,
  patches: { prop: string; value: string | null }[]
): HtmlEdit {
  return { path, stylePatches: patches };
}

// 精准回填：按 path 在源码中定位节点区间，替换/删除/追加/插入。
// 所有 edit 先在【原始 HTML】上计算绝对生效位置（at），
// 再按 at 从小到大应用，并用偏移补偿（delta）保证嵌套/重叠场景下的正确性。
function applyEditsCore(
  originalHtml: string,
  edits: HtmlEdit[]
): { result: string; applied: HtmlEdit[] } {
  if (edits.length === 0) return { result: originalHtml, applied: [] };

  // 收集每个 edit 的 range，用于检测嵌套关系
  const editRanges = edits
    .map((edit) => {
      const range = findNodeRange(originalHtml, edit.path);
      return range ? { edit, range } : null;
    })
    .filter(Boolean) as { edit: HtmlEdit; range: Range }[];

  // 如果一个 edit 的 range 被另一个 remove edit 的 range 完全包含，
  // 则跳过该 edit（因为父节点已被删除，子节点 edit 已失效）
  const effectiveEdits: HtmlEdit[] = [];
  for (const item of editRanges) {
    const { edit, range } = item;
    const isContainedByRemove = editRanges.some((other) => {
      if (other.edit === edit) return false;
      if (!other.edit.remove) return false;
      return other.range.start <= range.start && other.range.end >= range.end;
    });
    if (isContainedByRemove) continue;
    effectiveEdits.push(edit);
  }

  interface Op {
    at: number; // 在原始 HTML 中的生效起点偏移
    removeLen: number; // 需要删除的字节数（0 表示纯插入）
    insert: string; // 插入的内容
  }

  const ops: Op[] = [];
  const appliedEdits: HtmlEdit[] = [];
  for (const edit of effectiveEdits) {
    const opsBefore = ops.length;
    const range = findNodeRange(originalHtml, edit.path);
    if (!range) continue;
    if (edit.remove) {
      ops.push({ at: range.start, removeLen: range.end - range.start, insert: "" });
    } else if (edit.innerText !== undefined) {
      // 整段文字替换：把元素内部所有内容（含 <b> 等内联标签）换成一段转义后的纯文本。
      // 用编辑前的整段文字校验，避免路径漂移改到别的元素。
      if (edit.innerFrom !== undefined) {
        const srcText = decodeEntities(
          originalHtml.slice(range.innerStart, range.innerEnd).replace(/<[^>]*>/g, "")
        ).replace(/\s+/g, " ").trim();
        const fromText = edit.innerFrom.replace(/\s+/g, " ").trim();
        if (srcText !== fromText) continue;
      }
      ops.push({
        at: range.innerStart,
        removeLen: range.innerEnd - range.innerStart,
        insert: escapeTextContent(edit.innerText),
      });
    } else if (edit.textFrom !== undefined && edit.textTo !== undefined) {
      // 文字编辑：只替换源码里那一个文本片段，标签/属性/缩进/实体全部原样保留。
      // 定位失败就整条跳过，由固化脚本兜底，不回退成 outerHTML 整体替换。
      const tr = findTextNodeRange(
        originalHtml,
        range,
        edit.textNodeIndex ?? 0,
        edit.textFrom
      );
      if (!tr) continue;
      ops.push({
        at: tr.start,
        removeLen: tr.end - tr.start,
        insert: escapeTextContent(edit.textTo),
      });
    } else if (edit.blockHtml !== undefined) {
      // 块级结构重排：只换这个块的内部，外层标签与属性原样保留，块外字节不动。
      // 页面 JS 会给元素加属性/改内容，不能拿 iframe 的 outerHTML 做字节级比对，
      // 否则会误判为「定位漂移」而静默跳过；这里只比标签名 + 文字前缀确认是同一块。
      if (edit.blockFrom !== undefined) {
        const srcBlock = originalHtml.slice(range.start, range.end);
        const srcId = blockIdentity(srcBlock);
        const fromId = blockIdentity(edit.blockFrom);
        // 路径已唯一定位节点；JS 渲染会改文字，文字不同不能当作「改错块」。
        // 只用标签名做最后一道保险。
        if (srcId.tag && fromId.tag && srcId.tag !== fromId.tag) continue;
      }
      ops.push({
        at: range.innerStart,
        removeLen: range.innerEnd - range.innerStart,
        insert: edit.blockHtml,
      });
    } else if (edit.attrPatches || edit.stylePatches) {
      // 属性 / 样式级改动：只重写开标签，innerHTML 与闭标签原样保留，字节级保真。
      const openTag = originalHtml.slice(range.start, range.innerStart);
      const originalInner = originalHtml.slice(range.innerStart, range.innerEnd);
      const closeTag = originalHtml.slice(range.innerEnd, range.end);
      const newOpen = patchOpenTag(openTag, edit.attrPatches, edit.stylePatches);
      ops.push({
        at: range.start,
        removeLen: range.end - range.start,
        insert: newOpen + originalInner + closeTag,
      });
    } else if (edit.outerHtml !== undefined) {
      // 畸形表格会让源码标签栈与浏览器 DOM 不同构，path 可能定位到别的节点。
      // 用选中时的元素文本校验，不一致就跳过，绝不把改动写到错误位置。
      if (edit.outerFrom !== undefined) {
        const srcText = decodeEntities(
          originalHtml.slice(range.start, range.end).replace(/<[^>]*>/g, "")
        );
        const fromText = decodeEntities(edit.outerFrom.replace(/<[^>]*>/g, ""));
        if (srcText !== fromText) continue;
      }
      ops.push({ at: range.start, removeLen: range.end - range.start, insert: edit.outerHtml });
    } else if (edit.appendHtml !== undefined) {
      ops.push({ at: range.innerEnd, removeLen: 0, insert: edit.appendHtml });
    } else if (edit.insertHtml !== undefined && edit.insertPosition) {
      let at = range.start;
      let pos = edit.insertPosition;
      // 在表格的行/格之间插入 <p>/<img> 会被浏览器搬到表格外，改为插入单元格内部。
      if (TABLE_TAGS.has(lastTagOfPath(edit.path)) && (pos === "before" || pos === "after")) {
        pos = "append";
      }
      if (pos === "after") at = range.end;
      else if (pos === "prepend") at = range.innerStart;
      else if (pos === "append") at = range.innerEnd;
      ops.push({ at, removeLen: 0, insert: edit.insertHtml });
    }
    // 本分支产生了 op（没有 continue）才算真正写入源码，用于区分静态插入与动态兜底。
    if (ops.length > opsBefore) appliedEdits.push(edit);
  }

  // 按原始偏移从小到大（从外到内）应用；偏移相同则删除/替换优先于插入
  ops.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    const wa = a.removeLen > 0 ? 0 : 1;
    const wb = b.removeLen > 0 ? 0 : 1;
    return wa - wb;
  });

  let result = originalHtml;
  let delta = 0; // 已应用 edit 导致的偏移累计变化
  for (const op of ops) {
    const pos = op.at + delta; // 补偿后的实际位置
    result = result.slice(0, pos) + op.insert + result.slice(pos + op.removeLen);
    delta += op.insert.length - op.removeLen;
  }
  return { result, applied: appliedEdits };
}

/** 精准回填（原对外接口）：把编辑记录写回源码，返回最终 HTML。 */
export function applyEdits(originalHtml: string, edits: HtmlEdit[]): string {
  return applyEditsCore(originalHtml, edits).result;
}

/**
 * 追踪版：返回重放后的 HTML，以及真正写入源码 / 未能写入源码的 edit 列表。
 * 写入失败的 edit 包括：源码里找不到锚点（动态渲染节点）、校验不通过、被父删除包含等。
 * 调用方可据此只把「需要兜底」的 edit 交给固化脚本，避免已写入的静态插入被重复执行。
 */
export function applyEditsTracked(
  originalHtml: string,
  edits: HtmlEdit[]
): { html: string; applied: HtmlEdit[]; unapplied: HtmlEdit[] } {
  const { result, applied } = applyEditsCore(originalHtml, edits);
  const appliedSet = new Set(applied);
  return {
    html: result,
    applied,
    unapplied: edits.filter((e) => !appliedSet.has(e)),
  };
}

/**
 * 剔除可视化编辑器注入到页面里的 UI 残留。
 * 旧版保存曾把注入的 <style>、#__hve_bridge__、.hve-bar 一起写进 HTML，
 * 导致文件独立打开时工具条常驻且无法关闭。
 */
export function removeEditorArtifacts(root: ParentNode): void {
  root
    .querySelectorAll(
      "#__hve_bridge__, #__hve_bar__, #__hve_style__, #__hve_lightbox_style__, .hve-bar, .hve-menu"
    )
    .forEach((el) => el.remove());
  root.querySelectorAll("style").forEach((el) => {
    if ((el.textContent || "").includes("[data-hve-hover]")) el.remove();
  });
  root.querySelectorAll("[data-hve-sel], [data-hve-hover]").forEach((el) => {
    el.removeAttribute("data-hve-sel");
    el.removeAttribute("data-hve-hover");
  });
}

/**
 * 从 HTML 源码中移除编辑器 UI 残留，用于打开历史文件时自愈。
 */
export function stripEditorArtifacts(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  removeEditorArtifacts(doc);
  const serialized = doc.documentElement.outerHTML;
  return doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` + serialized : serialized;
}

// 按 <div> 嵌套深度删除编辑器工具条块，避免正则在嵌套菜单处提前截断
function removeEditorBarBlocks(html: string): string {
  const marker = 'class="hve-bar"';
  let out = html;
  let from = 0;
  for (;;) {
    const idx = out.indexOf(marker, from);
    if (idx === -1) break;
    const start = out.lastIndexOf("<", idx);
    if (start === -1 || !/^<div\b/i.test(out.slice(start))) {
      from = idx + marker.length;
      continue;
    }
    const re = /<\/?div\b[^>]*>/gi;
    re.lastIndex = start;
    let depth = 0;
    let end = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      if (/^<\/div/i.test(m[0])) {
        depth--;
        if (depth === 0) {
          end = re.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }
    if (end === -1) break;
    out = out.slice(0, start) + out.slice(end);
    from = start;
  }
  return out;
}

/**
 * 清理旧版「修改固化」脚本。
 * 旧版 runner 用 outerHTML 重放整节点，把浏览器对畸形表格的纠错结果
 * （如 <body>12,200000</body>、游离 <b> 行）固化进 ops，每次打开都会再次破坏表格。
 * 新格式 op 带 tag 校验字段，据此区分；旧格式整体移除，页面回到自身的正常渲染。
 */
function stripLegacyFreeze(html: string): string {
  const opsMatch = html.match(
    /<script id="__hve_freeze_ops__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!opsMatch) return html;
  let legacy = true;
  try {
    const ops = JSON.parse(opsMatch[1]) as { tag?: string }[];
    legacy = !Array.isArray(ops) || ops.some((op) => !op || !op.tag);
  } catch {
    legacy = true;
  }
  if (!legacy) return html;
  return html
    .replace(opsMatch[0], "")
    .replace(/<script id="__hve_freeze_script__"[\s\S]*?<\/script>/gi, "");
}

/**
 * 字符串级清理编辑器注入残留：不做 DOM 序列化，原文件的缩进、属性、注释、
 * 甚至表格内不规范的游离文本都按原字节保留（DOM 序列化会触发 foster parenting 重排）。
 */
export function stripEditorArtifactsFromSource(html: string): string {
  let out = stripLegacyFreeze(html);
  // 旧版把 HTML 当纯文本写进页面，留下的游离文本 + <b> 直接铺在 <table> 前面，
  // 表现为页面左上角出现一段竖排数字。打开这类历史文件时一并清除。
  out = out.replace(
    /\n\s*[\d,.]+\s*<b>[^<]{4,}<\/b>(?=\s*<table\b)/gi,
    "\n"
  );
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) =>
    /\[data-hve-hover\]|__hve_style__|__hve_lightbox_style__/.test(block)
      ? ""
      : block
  );
  out = out.replace(/<div id="__hve_bridge__"\s*><\s*\/div\s*>/gi, "");
  out = removeEditorBarBlocks(out);
  out = out.replace(/\s+data-hve-(?:sel|hover)="[^"]*"/g, "");
  return out;
}

/**
 * 为保存的 HTML 注入灯箱 CSS+JS，使 data-original-src 图片可点击放大。
 * 作为 edit-core 与界面共用的单一来源（App.tsx 原先的内联实现已收敛到此）。
 */
export function injectLightbox(html: string): string {
  if (html.includes("__hve_lightbox_script__")) return html;
  const lightboxCode = `<style>
.hve-lightbox-overlay{position:fixed;inset:0;background:rgba(0,0,0,.92);display:flex;align-items:center;justify-content:center;z-index:999999;cursor:zoom-out}
.hve-lightbox-overlay img{max-width:95vw;max-height:95vh;box-shadow:0 8px 40px rgba(0,0,0,.5)}
.hve-lightbox-img{cursor:zoom-in;transition:opacity .2s}
.hve-lightbox-img:hover{opacity:.85}
</style>
<script id="__hve_lightbox_script__">window.__hve_openLightbox=function(e){var t=e.getAttribute("data-original-src")||e.src;var o=document.createElement("div");o.className="hve-lightbox-overlay";o.innerHTML='<img src="'+t+'">';o.onclick=function(){o.remove()};document.body.appendChild(o)}</script>\n`;
  const bodyClose = html.lastIndexOf("</body>");
  if (bodyClose !== -1) return html.slice(0, bodyClose) + lightboxCode + html.slice(bodyClose);
  return html + lightboxCode;
}

/**
 * 把 getNodePath 生成的 DOM 路径转成 CSS 选择器。
 * 路径形如 "html > body:nth-of-type(1) > div:nth-of-type(2)"，去掉根 html 后可直接用于 querySelector。
 */
export function pathToSelector(path: string): string | null {
  const segments = path
    .split(" > ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments[0]?.toLowerCase() === "html") segments.shift();
  return segments.length ? segments.join(" > ") : null;
}

const INSERT_POSITIONS: Record<
  NonNullable<HtmlEdit["insertPosition"]>,
  InsertPosition
> = {
  before: "beforebegin",
  after: "afterend",
  prepend: "afterbegin",
  append: "beforeend",
};

/**
 * 在 DOM 上应用编辑记录（用于动态渲染文件的序列化保存路径）。
 * 先一次性解析全部目标节点，避免前面的插入 / 删除影响后续 nth-of-type 定位。
 */
export function applyDomEdits(doc: Document, edits: HtmlEdit[]): void {
  const resolved = edits.map((edit) => {
    const selector = pathToSelector(edit.path);
    let el: Element | null = null;
    if (selector) {
      try {
        el = doc.querySelector(selector);
      } catch {
        el = null;
      }
    }
    return { edit, el };
  });

  for (const { edit, el } of resolved) {
    if (!el || !el.isConnected) continue; // 父节点已被删除时该编辑失效
    if (edit.remove) {
      el.remove();
    } else if (edit.outerHtml !== undefined) {
      el.outerHTML = edit.outerHtml;
    } else if (edit.appendHtml !== undefined) {
      el.insertAdjacentHTML("beforeend", edit.appendHtml);
    } else if (edit.insertHtml !== undefined && edit.insertPosition) {
      el.insertAdjacentHTML(INSERT_POSITIONS[edit.insertPosition], edit.insertHtml);
    }
  }
}

/**
 * 将 iframe 当前 DOM 状态序列化为完整 HTML 字符串。
 * 用于目标文件完全由 JS 动态渲染（源码级 patch 无法覆盖的场景）。
 * 先在文档副本上应用编辑记录，再剔除编辑器注入节点后序列化。
 */
export function serializeIframeHtml(
  doc: Document,
  edits: HtmlEdit[] = []
): string {
  const cloneDoc = doc.cloneNode(true) as Document;
  if (edits.length) applyDomEdits(cloneDoc, edits);
  const root = cloneDoc.documentElement;
  if (!root) return "";
  removeEditorArtifacts(root);
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>` : "";
  return doctype + "\n" + root.outerHTML;
}

export interface FreezeOp {
  selector: string;
  action: "text" | "attr" | "style" | "replace" | "remove" | "insert" | "block" | "innertext";
  html?: string;
  position?: InsertPosition;
  // 文本级重放：只改第 textNodeIndex 个文本节点的 nodeValue
  textFrom?: string;
  textTo?: string;
  textNodeIndex?: number;
  // 属性级重放：只改一个属性，不重放 outerHTML
  attr?: string;
  value?: string;
  // 目标标签校验，防止 selector 因结构变化漂移后误伤别的节点
  tag?: string;
  // 样式级重放：只改一个样式属性
  prop?: string;
  // 块级重放：原块的文字签名，命中元素不含它就不替换，防止选择器漂移误伤
  fromText?: string;
  // 整段文字重放：把元素内部整体换成一段纯文本
  innerText?: string;
  innerFrom?: string;
}

/** 把编辑记录转成页面加载后要重放的「固化操作」。 */
export function buildFreezeOps(edits: HtmlEdit[]): FreezeOp[] {
  const ops: FreezeOp[] = [];
  for (const edit of edits) {
    const selector = pathToSelector(edit.path);
    if (!selector) continue;
    const tag = lastTagOfPath(edit.path);
    if (edit.innerText !== undefined) {
      ops.push({
        selector,
        action: "innertext",
        tag,
        innerText: edit.innerText,
        innerFrom: edit.innerFrom,
      });
    } else if (edit.textFrom !== undefined && edit.textTo !== undefined) {
      // 文字改动一律走文本级重放，绝不序列化或重放元素
      ops.push({
        selector,
        action: "text",
        tag,
        textFrom: edit.textFrom,
        textTo: edit.textTo,
        textNodeIndex: edit.textNodeIndex ?? 0,
      });
    } else if (edit.remove) {
      ops.push({ selector, action: "remove", tag });
    } else if (edit.outerHtml !== undefined) {
      const imgTag = /^<\s*img\b/i.test(edit.outerHtml);
      const imgSrc = /\ssrc\s*=\s*(["'])([\s\S]*?)\1/i.exec(edit.outerHtml);
      if (imgTag && imgSrc) {
        ops.push({
          selector,
          action: "attr",
          tag: "img",
          attr: "src",
          value: decodeEntities(imgSrc[2]),
        });
      } else if (TABLE_TAGS.has(tag)) {
        // 结构性元素不做 outerHTML 重放，避免把整行/整格连同动态内容一起覆盖
        continue;
      } else {
        ops.push({ selector, action: "replace", tag, html: edit.outerHtml });
      }
    } else if (edit.blockHtml !== undefined) {
      ops.push({
        selector,
        action: "block",
        tag,
        html: edit.blockHtml,
        fromText: edit.blockFrom
          ? decodeEntities(edit.blockFrom.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 40)
          : undefined,
      });
    } else if (edit.attrPatches) {
      for (const p of edit.attrPatches) {
        ops.push({ selector, action: "attr", tag, attr: p.name, value: p.value ?? undefined });
      }
    } else if (edit.stylePatches) {
      for (const p of edit.stylePatches) {
        ops.push({ selector, action: "style", tag, prop: p.prop, value: p.value ?? undefined });
      }
    } else if (edit.appendHtml !== undefined) {
      ops.push({
        selector,
        action: "insert",
        tag,
        html: edit.appendHtml,
        position: "beforeend",
      });
    } else if (edit.insertHtml !== undefined && edit.insertPosition) {
      let position = INSERT_POSITIONS[edit.insertPosition];
      if (TABLE_TAGS.has(tag) && (position === "beforebegin" || position === "afterend")) {
        position = "beforeend";
      }
      ops.push({ selector, action: "insert", tag, html: edit.insertHtml, position });
    }
  }
  return ops;
}

const FREEZE_RUNNER = `<script id="__hve_freeze_script__">(function(){
  var n=document.getElementById("__hve_freeze_ops__");
  if(!n)return;
  var ops=[];
  try{ops=JSON.parse(n.textContent||"[]")}catch(e){return}
  var busy=false;
  function textNodeAt(el,index){
    var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),i=0,x;
    while((x=w.nextNode())){if(i===index)return x;i++}
    return null;
  }
  function apply(replay){
    if(busy)return;
    busy=true;
    try{
      ops.forEach(function(op){
        try{
          var el=document.querySelector(op.selector);
          if(!el)return;
          if(op.tag&&el.tagName.toLowerCase()!==op.tag)return;
          if(op.action==="innertext"){
            if(typeof op.innerText!=="string")return;
            var curAll=(el.textContent||"").replace(/\s+/g," ").trim();
            var probeAll=(op.innerFrom||"").replace(/\s+/g," ").trim().slice(0,24);
            if(probeAll&&curAll.indexOf(probeAll)===-1&&!el.getAttribute("data-hve-block-done")){
              var foundAll=null,ca=document.querySelectorAll("div,p,span,li,td,h1,h2,h3,b,strong");
              for(var ci=0;ci<ca.length;ci++){
                var ta=(ca[ci].textContent||"").replace(/\s+/g," ").trim();
                if(ta.indexOf(probeAll)!==-1){foundAll=ca[ci];break}
              }
              if(foundAll)el=foundAll;else return;
            }
            if(el.textContent!==op.innerText)el.textContent=op.innerText;
            el.setAttribute("data-hve-block-done","1");
          }else if(op.action==="text"){
            var node=textNodeAt(el,op.textNodeIndex||0);
            if(!node||node.nodeValue===op.textTo)return;
            if(op.textFrom!==undefined&&node.nodeValue!==op.textFrom){
              var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),x,alt=null;
              while((x=w.nextNode())){if(x.nodeValue===op.textFrom){alt=x;break}}
              if(alt)node=alt;
            }
            node.nodeValue=op.textTo;
          }else if(op.action==="style"){
            if(op.prop){
              var cur=el.getAttribute("style")||"";
              var sm={};cur.split(";").forEach(function(p){var i=p.indexOf(":");if(i>0){var k=p.slice(0,i).trim();sm[k]=p.slice(i+1).trim();}});
              if(op.value===undefined){delete sm[op.prop];}else{sm[op.prop]=op.value;}
              var ss=Object.keys(sm).map(function(k){return k+":"+sm[k];}).join(";");
              if(ss)el.setAttribute("style",ss);else el.removeAttribute("style");
            }
          }else if(op.action==="attr"){
            if(op.attr){
              if(op.value===undefined)el.removeAttribute(op.attr);
              else if(el.getAttribute(op.attr)!==op.value)el.setAttribute(op.attr,op.value);
            }
          }else if(op.action==="remove"){
            el.remove();
          }else if(op.action==="insert"){
            if(!replay)el.insertAdjacentHTML(op.position||"beforeend",op.html);
          }else if(op.action==="block"){
            if(typeof op.html==="string"&&el.innerHTML!==op.html){
              var probe=(op.fromText||"").slice(0,16);
              var norm=function(x){return (x.textContent||"").replace(/\s+/g," ").trim()};
              // 选择器命中元素若不含原块文字，说明路径漂移；按文字在全页找真正的目标块
              if(probe&&norm(el).indexOf(probe)===-1&&!el.getAttribute("data-hve-block-done")){
                var found=null,cands=document.querySelectorAll("div,section,ul");
                for(var ci=0;ci<cands.length;ci++){
                  if(norm(cands[ci]).indexOf(probe)!==-1&&cands[ci].children.length>1){found=cands[ci];break}
                }
                if(found)el=found;else return;
              }
              el.innerHTML=op.html;
              el.setAttribute("data-hve-block-done","1");
            }
          }else if(op.action==="replace"){
            if(typeof op.html==="string"&&el.outerHTML!==op.html)el.outerHTML=op.html;
          }
        }catch(e){}
      });
    }finally{busy=false}
  }
  function schedule(){
    setTimeout(function(){apply(false)},0);
    setTimeout(function(){apply(true)},80);
    setTimeout(function(){apply(true)},400);
  }
  if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",schedule)}
  else{schedule()}
  document.addEventListener("click",function(){
    setTimeout(function(){apply(true)},0);
    setTimeout(function(){apply(true)},80);
  },true);
})();</script>`;

function insertBeforeBodyClose(html: string, block: string): string {
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, () => block + "\n</body>")
    : html + "\n" + block;
}

/**
 * 为数据驱动页面注入「修改固化」脚本。
 * 这类页面加载时会用内嵌 JSON 重新渲染表格 / KPI，覆盖用户改过的静态内容；
 * 固化脚本在页面渲染完成后按 DOM 路径重放编辑，保证修改可见且持久。
 * 多次保存会合并已有操作，同一节点的新修改覆盖旧修改。
 */
export function injectFreezeScript(html: string, edits: HtmlEdit[]): string {
  const existing = html.match(
    /<script id="__hve_freeze_ops__"[^>]*>([\s\S]*?)<\/script>/i
  );
  let previous: FreezeOp[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing[1]) as FreezeOp[];
      // 旧版 op 没有 tag 校验字段，且用 outerHTML 重放整节点：
      // 保存时一律丢弃，避免把畸形的表格纠错结果继续固化下去。
      previous = Array.isArray(parsed)
        ? parsed.filter((op) => Boolean(op?.tag))
        : [];
    } catch {
      previous = [];
    }
  }

  const merged = new Map<string, FreezeOp>();
  for (const op of [...previous, ...buildFreezeOps(edits)]) {
    // 同一元素的不同文本节点 / 不同插入位置 / 不同样式属性互不覆盖
    const key = [
      op.selector,
      op.action,
      op.textNodeIndex ?? "",
      op.position ?? "",
      op.attr ?? "",
      op.prop ?? "",
    ].join("|");
    merged.set(key, op);
  }
  const ops = [...merged.values()];
  if (ops.length === 0) return stripLegacyFreeze(html);

  // '<' 转成 \u003c，避免内容里出现 </script> 提前闭合 JSON 节点
  const json = JSON.stringify(ops).replace(/</g, "\\u003c");
  const opsTag = `<script id="__hve_freeze_ops__" type="application/json">${json}</script>`;
  const runnerBlock = html.match(
    /<script id="__hve_freeze_script__"[\s\S]*?<\/script>/i
  );
  // 旧版 runner 只支持 outerHTML 重放，必须升级成文本级重放版本
  const runnerCurrent = Boolean(runnerBlock?.[0].includes('action==="text"'));

  let out: string;
  if (existing) {
    out = html.replace(existing[0], () => opsTag);
  } else if (runnerBlock) {
    out = html.replace(runnerBlock[0], () => opsTag + "\n" + runnerBlock[0]);
  } else {
    out = insertBeforeBodyClose(html, opsTag);
  }

  if (runnerBlock) {
    if (!runnerCurrent) out = out.replace(runnerBlock[0], () => FREEZE_RUNNER);
  } else {
    out = insertBeforeBodyClose(out, FREEZE_RUNNER);
  }
  return out;
}
