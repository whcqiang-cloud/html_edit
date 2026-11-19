// CLI 适配器（N10 / P1 部分）：把外部可执行程序包装成统一的 PlanGenerator。
// 按 §6.6 契约投递指令、抽取输出里的计划块；真实子进程在 P1 由 Rust 后端拉起，
// 这里的行为（抽取、归一为 EditPlan）是可单测的纯逻辑。

import { EditPlan, FieldTarget } from "../editCore";
import { PlanGenerator } from "../agentEdit";
import { renderSafeBlockHtml } from "../blockRenderer";

export interface CliContract {
  command: string;
  args: string[];
  template: string; // 固定前缀 + <instruction> 占位符 + 输出格式约束
  timeoutMs?: number;
  cwd?: string;
}

export type Executor = (command: string, args: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<string>;

/** 从夹杂思考过程 / ANSI / Markdown 的文本里抽取计划块。 */
export function extractPlan(output: string, field: FieldTarget): EditPlan {
  // 优先找 ```json ... ``` 或 ``` ... ```
  const fence = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : output;
  // 退而求其次：抓取第一个 { ... } 对象
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  const jsonText = objMatch ? objMatch[0] : candidate;
  let parsed: any = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new Error("无法从 CLI 输出解析出计划");
  }
  const edits = [];
  const badText = (s: string) => /[<>]/i.test(s) || /<\/?[a-z][^>]*>/i.test(s);
  if (parsed.error) throw new Error("模型已拒绝该指令：" + String(parsed.error));
  if (typeof parsed.textTo === "string") {
    if (badText(parsed.textTo)) {
      throw new Error("模型返回了 HTML 标签，字段文字改动只接受纯文本；样式/布局应返回 stylePatches");
    }
    edits.push({
      path: field.fieldPath,
      textFrom: field.textFrom,
      textTo: parsed.textTo,
      textNodeIndex: field.textNodeIndex ?? 0,
      dynamicNode: field.dynamicNode,
    });
  }
  if (Array.isArray(parsed.edits)) {
    for (const e of parsed.edits) {
      if (e.path && e.path !== field.fieldPath) {
        throw new Error("生成的计划越出当前字段");
      }
      // 绝不允许 Agent 计划夹带整段 HTML / 插入 / 删除：只能改当前字段的文字或样式。
      if (e.outerHtml !== undefined || e.insertHtml !== undefined || e.remove === true) {
        throw new Error("计划包含越界的 HTML / 插入 / 删除操作，已拒绝");
      }
      if (typeof e.textTo === "string" && badText(e.textTo)) {
        throw new Error("计划含 HTML 标签，字段文字改动只接受纯文本");
      }
      edits.push({
        ...e,
        path: field.fieldPath,
        textFrom: e.textFrom ?? field.textFrom,
        textNodeIndex: e.textNodeIndex ?? field.textNodeIndex ?? 0,
        dynamicNode: field.dynamicNode,
      });
    }
  }
  // 样式级 / 属性级改动（N8）：模型给出 { stylePatches } / { attrPatches } 时走精准开标签改写，
  // 不替换文字、不序列化 DOM，避免把 HTML 当文本写进页面。
  const safeStyle = (p: any) =>
    p && typeof p.prop === "string" && /^[a-z-]+$/i.test(p.prop) &&
    (p.value === null || (typeof p.value === "string" && !badText(p.value)));
  const safeAttr = (p: any) =>
    p && typeof p.name === "string" && /^[a-z-]+$/i.test(p.name) &&
    (p.value === null || (typeof p.value === "string" && !badText(p.value)));
  // 块级结构重排：AI 产出新代码，经安全渲染器清洗后只替换选中块的内部，
  // 外层标签、属性、块外字节都不动。
  if (typeof parsed.blockHtml === "string") {
    const blockPath = field.blockPath || field.fieldPath;
    const safe = renderSafeBlockHtml(parsed.blockHtml);
    edits.push({
      path: blockPath,
      blockHtml: safe,
      blockFrom: field.blockFromHtml,
      dynamicNode: field.dynamicNode,
    });
  }
  if (Array.isArray(parsed.stylePatches)) {
    if (!parsed.stylePatches.every(safeStyle)) throw new Error("样式改动不合法（属性名或值含非法字符）");
    edits.push({ path: field.fieldPath, stylePatches: parsed.stylePatches, dynamicNode: field.dynamicNode });
  }
  if (Array.isArray(parsed.attrPatches)) {
    if (!parsed.attrPatches.every(safeAttr)) throw new Error("属性改动不合法（属性名或值含非法字符）");
    edits.push({ path: field.fieldPath, attrPatches: parsed.attrPatches, dynamicNode: field.dynamicNode });
  }
  if (edits.length === 0) throw new Error("计划不含任何改动");
  return {
    intent: parsed.intent || "",
    intentType: "agent",
    fieldTarget: field,
    edits,
    assertions: [{ fieldPath: field.fieldPath }],
  };
}

export class CliPlanGenerator implements PlanGenerator {
  constructor(private contract: CliContract, private executor?: Executor) {}

  private async run(instruction: string): Promise<string> {
    const args = this.contract.args.map((a) =>
      a.replace("<instruction>", instruction)
    );
    const cmd = this.contract.command;
    if (!this.executor) {
      // 前端不自带子进程；真实执行由 Tauri 后端（call_agent 命令）拉起 Agent 并提供执行器。
      throw new Error("未注入执行器：桌面端应由后端 call_agent 提供 CLI 输出");
    }
    return this.executor(cmd, args, {
      cwd: this.contract.cwd,
      timeoutMs: this.contract.timeoutMs,
    });
  }

  async generate(description: string, field: FieldTarget): Promise<EditPlan> {
    const output = await this.run(description);
    return extractPlan(output, field);
  }
}
