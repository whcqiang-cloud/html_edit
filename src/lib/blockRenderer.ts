// 块级结构重排的「安全渲染器」。
// AI 只产出结构描述或受限 HTML，这里统一解析、剔除危险内容，输出可放进页面的 HTML。
// 原则：放行展示类标签与 class/style，剔除可执行/外链/事件/跳转类内容。

const ALLOWED_TAGS = new Set([
  "div", "span", "p", "section", "article", "header", "footer", "nav", "main",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "b", "strong", "i", "em", "u", "small", "br", "hr", "figure", "figcaption",
  "img", "a", "blockquote", "pre", "code",
]);

const BANNED_ATTR_PREFIX = ["on"];
const BANNED_ATTR = new Set(["srcdoc", "formaction", "xlink:href", "id"]);
const SAFE_URL = /^(https?:\/\/|\/|\.|#|data:image\/)/i;

function safeStyle(value: string): string {
  // 去掉可能执行代码或加载外部内容的 CSS
  let out = value
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*(['"]?)\s*(javascript:|data:text\/html)[^)]*\)/gi, "")
    .replace(/@import[^;]*;?/gi, "");
  // 去掉会让新结构脱离文档流、浮在页面上的定位属性：
  // AI 画金字塔时常用 position:absolute + top/left，插进原块后就会盖在页面上而不是替换原内容。
  out = out
    .replace(/(^|;)\s*position\s*:[^;]*/gi, "$1")
    .replace(/(^|;)\s*(top|right|bottom|left)\s*:[^;]*/gi, "$1")
    .replace(/(^|;)\s*float\s*:[^;]*/gi, "$1")
    .replace(/(^|;)\s*z-index\s*:[^;]*/gi, "$1")
    .replace(/(^|;)\s*transform\s*:[^;]*/gi, "$1");
  return out.replace(/;\s*;/g, ";").replace(/^;|;$/g, "").trim();
}

function cleanNode(node: Element): void {
  for (const attr of Array.from(node.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim();
    // 剔除 class：AI 复用页面同名 class（如 bars）会继承原页面 CSS 的
    // flex-direction:column 等样式，导致新结构竖排散乱。样式一律写在 inline style 里。
    if (name === "class") {
      node.removeAttribute(attr.name);
      continue;
    }
    if (BANNED_ATTR_PREFIX.some((p) => name.startsWith(p)) || BANNED_ATTR.has(name)) {
      node.removeAttribute(attr.name);
      continue;
    }
    if ((name === "href" || name === "src") && value && !SAFE_URL.test(value)) {
      node.removeAttribute(attr.name);
      continue;
    }
    if (name === "style") {
      const cleaned = safeStyle(value);
      if (cleaned) node.setAttribute(attr.name, cleaned);
      else node.removeAttribute(attr.name);
    }
  }
  for (const child of Array.from(node.childNodes) as ChildNode[]) {
    if (child.nodeType === 1) {
      const childTag = (child as Element).tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(childTag)) {
        child.remove();
      } else {
        cleanNode(child as Element);
      }
    } else if (child.nodeType !== 3) {
      child.remove();
    }
  }
}

/**
 * 把 AI 产出的原始 HTML 清洗成安全、可插入页面的 HTML 片段。
 * 只保留白名单标签；script、iframe、事件属性、javascript 链接、外链样式等一律剔除。
 */
export function renderSafeBlockHtml(raw: string): string {
  const DP = (globalThis as any).DOMParser;
  if (!DP) throw new Error("安全渲染器需要 DOMParser");
  if (typeof raw !== "string" || !raw.trim()) throw new Error("AI 没有生成结构内容");
  if (raw.length > 200_000) throw new Error("AI 生成的结构过大，已拒绝");
  const doc = new DP().parseFromString(
    `<!DOCTYPE html><html><body><div id="__block_root">${raw}</div></body></html>`,
    "text/html"
  );
  const root = doc.getElementById("__block_root");
  if (!root) throw new Error("AI 生成的结构无法解析");
  const out: Element[] = [];
  for (const rawChild of Array.from(root.childNodes)) {
    const child = rawChild as ChildNode;
    if (child.nodeType === 1) {
      const tag = (child as Element).tagName.toLowerCase();
      if (ALLOWED_TAGS.has(tag)) {
        cleanNode(child as Element);
        out.push(child as Element);
      }
    } else if (child.nodeType === 3 && (child.nodeValue || "").trim()) {
      const span = doc.createElement("span");
      span.textContent = child.nodeValue;
      out.push(span);
    }
  }
  if (!out.length) throw new Error("AI 生成的结构清洗后为空");
  return out.map((el) => el.outerHTML).join("\n");
}

/**
 * 从当前文档里抽取「原文件的风格」：取已有 class 名与 CSS 变量/颜色，
 * 让 AI 生成的新结构沿用，而不是另起一套。
 */
/** 只给模型具体色值/字号，不给 class 名——避免它复用带冲突样式的同名 class。 */
export function collectStyleHints(doc: Document): string {
  const cssVars: string[] = [];
  const colorsAndFonts: string[] = [];
  Array.from(doc.querySelectorAll("style")).forEach((s) => {
    const text = s.textContent || "";
    const vars = text.match(/--[\w-]+\s*:\s*[^;]+/g) || [];
    vars.slice(0, 30).forEach((v) => cssVars.push(v.trim()));
    const colors = text.match(/#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)/gi) || [];
    const fonts = (text.match(/font-size\s*:\s*[\d.]+(?:px|rem|em|%)?/gi) || []).map((f) => f.replace(/\s+/g, ""));
    colors.slice(0, 12).forEach((c) => colorsAndFonts.push(c.trim()));
    fonts.slice(0, 8).forEach((f) => colorsAndFonts.push(f));
  });
  return [
    cssVars.length ? "CSS 变量：" + cssVars.join(" ; ") : "",
    colorsAndFonts.length ? "可用颜色/字号：" + colorsAndFonts.join(" ; ") : "",
  ].filter(Boolean).join("\n");
}

/**
 * 从选中块的 DOM 里提取「干净的数据清单」：每一项的标签和数值。
 * 结构重排时发给模型的应该是这份清单，而不是原块 HTML——
 * 原样发 HTML 会让模型照抄旧结构（如 bars > bar-row 一行行），
 * 用户说「旋转90度/从左到右」时它只是把旧结构换个方向，做不出正确的图表。
 */
export function collectBlockData(block: Element): string {
  const parseRow = (row: Element): string | null => {
    const text = (row.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 80) return null;
    const nums = text.match(/\d[\d,]*\.?\d*%?/g) || [];
    const label = text.replace(/\d[\d,]*\.?\d*%?/g, "").replace(/[：:·|]/g, " ").replace(/\s+/g, " ").trim();
    if (!label && !nums.length) return null;
    return `- ${label || "（未命名）"}：${nums.join(" / ") || "（无数值）"}`;
  };

  // 优先用直接子元素作为「一行一项」（如 .bars > .bar-row），信息最完整；
  // 若直接子元素是一整块文字，再退到孙子元素去找。
  const direct = Array.from(block.children) as Element[];
  const withBoth = direct
    .map(parseRow)
    .filter((s): s is string => !!s && /：\d/.test(s));
  let items = withBoth;
  if (items.length < 2) {
    const grandchildren: string[] = [];
    for (const child of direct) {
      for (const gc of Array.from(child.children) as Element[]) {
        const parsed = parseRow(gc);
        if (parsed) grandchildren.push(parsed);
      }
    }
    if (grandchildren.length > items.length) items = grandchildren;
  }
  if (!items.length) {
    items = direct.map(parseRow).filter((s): s is string => !!s);
  }
  if (!items.length) {
    const text = (block.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
    return `原块文字：${text}`;
  }
  return items.slice(0, 20).join("\n");
}
