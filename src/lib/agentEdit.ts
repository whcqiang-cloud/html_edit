// 「让 Agent 修改」单字段流程（N5/N6/N13）。
// 一句话只改当前选中的字段；不明确或多件事直接拒绝，不拆候选、不自动猜（§6.3 / 风险 10）。

import {
  applyPlan,
  dryRun,
  EditPlan,
  FieldTarget,
  PatchResult,
  RollbackStore,
  ValidationReport,
  VersionLock,
} from "./editCore";

export type IntentKind = "explicit" | "ambiguous" | "multi" | "style" | "structure";

/** 结构重排类指令：把选中块重排成某种形状/结构/图表，需要 AI 生成整块新代码。 */
const STRUCTURE_PATTERN =
  /(金字塔|结构|重排|重构|层级|层次|排列成|堆叠|卡片墙|流程图|矩阵|时间轴|柱状图|条形图|折线图|饼图|曲线图|雷达图|图表|纵向|横向|竖排|横排|图形|图示|可视化|分成.*层|每层|逐层|自下而上|自上而下|第一层|第二层|第三层|第四层)/i;

/** 样式/布局类指令：交给模型产出 stylePatches，精准改开标签，不写回 HTML 文本。 */
const STYLE_PATTERN =
  /(圆形|圆角|方形|布局|排版|居中|居左|居右|对齐|颜色|改成.*色|设为.*色|字体|字号|加粗|粗体|斜体|下划线|背景|阴影|边框|间距|边距|内边距|外边距|宽度|高度|变大|变小|大小|缩放|旋转|动画|过渡|flex|grid|css|style|样式)/i;

/** 轻量意图分类：明确 / 描述含糊 / 多件事 / 结构重排 / 样式。 */
export function classifyIntent(description: string): IntentKind {
  const s = description.trim();
  if (STRUCTURE_PATTERN.test(s)) return "structure";
  if (STYLE_PATTERN.test(s)) return "style";
  if (/(同时|并且|；|分别|，把.*改成|、把)/.test(s)) return "multi";
  if (/(调高|调低|一点|好看|优化|改一下|合适|差不多|随便|尽量)/.test(s)) return "ambiguous";
  if (s.length < 4) return "ambiguous";
  return "explicit";
}

/** 计划生成器：真实实现会调用当前 Agent（CLI / HTTP / MCP 适配器）。 */
export interface PlanGenerator {
  generate(description: string, field: FieldTarget): Promise<EditPlan>;
}

/** 本地确定性生成器：直接给定新值，用于测试与结构化 diff 预览。 */
export class LocalPlanGenerator implements PlanGenerator {
  constructor(
    private next: (ft: FieldTarget) => { textTo: string } | Promise<{ textTo: string }>
  ) {}
  async generate(description: string, field: FieldTarget): Promise<EditPlan> {
    const r = await this.next(field);
    return {
      intent: description,
      intentType: "explicit",
      fieldTarget: field,
      edits: [
        {
          path: field.fieldPath,
          textFrom: field.textFrom,
          textTo: r.textTo,
          textNodeIndex: field.textNodeIndex ?? 0,
          dynamicNode: field.dynamicNode,
        },
      ],
      assertions: [{ fieldPath: field.fieldPath }],
    };
  }
}

export interface AgentEditResult {
  status: "applied" | "frozen" | "failed" | "rejected";
  reason?: string;
  plan?: EditPlan;
  dryRun?: { appliedHtml: string; report: ValidationReport };
  result?: PatchResult;
}

/** 单字段 Agent 改动：分类 → 生成 → 四层校验 → 应用。 */
export async function runAgentEdit(
  description: string,
  field: FieldTarget,
  generator: PlanGenerator,
  originalHtml: string,
  opts?: { seenKeys?: Set<string>; versions?: VersionLock; rollbacks?: RollbackStore }
): Promise<AgentEditResult> {
  const intent = classifyIntent(description);
  if (intent === "multi")
    return { status: "rejected", reason: "一句话含多件事，请分多次操作；工具不自动拆子任务" };
  if (intent === "ambiguous")
    return { status: "rejected", reason: "描述不够明确，需要补充目标值；不自动猜" };

  let plan: EditPlan;
  try {
    plan = await generator.generate(description, field);
  } catch (e) {
    return { status: "rejected", reason: "计划生成失败：" + String(e) };
  }
  if (plan.fieldTarget?.fieldPath && plan.fieldTarget.fieldPath !== field.fieldPath) {
    return { status: "rejected", reason: "生成的计划越出了当前字段" };
  }

  const dr = dryRun(plan, originalHtml, opts);
  if (!dr.report.pass) {
    return { status: "rejected", reason: "四层校验未通过", plan, dryRun: dr };
  }
  const result = applyPlan(plan, originalHtml, opts);
  return {
    status:
      result.status === "failed" || result.status === "skipped" ? "failed" : result.status,
    plan,
    dryRun: dr,
    result,
  };
}
