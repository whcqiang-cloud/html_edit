import { useState, useRef, useEffect, useCallback } from "react";

// 既有编辑内核（§2 项目现有功能，原样保留）
import {
  applyEditsTracked,
  findNodeRange,
  getNodePath,
  normalizeHtml,
  injectFreezeScript,
  injectLightbox,
  stripEditorArtifactsFromSource,
  HtmlEdit,
} from "./lib/htmlPatch";
import { openHtmlFile, saveHtmlFile, saveHtmlAs, closeApp, selectLocalImage, createConfigStore, discoverAgents, agentEditFile, restoreAgentBackup, saveTempImage, AgentEditResult } from "./lib/tauriApi";
import { ConfigManager, AgentDef } from "./lib/config";
import { FieldTarget } from "./lib/editCore";
import { installSelectionBridge, SelectionBridgeApi } from "./lib/iframeBridge";


// ---- 类型（与技术方案 §5 对齐）----
type Mode = "visual" | "source" | "preview";
type View = "editor" | "settings";
type SetTab = "agent";
type InsertPos = "before" | "after" | "prepend" | "append";

interface FieldSelection {
  fieldPath: string;
  blockPath: string;
  blockLabel: string;
  field: string;
  fieldLabel: string;
  textNodeIndex: number;
  original: string;
  kind: "text" | "dynamic" | "image";
  img?: { src: string; original: string };
  // 页面 JS 渲染出来的节点在源码里没有对应区间，改动需走固化脚本重放
  dynamicNode?: boolean;
  // 可选的「整块重排」范围：从点击元素向上若干层，让用户挑要改哪一整块
  blockCandidates?: { path: string; label: string; html: string }[];
  blockIndex?: number;
}

interface Modification {
  id: number;
  fieldLabel: string;
  field: string;
  fieldPath: string;
  blockLabel: string;
  type: "text" | "image" | "insert" | "delete" | "style" | "structure";
  from?: string;
  to?: string;
  innerText?: string;
  innerFrom?: string;
  blockPath?: string;
  insertHtml?: string;
  insertPosition?: InsertPos;
  dynamicNode?: boolean;
  blockDynamic?: boolean;
  // Agent 计划产生的精确编辑（含样式/属性补丁与 dynamicNode），保存时原样重放
  edits?: HtmlEdit[];
  reverted?: boolean;
}

