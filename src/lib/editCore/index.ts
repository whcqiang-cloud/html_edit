// edit-core：双入口（人工 / 外部 Agent）共用的编辑内核。
// 负责 FieldTarget / EditPlan、单次 dry-run、四层校验、apply、版本锁与回滚。
// 纯逻辑，不依赖 React；DOM 结构比对用全局 DOMParser（浏览器与测试环境都已注入）。

import {
  applyEdits,
  findNodeRange,
  getNodePath,
  HtmlEdit,
  injectFreezeScript,
  injectLightbox,
  attrPatch,
  stylePatch,
} from "../htmlPatch";

export type FieldKind = "text" | "dynamic" | "image";

/** 字段级目标，贯穿点选、目标卡片、人工弹窗、AI 计划、应用、撤销（N1）。 */
export interface FieldTarget {
  kind: FieldKind;
  field: string; // 语义字段名：label / value / title / src ...
  fieldLabel: string; // 界面名
  fieldPath: string; // 指向字段元素本身的稳定路径
  textNodeIndex?: number; // 字段内第几个文本节点
  textFrom?: string; // 字段当前原文，作为漂移校验基线
  blockLabel?: string; // 所属块名称
  blockPath?: string; // 所属块路径，供插入/删除/撤销定位
  blockFromHtml?: string; // 选中时所属块的完整 HTML，块级重排用它校验定位
  dynamicNode?: boolean; // 页面 JS 动态生成的节点，源码无对应区间，走固化脚本重放
}

/** 声明允许影响的字段区间与字节范围（范围界定五条规则）。 */
export interface EditAssertion {
  fieldPath: string;
  byteRange?: [number, number];
}

/** 声明式改动计划；意图解析 Agent 只产出它，不生成 HTML 字符串（§6.3）。 */
export interface EditPlan {
  intent: string; // 原始话语
  intentType?: string;
  fieldTarget?: FieldTarget;
  edits: HtmlEdit[];
  assertions: EditAssertion[];
  version?: number | string; // 基线版本 / 哈希
  idempotencyKey?: string; // 幂等键
  allowFreezeFallback?: boolean; // 渲染回归软失败时是否降级固化
  timeoutMs?: number;
}

export interface LayerResult {
  ok: boolean;
  errors: string[];
}

export interface ValidationReport {
  layer1: LayerResult; // 指令合法性（硬失败）
  layer2: LayerResult; // 源码字节保真（硬失败 + 回滚）
  layer3: LayerResult; // DOM 结构等价（硬失败 + 回滚）
  layer4: LayerResult; // 渲染回归（软失败，降级固化）
  pass: boolean;
}

export type EditStatus = "applied" | "frozen" | "skipped" | "failed";

export interface PatchResult {
  status: EditStatus;
  html: string;
  summary: string;
  report: ValidationReport;
  edits: HtmlEdit[];
  version?: number;
  rollbackHandle?: string;
}

function parseDom(html: string): Document {
  const DP = (globalThis as any).DOMParser;
  if (!DP) throw new Error("editCore 需要全局 DOMParser");
  return new DP().parseFromString(html, "text/html");
}

// ---- 第三层：DOM 结构指纹（标签计数、表格行数、文本叶子数）----
function domFingerprint(html: string): { tags: Record<string, number>; rows: number; leaves: number } {
  const doc = parseDom(html);
  const tags: Record<string, number> = {};
  let rows = 0;
  let leaves = 0;
  const walk = (el: Element) => {
    tags[el.tagName.toLowerCase()] = (tags[el.tagName.toLowerCase()] || 0) + 1;
    if (el.tagName.toLowerCase() === "tr") rows++;
    for (const ch of Array.from(el.childNodes)) {
      if (ch.nodeType === 3 && (ch.nodeValue || "").trim()) leaves++;
    }
    for (const c of Array.from(el.children)) walk(c);
  };
  if (doc.body) walk(doc.body);
  return { tags, rows, leaves };
}

