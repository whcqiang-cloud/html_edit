import { useEffect, useRef, useState } from "react";
import { openHtmlFile, saveHtmlFile, saveHtmlAs } from "./lib/tauriApi";
import { applyEdits, getNodePath, HtmlEdit } from "./lib/htmlPatch";

interface EditEntry {
  id: string;
  path: string;
  kind: "text" | "image" | "delete" | "append";
  label: string; // 人类可读描述
  edit: HtmlEdit;
  preview: string; // 改动摘要
}

export default function App() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [html, setHtml] = useState<string>(
    "<!-- 打开一个 HTML 文件开始可视化编辑 -->\n"
  );
  const [toast, setToast] = useState<string | null>(null);
  const [edits, setEdits] = useState<EditEntry[]>([]);
  const [selected, setSelected] = useState<EditEntry | null>(null);
  const [editDraft, setEditDraft] = useState<string>("");
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  // 处理 iframe 内选中的元素
  const handleSelect = (detail: {
    type: string;
    path: string;
    text?: string;
    src?: string;
    outerHtml: string;
  }) => {
    if (detail.type === "delete") {
      const entry: EditEntry = {
        id: Math.random().toString(36).slice(2),
        path: detail.path,
        kind: "delete",
        label: "删除区块",
        edit: { path: detail.path, remove: true },
        preview: "移除该元素及其全部内容",
      };
      setEdits((prev) => [...prev, entry]);
      dirtyRef.current = true;
      setToast("已标记删除，保存后生效");
      return;
    }
    setSelected({
      id: "",
      path: detail.path,
      kind: detail.type === "image" ? "image" : "text",
      label: detail.type === "image" ? "替换图片" : "编辑文字",
      edit: { path: detail.path, outerHtml: detail.outerHtml },
      preview: detail.type === "image" ? detail.src || "" : detail.text || "",
    });
    setEditDraft(detail.type === "image" ? detail.src || "" : detail.text || "");
  };

  // 打开 iframe 后注入交互脚本，并把回调函数挂到 iframe 的 window 上
  useEffect(() => {
    const el = iframeRef.current;
    if (!el) return;
    const onLoad = () => {
      const doc = el.contentDocument;
      const win = el.contentWindow;
      if (!doc || !win) return;
      injectEditorScript(doc);
      (win as any).__hve_callback = handleSelect;
    };
    el.addEventListener("load", onLoad);
    // 若已加载
    if (el.contentDocument?.readyState === "complete") onLoad();
    return () => el.removeEventListener("load", onLoad);
  }, [html]);

  function injectEditorScript(doc: Document) {
    // 避免重复注入
    if (doc.getElementById("__hve_bridge__")) return;
    const win = doc.defaultView!;

    const bridge = doc.createElement("div");
    bridge.id = "__hve_bridge__";
    doc.body.appendChild(bridge);

    const style = doc.createElement("style");
    style.textContent = `
      [data-hve-hover]{outline:1px dashed #2f6bff !important;cursor:pointer;transition:outline .1s}
      [data-hve-hover]:hover{outline:2px solid #2f6bff !important;background:rgba(47,107,255,.06)}
      [data-hve-sel]{outline:2px solid #be123c !important;background:rgba(190,18,60,.08)}
      .hve-bar{position:fixed;z-index:99999;background:#1f2329;color:#fff;border-radius:8px;
        padding:6px;display:flex;gap:6px;box-shadow:0 6px 20px rgba(0,0,0,.3);font-family:sans-serif}
      .hve-bar button{border:none;background:#2f6bff;color:#fff;border-radius:6px;padding:6px 10px;
        font-size:12px;cursor:pointer}
      .hve-bar button.del{background:#be123c}
      .hve-bar button.ghost{background:rgba(255,255,255,.15)}
    `;
    doc.head.appendChild(style);

    const skipTags = new Set([
      "html",
      "head",
      "body",
      "script",
      "style",
      "meta",
      "link",
      "title",
    ]);

    let selEl: Element | null = null;
    const bar = doc.createElement("div");
    bar.className = "hve-bar";
    bar.style.display = "none";
    doc.body.appendChild(bar);

    function showBar(el: Element, evt: MouseEvent) {
      selEl = el;
      void selEl;
      (doc as any)
        .querySelectorAll("[data-hve-sel]")
        .forEach((n: Element) => n.removeAttribute("data-hve-sel"));
      el.setAttribute("data-hve-sel", "1");
      const isImg = el.tagName.toLowerCase() === "img";
      bar.innerHTML = "";
      const editBtn = doc.createElement("button");
      editBtn.textContent = isImg ? "替换图片" : "编辑文字";
      editBtn.onclick = (e2) => {
        e2.stopPropagation();
        const detail = isImg
          ? {
              type: "image",
              path: getNodePath(el),
              src: (el as HTMLImageElement).getAttribute("src") || "",
              outerHtml: el.outerHTML,
            }
          : {
              type: "text",
              path: getNodePath(el),
              text: el.textContent || "",
              outerHtml: el.outerHTML,
            };
        (win as any).__hve_callback?.(detail);
      };
      const delBtn = doc.createElement("button");
      delBtn.textContent = "删除区块";
      delBtn.className = "del";
      delBtn.onclick = (e2) => {
        e2.stopPropagation();
        (win as any).__hve_callback?.({
          type: "delete",
          path: getNodePath(el),
          outerHtml: el.outerHTML,
        });
      };
      bar.appendChild(editBtn);
      bar.appendChild(delBtn);
      bar.style.display = "flex";
      const x = Math.min(
        evt.clientX,
        (doc.defaultView as any).innerWidth - 240
      );
      bar.style.left = x + "px";
      bar.style.top = evt.clientY + 12 + "px";
    }

    function clearHover() {
      (doc as any)
        .querySelectorAll("[data-hve-hover]")
        .forEach((n: Element) => n.removeAttribute("data-hve-hover"));
    }

    doc.addEventListener(
      "mouseover",
      (e) => {
        const t = e.target as Element;
        if (!t || t.nodeType !== 1) return;
        let el: Element | null = t;
        while (el && skipTags.has(el.tagName.toLowerCase())) el = el.parentElement;
        if (!el) return;
        clearHover();
        el.setAttribute("data-hve-hover", "1");
      },
      true
    );
    doc.addEventListener(
      "mouseout",
      () => clearHover(),
      true
    );
    doc.addEventListener(
      "click",
      (e) => {
        const t = e.target as Element;
        // 点击工具条内部不拦截，让按钮自己的 onClick 正常触发
        if (t?.closest?.(".hve-bar")) return;
        e.preventDefault();
        e.stopPropagation();
        if (!t || t.nodeType !== 1) return;
        let el: Element | null = t;
        while (el && skipTags.has(el.tagName.toLowerCase())) el = el.parentElement;
        if (!el) return;
        showBar(el, e);
      },
      true
    );

      // iframe 内按钮将调用 iframe 自己的 window.__hve_callback（由 React 注入到 contentWindow）
    (win as any).__hve_callback = (win as any).__hve_callback || null;
  }

  // 确认编辑面板中的修改
  function confirmEdit() {
    if (!selected) return;
    let newOuter = selected.edit.outerHtml || "";
    if (selected.kind === "text") {
      // 用新文字替换原元素的纯文字内容，但保留其结构：
      // 取 outerHtml，把 textContent 替换为 editDraft（保留标签/属性/子元素结构）
      const tmp = new DOMParser().parseFromString(
        selected.edit.outerHtml ?? "",
        "text/html"
      );
      const root = tmp.body.firstElementChild || tmp.body;
      // 若该元素只有文字直接替换 textContent
      root.textContent = editDraft ?? "";
      newOuter = root.outerHTML;
    } else {
      // 图片：替换 src
      const tmp = new DOMParser().parseFromString(
        selected.edit.outerHtml ?? "",
        "text/html"
      );
      const img = tmp.querySelector("img");
      if (img) {
        img.setAttribute("src", editDraft ?? "");
        newOuter = img.outerHTML;
      }
    }
    const entry: EditEntry = {
      id: "e" + Date.now() + Math.random().toString(36).slice(2, 6),
      path: selected.path,
      kind: selected.kind,
      label: selected.kind === "image" ? "替换图片" : "编辑文字",
      edit: { path: selected.path, outerHtml: newOuter },
      preview:
        selected.kind === "image"
          ? "src → " + editDraft.slice(0, 40)
          : "“" + editDraft.slice(0, 24) + "”",
    };
    setEdits((prev) => [...prev, entry]);
    dirtyRef.current = true;
    setSelected(null);
    setToast("已记录修改，保存后生效");
  }

  function removeEdit(id: string) {
    setEdits((prev) => prev.filter((e) => e.id !== id));
    dirtyRef.current = edits.length > 1;
  }

  const handleOpen = async () => {
    try {
      const res = await openHtmlFile();
      if (!res) return;
      setHtml(res.content);
      setFilePath(res.path);
      setEdits([]);
      dirtyRef.current = false;
      setToast("已打开：" + res.path.split("/").pop());
    } catch (e) {
      setToast("打开失败：" + String(e));
    }
  };

  const handleSave = async () => {
    try {
      const out = applyEdits(html, edits.map((e) => e.edit));
      if (!filePath) return handleSaveAs();
      await saveHtmlFile(filePath, out);
      setHtml(out);
      setEdits([]);
      dirtyRef.current = false;
      setToast("已保存：" + filePath.split("/").pop());
    } catch (e) {
      setToast("保存失败：" + String(e));
    }
  };

  const handleSaveAs = async () => {
    try {
      const out = applyEdits(html, edits.map((e) => e.edit));
      const path = await saveHtmlAs(
        out,
        filePath ? filePath.split("/").pop()! : "document.html"
      );
      if (path) {
        setFilePath(path);
        setHtml(out);
        setEdits([]);
        dirtyRef.current = false;
        setToast("已导出：" + path);
      }
    } catch (e) {
      setToast("导出失败：" + String(e));
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <span className="title">HTML 可视化编辑器</span>
        <span className="filepath">
          {filePath ? filePath : "未保存的新文档"}
        </span>
        <span className="hint">点击预览区任意文字/图片即可编辑</span>
        <button className="btn" onClick={handleOpen}>
          打开
        </button>
        <button className="btn" onClick={handleSave}>
          保存
        </button>
        <button className="btn primary" onClick={handleSaveAs}>
          另存为 / 导出
        </button>
      </div>

      <div className="main">
        <div className="pane preview-pane">
          <div className="pane-header">
            <span>可视化预览（点击元素编辑）</span>
          </div>
          <iframe
            className="preview-frame"
            title="preview"
            srcDoc={html}
            ref={iframeRef}
            sandbox="allow-same-origin allow-scripts"
          />
        </div>

        <div className="pane edits-pane">
          <div className="pane-header">
            <span>修改记录（{edits.length}）</span>
            {edits.length > 0 && (
              <button
                className="btn"
                style={{ marginLeft: "auto", padding: "2px 8px" }}
                onClick={() => {
                  if (confirm("确定撤销全部修改？")) {
                    setEdits([]);
                    dirtyRef.current = false;
                  }
                }}
              >
                清空
              </button>
            )}
          </div>

          {selected && (
            <div className="edit-modal">
              <div className="edit-modal-title">
                {selected.kind === "image" ? "替换图片地址" : "编辑文字内容"}
              </div>
              {selected.kind === "image" ? (
                <input
                  className="edit-input"
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  placeholder="粘贴新的图片 URL"
                />
              ) : (
                <textarea
                  className="edit-textarea"
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  rows={5}
                />
              )}
              <div className="edit-modal-actions">
                <button
                  className="btn"
                  onClick={() => {
                    setSelected(null);
                  }}
                >
                  取消
                </button>
                <button className="btn primary" onClick={confirmEdit}>
                  确定
                </button>
              </div>
            </div>
          )}

          <div className="edits-list">
            {edits.length === 0 && !selected && (
              <div className="empty-hint">
                还没有修改。
                <br />
                在左侧预览里点击一段文字或一张图片，
                <br />
                即可像改 Word 一样编辑，未改动处保持原样。
              </div>
            )}
            {edits.map((e) => (
              <div className="edit-item" key={e.id}>
                <div className="edit-item-kind">{e.label}</div>
                <div className="edit-item-preview">{e.preview}</div>
                <button
                  className="edit-item-del"
                  onClick={() => removeEdit(e.id)}
                  title="撤销该条修改"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="statusbar">
        {dirtyRef.current ? "● 有未保存修改" : "已保存"} · 原始字符数：
        {html.length} · 修改条数：{edits.length}
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