function App() {
  const [sourceHtml, setSourceHtml] = useState<string>("");
  const [originalHtml, setOriginalHtml] = useState<string>("");
  const [docHtml, setDocHtml] = useState<string>("");
  const [selectedField, setSelectedField] = useState<FieldSelection | null>(null);
  const [modifications, setModifications] = useState<Modification[]>([]);
  const [history, setHistory] = useState<number[]>([]);
  const [redoStack, setRedoStack] = useState<number[]>([]);
  const [hasContent, setHasContent] = useState(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>("visual");
  const [view, setView] = useState<View>("editor");
  const [frameKey, setFrameKey] = useState(0); // 每次载入文件递增，强制 iframe 重载刷新
  const setTab: SetTab = "agent";
  const [status, setStatus] = useState({ modeText: "可视化", savedText: "已保存", charCount: 0, modCount: 0, agent: "codex" });
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  // 人工修改文本框（受控）：选中字段变化时同步内容，避免停留在第一次选中的内容
  const [editText, setEditText] = useState("");
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertHtml, setInsertHtml] = useState("");
  const [insertPos, setInsertPos] = useState<InsertPos>("before");

  // 让 Agent 修改（agentic：Agent 直接改文件）
  const [agentInstruction, setAgentInstruction] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentResult, setAgentResult] = useState<{ ok: boolean; message: string; backup?: string } | null>(null);
  const [agentShot, setAgentShot] = useState<string | null>(null); // 选中截图的 data URL

  // 全局配置
  const [cfg, setCfg] = useState<ConfigManager | null>(null);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [currentAgentId, setCurrentAgentId] = useState<string | null>(null);

  // 手动添加本机 Agent
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentPath, setAgentPath] = useState("");

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const editTextRef = useRef<HTMLTextAreaElement>(null);
  const modSeq = useRef(0);
  const bridgeRef = useRef<SelectionBridgeApi | null>(null);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2200);
  }, []);

  // ---------- 配置加载 / 保存 ----------
  const refreshConfig = useCallback((m: ConfigManager) => {
    setAgents(m.config.agents.slice());
    setCurrentAgentId(m.config.currentAgentId);
    const cur = m.currentAgent();
    setStatus((s) => ({ ...s, agent: cur?.name ?? "未配置" }));
  }, []);

  useEffect(() => {
    const m = new ConfigManager(createConfigStore());
    m.load().then(() => {
      // 合并本机发现的 Agent
      discoverAgents().then((found) => {
        if (found.length) m.mergeDiscovered(found);
        setCfg(m);
        refreshConfig(m);
      });
    });
  }, [refreshConfig]);

  const saveConfig = useCallback(async (m: ConfigManager) => {
    await m.save();
    refreshConfig(m);
    toast("配置已保存（本机，不含明文凭证）");
  }, [refreshConfig]);

  // ---------- 文件加载 ----------
  const loadHtml = useCallback((html: string, path: string | null) => {
    // 打开历史文件时先自愈：清掉旧版误写入的游离文本、冻结脚本、编辑器残留
    const cleaned = stripEditorArtifactsFromSource(html);
    const normalized = normalizeHtml(cleaned);
    setSourceHtml(normalized);
    setOriginalHtml(normalized);
    const withLb = injectLightbox(injectFreezeScript(normalized, []));
    setDocHtml(withLb);
    setSelectedField(null);
    setModifications([]);
    setHistory([]);
    setRedoStack([]);
    setHasContent(true);
    setFilePath(path);
    setDirty(false);
    setMode("visual");
    setFrameKey((k) => k + 1);
    setStatus((s) => ({ ...s, savedText: "已保存", charCount: normalized.length, modCount: 0 }));
  }, []);

  const onOpen = async () => {
    const r = await openHtmlFile();
    if (r) loadHtml(r.content, r.path);
  };

  // 核心重放逻辑参数化，便于 Agent 应用时基于「包含新改动」的列表立刻写盘。
  // 手工路径仍调用 finalize()，行为与改造前完全一致。
  const finalizeWith = useCallback((mods: Modification[]): string => {
    const base = mods.length ? originalHtml : sourceHtml;
    if (!mods.length) return base;
    const edits = mods.filter((m) => !m.reverted).flatMap((m): HtmlEdit[] => {
      // Agent 计划里的样式/属性补丁必须原样重放，不能再按纯文本重建
      if (m.edits?.length) return m.edits;
      if (m.type === "text") {
        if (m.innerText !== undefined) {
          return [{ path: m.fieldPath, innerText: m.innerText, innerFrom: m.innerFrom, dynamicNode: m.dynamicNode }];
        }
        return [{ path: m.fieldPath, textFrom: m.from, textTo: m.to, textNodeIndex: 0, dynamicNode: m.dynamicNode }];
      }
      if (m.type === "image") {
        return [{ path: m.fieldPath, outerHtml: m.to, outerFrom: m.from }];
      }
      if (m.type === "insert") {
        return [{ path: m.blockPath!, insertHtml: m.insertHtml!, insertPosition: m.insertPosition }];
      }
      return [{ path: m.blockPath!, remove: true }];
    });
    const { html: out, applied } = applyEditsTracked(base, edits);
    // 静态插入已由 applyEdits 写进源码；若再把它写进固化脚本，页面加载时
    // FREEZE_RUNNER 会按 DOM 路径再插一次 → 图片/HTML 出现两份。
    // 因此只剔除「已成功写入源码的插入类 edit」的固化操作；其余 edit
    // （文字/样式/图片/删除，以及源码定位不到的动态节点）保持原有固化行为。
    const appliedSet = new Set(applied);
    const freezeEdits = edits.filter((edit) => {
      const isInsert = edit.insertHtml !== undefined || edit.appendHtml !== undefined;
      return !(isInsert && appliedSet.has(edit));
    });
    return injectLightbox(injectFreezeScript(out, freezeEdits));
  }, [originalHtml, sourceHtml]);

  const finalize = useCallback((): string => finalizeWith(modifications), [finalizeWith, modifications]);

  useEffect(() => {
    if (!hasContent) return;
    if (mode === "source") return;
    const html = finalize();
    const withLb = injectLightbox(injectFreezeScript(html, []));
    setDocHtml(withLb);
    setStatus((s) => ({ ...s, charCount: html.length, modCount: modifications.filter((m) => !m.reverted).length }));
  }, [modifications, mode, hasContent, finalize]);

  // 可视化 / 预览切换不重建 iframe，手动启停桥接：可视化拦截点击供选中，预览放行给页面自身。
  useEffect(() => {
    bridgeRef.current?.setEnabled(mode === "visual");
  }, [mode]);

  // ---------- 字段点选 ----------
  const resolveTextLeaf = (el: Element): FieldTarget => {
    let textNodeIndex = 0;
    const parent = el.parentNode as Element;
    if (parent) {
      let idx = 0;
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child === el) { textNodeIndex = idx; break; }
          idx++;
        }
      }
    }
    const blockEl = (el.closest("[data-block-el]") || el.parentElement || el) as Element;
    return {
      kind: "text",
      field: "value",
      fieldLabel: (el.textContent || "").slice(0, 12),
      fieldPath: getNodePath(el),
      textNodeIndex,
      textFrom: el.textContent || "",
      blockLabel: blockEl.getAttribute("data-block-label") || "块",
      blockPath: getNodePath(blockEl),
    };
  };

  // 由 iframe 桥接在「捕获到真实点击」后调用，构造字段选中态。
  const selectElement = (el: Element) => {
    if (mode !== "visual") return;
    const target = el as HTMLElement;
    const fieldTarget = resolveTextLeaf(target);
    const isImage = target.tagName?.toLowerCase() === "img" || !!target.querySelector("img");
    const img = (target.tagName?.toLowerCase() === "img" ? target : target.querySelector("img")) as HTMLImageElement | null;
    // 源码里找不到该路径 => 页面 JS 动态渲染的节点，只能用固化脚本重放
    const dynamicNode = !findNodeRange(sourceHtml, fieldTarget.fieldPath);
    const blockCandidates: { path: string; label: string; html: string }[] = [];
    let ancestor: Element | null = target.parentElement;
    let defaultIndex = 0;
    for (let i = 0; ancestor && i < 8 && ancestor.tagName.toLowerCase() !== "body"; i++) {
      const html = ancestor.outerHTML;
      if (html.length > 40_000) break;
      const cls = (ancestor.getAttribute("class") || "").split(/\s+/).filter(Boolean)[0] || "";
      blockCandidates.push({
        path: getNodePath(ancestor),
        label: `${ancestor.tagName.toLowerCase()}${cls ? "." + cls : ""} · ${(ancestor.textContent || "").trim().slice(0, 18)}`,
        html,
      });
      // 默认选「最小的那一组同类兄弟」：子元素必须同标签（tags.size === 1）。
      // 之前用 tags.size <= 2，会把单行 .bar-row（span + div + span）误判为一组，
      // 选中它只有一行数据；也会把含说明段落的 .card（div + p）选进来。
      // 只有同标签兄弟（如 .bars 下的 3 个 .bar-row）才是真正要整体重排的一组。
      const kids = Array.from(ancestor.children);
      const tags = new Set(kids.map((k) => k.tagName.toLowerCase()));
      if (kids.length >= 2 && kids.length <= 20 && tags.size === 1) {
        const curLen = blockCandidates[defaultIndex]?.html.length ?? Infinity;
        if (html.length < curLen) defaultIndex = blockCandidates.length - 1;
      }
      ancestor = ancestor.parentElement;
    }
    const sel: FieldSelection = {
      blockCandidates,
      blockIndex: defaultIndex,
      dynamicNode,
      fieldPath: fieldTarget.fieldPath,
      blockPath: fieldTarget.blockPath!,
      blockLabel: fieldTarget.blockLabel!,
      field: fieldTarget.field,
      fieldLabel: fieldTarget.fieldLabel,
      textNodeIndex: fieldTarget.textNodeIndex ?? 0,
      original: fieldTarget.textFrom ?? "",
      kind: isImage ? "image" : "text",
      img: img ? { src: img.getAttribute("data-original-src") || img.src, original: img.src } : undefined,
    };
    setSelectedField(sel);
    setEditText(fieldTarget.textFrom ?? "");
    setInsertOpen(false);
    setInsertHtml("");
  };

  // iframe 加载后注入点选桥接；每次 docHtml 变化会触发新的 load。
  const selectRef = useRef(selectElement);
  selectRef.current = selectElement;
  const onFrameLoad = () => {
    const frame = iframeRef.current;
    const doc = frame?.contentDocument;
    const win = frame?.contentWindow as Window | undefined;
    if (!doc || !win) return;
    bridgeRef.current = installSelectionBridge(doc, win, (el) => selectRef.current(el));
    bridgeRef.current.setEnabled(mode === "visual");
  };

  // ---------- 人工修改：文字 ----------
  const applyTextEdit = (newText: string) => {
    if (!selectedField) return;
    const mod: Modification = {
      id: ++modSeq.current,
      fieldLabel: selectedField.fieldLabel,
      field: selectedField.field,
      fieldPath: selectedField.fieldPath,
      blockLabel: selectedField.blockLabel,
      type: "text",
      from: selectedField.original,
      to: newText,
      // 人工编辑按整段文字替换：元素内可能被 <b> 分成多个文本节点，
      // 只改第一个节点会和后面的原文叠加，造成「加几个字却全乱」。
      innerText: newText,
      innerFrom: selectedField.original,
      dynamicNode: selectedField.dynamicNode,
    };
    setModifications((prev) => [...prev, mod]);
    pushHistory(mod.id);
    setDirty(true);
    setStatus((s) => ({ ...s, savedText: "有未保存修改" }));
    toast(`已记录：${selectedField.fieldLabel} → ${newText}`);
    setSelectedField((f) => (f ? { ...f, original: newText } : f));
    setEditText(newText);
  };

  const applyImageEdit = (newSrc: string) => {
    if (!selectedField || !selectedField.img) return;
    const mod: Modification = {
      id: ++modSeq.current,
      fieldLabel: selectedField.fieldLabel,
      field: selectedField.field,
      fieldPath: selectedField.fieldPath,
      blockLabel: selectedField.blockLabel,
      type: "image",
      from: selectedField.img.original,
      to: newSrc,
    };
    setModifications((prev) => [...prev, mod]);
    pushHistory(mod.id);
    setDirty(true);
    toast("已替换图片（base64）");
  };

  const applyInsert = (html: string, pos: InsertPos) => {
    if (!selectedField) return;
    // 锚定到用户实际点选的元素，不是它所属的整块。
    // 之前用 blockPath，选列表里某条 <li> 时「之后」会插到整个 <ul> 后面，
    // 看起来像跑到文档末尾；用 fieldPath 才是「当前位置」。
    const anchor = selectedField.fieldPath;
    const mod: Modification = {
      id: ++modSeq.current,
      fieldLabel: selectedField.fieldLabel,
      field: "block",
      fieldPath: anchor,
      blockLabel: selectedField.blockLabel,
      type: "insert",
      blockPath: anchor,
      insertHtml: html,
      insertPosition: pos,
    };
    setModifications((prev) => [...prev, mod]);
    pushHistory(mod.id);
    setDirty(true);
    toast("已插入 HTML（锚定所属块）");
  };

  const applyDelete = () => {
    if (!selectedField) return;
    const mod: Modification = {
      id: ++modSeq.current,
      fieldLabel: selectedField.blockLabel,
      field: "block",
      fieldPath: selectedField.blockPath,
      blockLabel: selectedField.blockLabel,
      type: "delete",
      blockPath: selectedField.blockPath,
    };
    setModifications((prev) => [...prev, mod]);
    pushHistory(mod.id);
    setDirty(true);
    toast("已标记删除（撤销可恢复）");
  };

  // ---------- 撤销 / 重做 ----------
  const pushHistory = (id: number) => setHistory((h) => [...h, id]);
  const undo = () => {
    setHistory((h) => {
      if (!h.length) return h;
      const id = h[h.length - 1];
      setModifications((prev) => prev.map((m) => (m.id === id ? { ...m, reverted: !m.reverted } : m)));
      setRedoStack((r) => [...r, id]);
      setDirty(true);
      return h.slice(0, -1);
    });
  };
  const redo = () => {
    setRedoStack((r) => {
      if (!r.length) return r;
      const id = r[r.length - 1];
      setModifications((prev) => prev.map((m) => (m.id === id ? { ...m, reverted: !m.reverted } : m)));
      setHistory((h) => [...h, id]);
      return r.slice(0, -1);
    });
  };

  // ---------- 让 Agent 修改（agentic：像桌面版「添加文件」一样交给 Agent 自己改） ----------
  // 流程：备份(后端) → 把真实文件 + 指令 + 可选截图交给本机 Agent →
  // Agent 自己读文件、修改并保存 → 前端重新读文件刷新。没有中间计划/四层校验。
  const onAgentEdit = async () => {
    const instruction = agentInstruction.trim();
    if (!instruction) { toast("请先写清楚要让 Agent 做什么"); return; }
    if (!filePath) { toast("请先用「打开文件」载入一个本地 HTML 文件"); return; }
    setAgentBusy(true);
    setAgentResult(null);
    try {
      let shotPath: string | null = null;
      if (agentShot) shotPath = await saveTempImage(agentShot);
      // 把用户当前选中的节点作为唯一权威目标传给 Agent，避免它自己猜到别的章节去。
      let selectionContext: string | null = null;
      if (selectedField) {
        const excerpt = (selectedField.original || "").replace(/\s+/g, " ").trim().slice(0, 400);
        selectionContext = [
          `- 选中元素名称：${selectedField.blockLabel || selectedField.fieldLabel || "（未命名）"}`,
          `- 选中元素字段：${selectedField.fieldLabel || selectedField.field || ""}`,
          `- 元素 DOM 路径（fieldPath）：${selectedField.fieldPath}`,
          `- 所属块 DOM 路径（blockPath）：${selectedField.blockPath}`,
          `- 选中内容原文片段：${excerpt || "（无文本，可能是一张图片或空元素）"}`,
          `- 元素类型：${selectedField.kind}${selectedField.dynamicNode ? "（JS 动态渲染节点）" : ""}`,
        ].join("\n");
      }
      const r: AgentEditResult = await agentEditFile(filePath, instruction, currentAgentId || "codex", shotPath, selectionContext);
      if (!r.ok) {
        setAgentResult({ ok: false, message: r.error || "Agent 执行失败", backup: r.backup });
        toast("Agent 修改失败：" + (r.error || "未知原因"));
        return;
      }
      // Agent 已直接改盘：重新读取文件，跳回编辑器可视化视图刷新整页
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const fresh = await readTextFile(filePath);
      loadHtml(fresh, filePath);
      setView("editor");
      setMode("visual");
      setAgentResult({ ok: true, message: r.message || "Agent 已修改并保存文件", backup: r.backup });
      toast("Agent 已直接修改并保存文件");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAgentResult({ ok: false, message: msg });
      toast("Agent 修改失败：" + msg);
    } finally {
      setAgentBusy(false);
    }
  };

  const onAgentRestore = async () => {
    if (!filePath || !agentResult?.backup) { toast("没有可用的备份"); return; }
    const r = await restoreAgentBackup(filePath, agentResult.backup);
    if (!r.ok) { toast(r.error || "还原失败"); return; }
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const fresh = await readTextFile(filePath);
    loadHtml(fresh, filePath);
    setView("editor");
    setMode("visual");
    setAgentResult(null);
    toast("已还原到 Agent 修改前");
  };

  // 把编辑记录翻译成人话：文字、样式、属性改动都要能在确认前看清
  const describeEdits = (edits: HtmlEdit[]): string => {
    const lines: string[] = [];
    for (const edit of edits) {
      if (edit.textFrom !== undefined && edit.textTo !== undefined) {
        lines.push(`文字：${edit.textFrom || "（空）"} → ${edit.textTo || "（空）"}`);
      }
      for (const p of edit.stylePatches || []) {
        lines.push(`样式：${p.prop} = ${p.value === null ? "（移除）" : p.value}`);
      }
      for (const p of edit.attrPatches || []) {
        lines.push(`属性：${p.name} = ${p.value === null ? "（移除）" : p.value}`);
      }
      if (edit.blockHtml !== undefined) lines.push(`整块重排：${edit.blockHtml.slice(0, 300)}`);
      if (edit.remove) lines.push("删除该字段");
      if (edit.outerHtml !== undefined) lines.push(`替换为：${edit.outerHtml.slice(0, 80)}`);
      if (edit.insertHtml !== undefined) lines.push(`插入：${edit.insertHtml.slice(0, 80)}`);
    }
    return lines.join("\n") || "（无可预览的改动）";
  };

  // ---------- 保存 ----------
  const onSave = async () => {
    if (!filePath) { await onSaveAs(); return; }
    const html = finalize();
    await saveHtmlFile(filePath, html);
    // 保存后新基线已包含所有改动，必须清空改动记录与历史。
    // 否则下次 finalize() 会基于新基线再次重放 insert 等改动，
    // 导致插入的图片/HTML 出现两次。
    setOriginalHtml(html);
    setSourceHtml(html);
    setModifications([]);
    setHistory([]);
    setRedoStack([]);
    setDirty(false);
    setStatus((s) => ({ ...s, savedText: "已保存", charCount: html.length, modCount: 0 }));
    toast("已保存");
  };
  const onSaveAs = async () => {
    const html = finalize();
    const p = await saveHtmlAs(html, filePath || "document.html");
    if (p) {
      // 与 onSave 同理：新文件已含所有改动，重置基线与记录，避免重复重放
      setFilePath(p);
      setOriginalHtml(html);
      setSourceHtml(html);
      setModifications([]);
      setHistory([]);
      setRedoStack([]);
      setDirty(false);
      setStatus((s) => ({ ...s, savedText: "已保存", charCount: html.length, modCount: 0 }));
      toast("已另存为 " + p);
    }
  };

  // ---------- 设置中心 ----------
  const onAddAgent = () => {
    if (!cfg) return;
    const name = agentName.trim();
    const path = agentPath.trim();
    if (!name || !path) { toast("请填写 Agent 名字和路径"); return; }
    const id = `custom_${name.replace(/\s+/g, "_")}_${Date.now()}`;
    cfg.addAgent({ id, name, path, cmd: `${path} <instruction>` });
    cfg.setCurrentAgent(id);
    saveConfig(cfg);
    setAgentName("");
    setAgentPath("");
    setAgentFormOpen(false);
    toast(`已添加 Agent：${name}`);
  };

  // ---------- 渲染 ----------
  const changeMode = (m: Mode) => {
    setMode(m);
    setStatus((s) => ({ ...s, modeText: m === "visual" ? "可视化" : m === "source" ? "源码" : "预览" }));
    if (m === "source" && sourceRef.current) sourceRef.current.value = sourceHtml;
  };

  const onSourceSave = () => {
    if (!sourceRef.current) return;
    loadHtml(sourceRef.current.value, filePath);
    changeMode("visual");
    toast("源码已载入");
  };

  return (
    <div className="app-root">
      {/* 左轨 */}
      <div className="rail">
        <button className={`rail-btn ${view === "editor" ? "active" : ""}`} onClick={() => setView("editor")}>
          <span className="ri">▦</span>编辑器
        </button>
        <button className={`rail-btn ${view === "settings" ? "active" : ""}`} onClick={() => setView("settings")}>
          <span className="ri">⚙</span>设置
        </button>
      </div>

      <div className="main">
        {/* 顶栏 */}
        <div className="topbar">
          <div className="modes">
            {(["visual", "source", "preview"] as Mode[]).map((m) => (
              <button key={m} className={`mode-btn ${mode === m ? "active" : ""}`} onClick={() => changeMode(m)} disabled={!hasContent}>
                {m === "visual" ? "可视化" : m === "source" ? "源码" : "预览"}
              </button>
            ))}
          </div>
          <div className="filepath">{filePath || "未打开 HTML 文件"}</div>
          <div className="file-actions">
            <button onClick={onOpen}>打开</button>
            <button onClick={onSave} disabled={!dirty}>保存</button>
            <button onClick={onSaveAs}>另存为 / 导出</button>
            <button onClick={() => { setHasContent(false); setView("editor"); }}>关闭文件 / 完成</button>
            <button onClick={() => closeApp().catch(() => {})}>退出</button>
          </div>
          <div className="agent-tags">
            <span className="tag">Agent：{status.agent}</span>
          </div>
        </div>

        {/* 主体：设置页不依赖是否打开 HTML，打开程序即可配置 */}
        {!hasContent && view !== "settings" ? (
          <div className="empty">
            <button className="big" onClick={onOpen}>打开 HTML 文件</button>
            <p>字段级精准编辑 · 支持人工与 Agent 两种改法</p>
          </div>
        ) : view === "editor" && hasContent ? (
          <div className="editor-layout">
            <div className="stage-wrap">
              {mode === "source" ? (
                <>
                  <div className="source-bar">
                    <button onClick={onSourceSave}>应用源码</button>
                    <span className="muted">按路径精准生效；未改字节保留</span>
                  </div>
                  <textarea ref={sourceRef} className="source-editor" defaultValue={sourceHtml} spellCheck={false} />
                </>
              ) : (
                <>
                  {mode === "visual" && (
                    <div className="mode-hint">可视化编辑：单击文字或图片可选中字段并在右栏修改；标签按钮、链接等仍可正常点击切换页面。需要完整操作页面时切到「预览」。</div>
                  )}
                  <iframe key={frameKey} ref={iframeRef} className={`stage ${mode === "preview" ? "preview" : ""}`} srcDoc={docHtml} onLoad={onFrameLoad} title="预览" />
                </>
              )}
            </div>

            {/* 右栏：上下文面板 */}
            <div className="ctx-panel">
              {selectedField ? (
                <>
                  <div className="ctx-head">目标（字段级）</div>
                  <div className="target-card">
                    <div><b>{selectedField.fieldLabel}</b> <span className="muted">· {selectedField.blockLabel}</span></div>
                    <div className="muted">路径 {selectedField.fieldPath}</div>
                  </div>
                  {!!selectedField.blockCandidates?.length && (
                    <div className="block-scope">
                      <div className="muted">整块重排范围（只有说「结构 / 金字塔 / 重排」这类指令时才用）</div>
                      <select
                        value={selectedField.blockIndex ?? 0}
                        onChange={(e) => setSelectedField((f) => (f ? { ...f, blockIndex: Number(e.target.value) } : f))}
                      >
                        {selectedField.blockCandidates.map((b, i) => (
                          <option key={b.path} value={i}>{i + 1}. {b.label}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="ctx-head">人工修改</div>
                  <div className="revert-bar">
                    <span className="muted">已修改 {modifications.filter((m) => !m.reverted).length} 处</span>
                    <button onClick={undo} disabled={!history.length}>↩ 回退上一步</button>
                    <button onClick={redo} disabled={!redoStack.length}>↪ 重做</button>
                  </div>
                  <div className="human-edit">
                    <textarea
                      ref={editTextRef}
                      className="manual-textarea"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      rows={Math.max(2, Math.min(12, Math.ceil(editText.length / 24) + 1))}
                      spellCheck={false}
                    />
                    <button onClick={() => applyTextEdit(editText)}>应用文字</button>
                    {selectedField.kind === "image" && (
                      <button onClick={async () => { const d = await selectLocalImage(); if (d) applyImageEdit(d); }}>替换图片</button>
                    )}
                    <div className="insert-row">
                      <button onClick={() => setInsertOpen((v) => !v)}>{insertOpen ? "收起插入" : "插入"}</button>
                      <select value={insertPos} onChange={(e) => setInsertPos(e.target.value as InsertPos)}>
                        <option value="before">之前</option>
                        <option value="after">之后</option>
                        <option value="prepend">开头</option>
                        <option value="append">末尾</option>
                      </select>
                    </div>
                    {insertOpen && (
                      <div className="insert-panel">
                        <button
                          onClick={async () => {
                            const dataUrl = await selectLocalImage();
                            if (dataUrl) {
                              setInsertHtml(`<img src="${dataUrl}" style="max-width:100%;height:auto">`);
                              toast("已选图片，点确认插入");
                            }
                          }}
                        >选择图片插入</button>
                        <textarea
                          className="manual-textarea"
                          value={insertHtml}
                          onChange={(e) => setInsertHtml(e.target.value)}
                          placeholder="粘贴要插入的 HTML 片段，或点上方按钮选图片"
                          rows={4}
                          spellCheck={false}
                        />
                        <button
                          disabled={!insertHtml.trim()}
                          onClick={() => {
                            applyInsert(insertHtml, insertPos);
                            setInsertHtml("");
                            setInsertOpen(false);
                          }}
                        >确认插入</button>
                      </div>
                    )}
                    <button onClick={applyDelete}>删除块</button>
                  </div>

                  <div className="ctx-head">让 Agent 修改</div>
                  <div className="agent-edit">
                    <div className="muted agent-hint">把当前 HTML 文件交给本机 Agent，像桌面版「添加文件」一样让它自己读、改、保存。修改前会自动备份，可一键还原。</div>
                    <textarea value={agentInstruction} placeholder="用一句话描述目标，例如：把三层就绪度柱状图转换为饼图，名称/数值/百分比写在每个扇形中心" onChange={(e) => setAgentInstruction(e.target.value)} />
                    <div className="agent-tools">
                      <button
                        onClick={async () => {
                          const d = await selectLocalImage();
                          if (d) { setAgentShot(d); toast("已附加截图，随指令一起交给 Agent"); }
                        }}
                      >附加截图{agentShot ? " ✓" : "（可选）"}</button>
                      {agentShot && <button onClick={() => setAgentShot(null)}>移除截图</button>}
                    </div>
                    <button className="agent-run" onClick={onAgentEdit} disabled={agentBusy}>
                      {agentBusy ? "Agent 修改中…" : "交给 Agent 修改"}
                    </button>
                    {agentResult && (
                      <div className={`agent-result ${agentResult.ok ? "ok" : "err"}`}>
                        <div>{agentResult.message}</div>
                        {agentResult.ok && agentResult.backup && (
                          <button onClick={onAgentRestore}>还原到修改前</button>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="ctx-head">修改记录（{modifications.filter((m) => !m.reverted).length}）</div>
                  <div className="mod-list">
                    {modifications.length === 0 && <div className="muted">还没有改动。点选字段后在此编辑或交给 Agent。</div>}
                    {modifications.map((m) => (
                      <div key={m.id} className={`mod-item ${m.reverted ? "reverted" : ""}`}>
                        <div><b>{m.fieldLabel}</b> · {m.type}</div>
                        {m.from !== undefined && m.to !== undefined && <div className="muted">{m.from} → {m.to}</div>}
                        {m.edits && (m.from === undefined || m.to === undefined) && <div className="muted">{describeEdits(m.edits)}</div>}
                      </div>
                    ))}
                  </div>
                  <div className="mod-actions">
                    <button onClick={undo} disabled={!history.length}>撤销</button>
                    <button onClick={redo} disabled={!redoStack.length}>重做</button>
                  </div>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="settings-view">
            <div className="set-body">
              {setTab === "agent" && (
                <div>
                  <div className="grid2">
                  <div>
                    <div className="sec-t">找到的 Agent</div>
                    <div className="agent-list">
                      {agents.map((a) => (
                        <div key={a.id} className={`agent-row ${currentAgentId === a.id ? "cur" : ""}`}>
                          <div><b>{a.name}</b> <span className="muted">{a.path}</span></div>
                          <div className="muted">{a.cmd}</div>
                          <div className="row-acts">
                            <button onClick={() => { if (cfg) { cfg.setCurrentAgent(a.id); setCurrentAgentId(a.id); saveConfig(cfg); } }}>设为当前</button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button className="add-agent-btn" onClick={() => setAgentFormOpen((v) => !v)}>
                      {agentFormOpen ? "收起添加" : "+ 添加本机 Agent"}
                    </button>
                    {agentFormOpen && (
                      <div className="insert-panel">
                        <label className="form-row">名字<input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="例如 my-agent" /></label>
                        <label className="form-row">路径<input value={agentPath} onChange={(e) => setAgentPath(e.target.value)} placeholder="/usr/local/bin/my-agent 或命令名" /></label>
                        <button disabled={!agentName.trim() || !agentPath.trim()} onClick={onAddAgent}>添加并设为当前</button>
                      </div>
                    )}
                  </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 状态栏 */}
        <div className="statusbar">
          <span>{status.modeText}</span>
          <span>{status.savedText}</span>
          <span>{status.charCount} 字符</span>
          <span>{status.modCount} 条修改</span>
          <span>Agent：{status.agent}</span>
        </div>
      </div>

      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}

export default App;