function sameFingerprint(
  a: string,
  b: string,
  plan: EditPlan
): { ok: boolean; errors: string[] } {
  // 块级结构重排：块内标签/文本本来就要变，不能用「结构指纹不变」判它；
  // 块外字节由 layer2 守住，块外文本漂移由 layer4 软校验兜底。
  if (plan.edits.some((e) => typeof e.blockHtml === "string")) {
    return { ok: true, errors: [] };
  }
  const fa = domFingerprint(a);
  const fb = domFingerprint(b);
  const errors: string[] = [];
  const keys = new Set([...Object.keys(fa.tags), ...Object.keys(fb.tags)]);
  for (const k of keys) {
    if ((fa.tags[k] || 0) !== (fb.tags[k] || 0)) {
      errors.push(`标签 <${k}> 数量变化：${fa.tags[k] || 0} → ${fb.tags[k] || 0}`);
    }
  }
  if (fa.rows !== fb.rows) errors.push(`表格行数变化：${fa.rows} → ${fb.rows}`);

  // 文本叶子数变化要扣除「声明的删除 / 清空」：把字段文本删成空串会少一个叶子，
  // 这是合法改动，不是结构漂移。动态节点由固化脚本重放，源码里没有叶子变化，同样允许。
  let allowedLeafDrop = 0;
  for (const edit of plan.edits) {
    if (edit.dynamicNode) continue;
    if (edit.remove) allowedLeafDrop += 1;
    else if (edit.textFrom !== undefined && edit.textTo === "") allowedLeafDrop += 1;
  }
  const leafDrop = fa.leaves - fb.leaves;
  if (leafDrop > allowedLeafDrop) {
    errors.push(`文本叶子数变化：${fa.leaves} → ${fb.leaves}（超出声明的删除数 ${allowedLeafDrop}）`);
  }
  // 叶子增加目前只允许由 insert 引起；insert 会带标签变化，已在上面 tags 校验覆盖。
  return { ok: errors.length === 0, errors };
}

// ---- 第四层：非目标区域文本是否漂移（软失败）----
function nonTargetLeavesChanged(
  originalHtml: string,
  appliedHtml: string,
  targetPaths: Set<string>
): boolean {
  const collect = (html: string) => {
    const doc = parseDom(html);
    const map: Record<string, string[]> = {};
    const walk = (el: Element) => {
      const p = getNodePath(el);
      const vals: string[] = [];
      for (const ch of Array.from(el.childNodes)) {
        if (ch.nodeType === 3) {
          const v = (ch.nodeValue || "").trim();
          if (v) vals.push(v);
        }
      }
      if (vals.length) map[p] = vals;
      for (const c of Array.from(el.children)) walk(c);
    };
    if (doc.body) walk(doc.body);
    return map;
  };
  const a = collect(originalHtml);
  const b = collect(appliedHtml);
  for (const [p, vals] of Object.entries(a)) {
    if (targetPaths.has(p)) continue;
    if (JSON.stringify(vals) !== JSON.stringify(b[p] || [])) return true;
  }
  return false;
}

