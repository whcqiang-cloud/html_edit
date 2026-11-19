// iframe 点选桥接：在预览文档内注入悬停高亮与点击拦截，把「可视化的点击」变成「字段选中」。
// 背景：React 的 onClick 绑在 <iframe> 元素上收不到 iframe 内部事件；
// 必须在 iframe 的 Document 上装捕获阶段监听，preventDefault 掉页面自身的按钮/链接行为，
// 再把点中的 Element 回传给 React（win.__hve_select）。预览模式通过 setEnabled(false) 关闭拦截，
// 让页面自身的按钮、链接、输入全部可正常操作。

const BRIDGE_ID = "__hve_sel_bridge__";
const STYLE_ID = "__hve_sel_style__";

const SKIP_TAGS = new Set([
  "html", "head", "body", "script", "style", "meta", "link", "title", "noscript",
]);

export interface SelectionBridgeApi {
  /** 开启/关闭点选拦截；关闭时清空高亮并让点击穿透给页面自身逻辑。 */
  setEnabled(enabled: boolean): void;
  /** 更新选中回调（React 重渲染后保持最新闭包）。 */
  setOnSelect(cb: (el: Element) => void): void;
  isEnabled(): boolean;
  /** 桥接绑定的 document；iframe 重载后用它判断是否需要重装监听。 */
  boundDoc(): Document;
}

declare global {
  interface Window {
    __hve_sel_bridge__?: SelectionBridgeApi;
  }
}

function resolveElement(target: EventTarget | null): Element | null {
  let el = target as Element | null;
  while (el && el.nodeType === 1 && SKIP_TAGS.has(el.tagName.toLowerCase())) {
    el = el.parentElement;
  }
  return el && el.nodeType === 1 ? el : null;
}

// 页面自身的交互元素：这些点击要放行给页面逻辑（标签切换、按钮、链接等），
// 不能被可视化点选拦截，否则页面看着像「静态的、点什么都没反应」。
const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "label", "summary"]);

function isInteractive(el: Element | null): boolean {
  let node = el;
  while (node && node.nodeType === 1) {
    const tag = node.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = node.getAttribute("role");
    if (
      node.hasAttribute("onclick") ||
      node.hasAttribute("onchange") ||
      node.hasAttribute("data-target-brand-switch") ||
      role === "button" ||
      role === "tab" ||
      role === "link" ||
      node.getAttribute("contenteditable") === "true"
    ) {
      return true;
    }
    if (tag === "body" || tag === "html") break;
    node = node.parentElement;
  }
  return false;
}

/**
 * 在给定的 iframe Document/Window 上安装点选桥接，幂等（重复调用复用已装实例）。
 * @param doc iframe 的 contentDocument
 * @param win iframe 的 contentWindow
 * @param onSelect 点中元素时回调
 */
export function installSelectionBridge(
  doc: Document,
  win: Window,
  onSelect: (el: Element) => void
): SelectionBridgeApi {
  const existing = win.__hve_sel_bridge__;
  // iframe 的 srcDoc 每次修改都会重载生成新 document，但旧 window 上残留着桥接实例。
  // 若实例绑定的是旧 document，事件监听也随旧文档销毁，必须重新安装，否则新页面点不动。
  if (existing && existing.boundDoc() === doc) {
    existing.setOnSelect(onSelect);
    return existing;
  }

  // 高亮样式（仅影响注入的 iframe 文档，不写回用户 HTML）
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [data-hve-hover]{outline:1px dashed #2f6bff !important;cursor:pointer}
    [data-hve-hover]:hover{outline:2px solid #2f6bff !important;background:rgba(47,107,255,.06)}
    [data-hve-sel]{outline:2px solid #be123c !important;background:rgba(190,18,60,.08)}
  `;
  (doc.head || doc.documentElement).appendChild(style);

  // 桥接锚点，防止刷新 / 重复注入时重装
  const anchor = doc.createElement("div");
  anchor.id = BRIDGE_ID;
  anchor.style.display = "none";
  (doc.body || doc.documentElement).appendChild(anchor);

  let enabled = true;
  let select = onSelect;

  const clearHover = () => {
    doc.querySelectorAll("[data-hve-hover]").forEach((n) => n.removeAttribute("data-hve-hover"));
  };
  const clearSelected = () => {
    doc.querySelectorAll("[data-hve-sel]").forEach((n) => n.removeAttribute("data-hve-sel"));
  };

  doc.addEventListener(
    "mouseover",
    (e) => {
      if (!enabled) return;
      const el = resolveElement(e.target);
      if (!el || el.closest(`#${BRIDGE_ID}`)) return;
      if (isInteractive(el)) return;
      clearHover();
      el.setAttribute("data-hve-hover", "1");
    },
    true
  );

  doc.addEventListener("mouseout", () => { if (enabled) clearHover(); }, true);

  doc.addEventListener(
    "click",
    (e) => {
      if (!enabled) return;
      const t = e.target as Element | null;
      if (t?.closest?.(`#${BRIDGE_ID}`)) return; // 点桥接节点本身不拦截
      const el = resolveElement(e.target);
      // 标签按钮、链接、输入框等交给页面自己处理，否则标签切不动、页面像静态的
      if (!el || isInteractive(el)) return;
      // 普通文字/内容：拦截页面自身行为，改为选中字段
      e.preventDefault();
      e.stopPropagation();
      clearSelected();
      el.setAttribute("data-hve-sel", "1");
      select(el);
    },
    true
  );

  const api: SelectionBridgeApi = {
    setEnabled(v: boolean) {
      enabled = v;
      if (!v) { clearHover(); clearSelected(); }
    },
    setOnSelect(cb: (el: Element) => void) { select = cb; },
    isEnabled() { return enabled; },
    boundDoc() { return doc; },
  };
  win.__hve_sel_bridge__ = api;
  return api;
}