// ---- 第一层：指令合法性 ----
function validateLegality(
  plan: EditPlan,
  seenKeys: Set<string>
): LayerResult {
  const errors: string[] = [];
  if (!plan.edits || plan.edits.length === 0) errors.push("计划不含任何改动");
  if (!plan.assertions || plan.assertions.length === 0)
    errors.push("缺少范围声明（assertions）");
  for (const edit of plan.edits) {
    if (!edit.path) {
      errors.push("存在无路径的改动");
      continue;
    }
    const hasText = edit.textFrom !== undefined && edit.textTo !== undefined;
    const hasRemove = edit.remove === true;
    const hasInsert = edit.insertHtml !== undefined && !!edit.insertPosition;
    const hasAttr = !!edit.attrPatches && edit.attrPatches.length > 0;
    const hasStyle = !!edit.stylePatches && edit.stylePatches.length > 0;
    const hasOuter = edit.outerHtml !== undefined;
    const hasBlock = typeof edit.blockHtml === "string";
    if (
      !hasText &&
      !hasRemove &&
      !hasInsert &&
      !hasAttr &&
      !hasStyle &&
      !hasOuter &&
      !hasBlock
    ) {
      errors.push(`改动 ${edit.path} 缺少有效指令`);
    }
    if (hasText && edit.textNodeIndex === undefined) {
      errors.push(`文字改动 ${edit.path} 缺少 textNodeIndex`);
    }
    // 字段文字改动只接受纯文本：含 HTML 标签的说明模型误解了样式/布局意图，
    // 直接硬失败，避免把源码当文本写进页面导致渲染错乱。
    if (hasText && typeof edit.textTo === "string" && /[<>]/.test(edit.textTo)) {
      errors.push(`文字改动 ${edit.path} 含 HTML 标签，已拒绝`);
    }
  }
  // 单字段范围：所有改动须落在同一字段（N13 单字段）
  const fp = plan.fieldTarget?.fieldPath;
  if (fp) {
    const allowed = new Set([fp]);
    const bp = plan.fieldTarget?.blockPath;
    if (bp) allowed.add(bp);
    for (const edit of plan.edits) {
      if (!allowed.has(edit.path)) errors.push(`改动越出当前字段：${edit.path} ≠ ${fp}`);
    }
  }
  // 幂等键去重
  if (plan.idempotencyKey) {
    if (seenKeys.has(plan.idempotencyKey)) errors.push("幂等键重复提交");
    else seenKeys.add(plan.idempotencyKey);
  }
  return { ok: errors.length === 0, errors };
}

// ---- 第二层：源码字节保真 ----
// 逐条改动比较「区间之外」的前缀与后缀内容（而非固定偏移，因为文字改动会改变长度导致偏移错位）。
function validateByteFidelity(
  plan: EditPlan,
  originalHtml: string,
  appliedHtml: string
): LayerResult {
  const errors: string[] = [];
  const doctypeO = /^<!DOCTYPE[^>]*>/i.test(originalHtml);
  const doctypeA = /^<!DOCTYPE[^>]*>/i.test(appliedHtml);
  if (doctypeO !== doctypeA) errors.push("DOCTYPE 状态变化");
  const commentsO = (originalHtml.match(/<!--/g) || []).length;
  const commentsA = (appliedHtml.match(/<!--/g) || []).length;
  if (commentsO !== commentsA) errors.push(`注释数量变化：${commentsO} → ${commentsA}`);

  for (const edit of plan.edits) {
    const rO = findNodeRange(originalHtml, edit.path);
    const rA = findNodeRange(appliedHtml, edit.path);
    if (!rO || !rA) {
      // 动态渲染节点（页面 JS 生成，源码中不存在）：无法做源码字节比对，
      // 由固化脚本在渲染后按 selector 重放，这里视为合法并跳过。
      if (edit.dynamicNode) continue;
      errors.push(
        !rO
          ? `改动路径无法在原始源码定位：${edit.path}`
          : `改动路径无法在应用后源码定位：${edit.path}`
      );
      continue;
    }
    const prefixO = originalHtml.slice(0, rO.start);
    const prefixA = appliedHtml.slice(0, rA.start);
    const suffixO = originalHtml.slice(rO.end);
    const suffixA = appliedHtml.slice(rA.end);
    if (prefixO !== prefixA || suffixO !== suffixA) {
      errors.push("改动区间之外的字节发生变化");
    }
  }
  // 断言字节范围校验
  for (const a of plan.assertions) {
    if (!a.byteRange) continue;
    const r = findNodeRange(originalHtml, a.fieldPath);
    if (!r) {
      errors.push(`断言路径无法定位：${a.fieldPath}`);
      continue;
    }
    if (r.start < a.byteRange[0] || r.end > a.byteRange[1]) {
      errors.push(`定位区间 ${r.start}-${r.end} 超出声明范围 ${a.byteRange[0]}-${a.byteRange[1]}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 四层校验。 */
export function validatePlan(
  plan: EditPlan,
  originalHtml: string,
  appliedHtml: string,
  opts?: { seenKeys?: Set<string> }
): ValidationReport {
  const seenKeys = opts?.seenKeys || new Set<string>();
  const layer1 = validateLegality(plan, seenKeys);
  const layer2 = layer1.ok
    ? validateByteFidelity(plan, originalHtml, appliedHtml)
    : { ok: false, errors: ["指令非法，跳过字节校验"] };
  const layer3 = layer1.ok
    ? sameFingerprint(originalHtml, appliedHtml, plan)
    : { ok: false, errors: ["指令非法，跳过结构校验"] };
  const targetPaths = new Set(
    plan.fieldTarget ? [plan.fieldTarget.fieldPath] : plan.edits.map((e) => e.path)
  );
  // 块级重排会改掉块内所有子元素的文本，layer4 的「非目标文本漂移」不适用；
  // 块外字节已由 layer2 守住，无需再判软失败。
  const isBlockEdit = plan.edits.some((e) => typeof e.blockHtml === "string");
  const layer4 = {
    ok: isBlockEdit || !nonTargetLeavesChanged(originalHtml, appliedHtml, targetPaths),
    errors: [] as string[],
  };
  if (!layer4.ok) layer4.errors.push("非目标区域渲染发生漂移（软失败，降级固化）");

  const hardFail = !layer1.ok || !layer2.ok || !layer3.ok;
  return {
    layer1,
    layer2,
    layer3,
    layer4,
    pass: !hardFail,
  };
}

/** 单次 dry-run：应用改动并跑四层校验，不落盘、不固化。 */
export function dryRun(
  plan: EditPlan,
  originalHtml: string,
  opts?: { seenKeys?: Set<string> }
): { appliedHtml: string; report: ValidationReport } {
  const appliedHtml = applyEdits(originalHtml, plan.edits);
  const report = validatePlan(plan, originalHtml, appliedHtml, opts);
  return { appliedHtml, report };
}

// ---- 版本锁 ----
export class VersionLock {
  private map = new Map<string, number>();
  bump(key: string): number {
    const v = (this.map.get(key) || 0) + 1;
    this.map.set(key, v);
    return v;
  }
  get(key: string): number {
    return this.map.get(key) || 0;
  }
}

// ---- 回滚存储 ----
export class RollbackStore {
  private map = new Map<string, string>();
  private seq = 0;
  save(html: string): string {
    const handle = "rb-" + Date.now().toString(36) + "-" + this.seq++;
    this.map.set(handle, html);
    return handle;
  }
  restore(handle: string): string | null {
    return this.map.get(handle) ?? null;
  }
}

/**
 * 应用计划：先 dry-run，硬失败直接返回 failed；软失败降级为固化（frozen）。
 * 成功时注入固化脚本与灯箱，返回 PatchResult。
 */
export function applyPlan(
  plan: EditPlan,
  originalHtml: string,
  opts?: { seenKeys?: Set<string>; versions?: VersionLock; rollbacks?: RollbackStore }
): PatchResult {
  const { appliedHtml, report } = dryRun(plan, originalHtml, opts);
  if (!report.pass) {
    return {
      status: "failed",
      html: originalHtml,
      summary: "四层校验未通过，已拒绝执行",
      report,
      edits: plan.edits,
    };
  }
  const rb = opts?.rollbacks?.save(originalHtml);
  let out = appliedHtml;
  // 动态渲染节点无法在源码里落改，必须走固化脚本在渲染后重放；
  // 它既可能没触发 layer4 软失败，也需要强制冻结。
  const hasDynamic = plan.edits.some((e) => e.dynamicNode);
  const freezeFallback = !report.layer4.ok || hasDynamic;
  if (freezeFallback) {
    out = injectFreezeScript(out, plan.edits);
  }
  out = injectLightbox(out);
  const version = opts?.versions?.bump(plan.fieldTarget?.fieldPath || "doc");
  return {
    status: freezeFallback ? "frozen" : "applied",
    html: out,
    summary: hasDynamic
      ? "已应用，动态渲染字段由固化脚本在页面加载后重放"
      : freezeFallback
      ? "已应用，但渲染回归软失败，已降级固化"
      : "已应用，四层校验通过",
    report,
    edits: plan.edits,
    version,
    rollbackHandle: rb,
  };
}

export { attrPatch, stylePatch, getNodePath, findNodeRange };
export type { HtmlEdit };
