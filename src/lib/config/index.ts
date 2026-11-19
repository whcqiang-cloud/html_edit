// 应用级全局配置：Agent 注册表、当前 Agent、自定义模型列表、Agent 与模型绑定、外部调用设置。
// 写进本机配置文件，不写进 HTML、不随文件保存；不含明文凭证（N2/N3/N4/§6.5）。

/** 思考强度：自动使用请求层默认值，或显式档位。 */
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelDef {
  id: string;
  name: string; // 显示名
  vendor: string; // 供应商；仅支持 OpenAI 兼容协议 API，自定义为 Custom
  url: string; // 接口地址（完整路径，如 https://host/v1）
  apiKey?: string; // API Key：仅存本机配置、界面掩码显示，不写进 HTML/导出
  modelName?: string; // 模型名称（请求体里的 model 字段）
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputTokensDefault?: string; // "provider" 表示使用提供商默认值
  outputTokensDefault?: string;
  supportsToolCall?: boolean;
  supportsImageInput?: boolean;
  supportsReasoning?: boolean; // 思考模式
  reasoningOnly?: boolean; // 仅思考模式
  allowDisableReasoning?: boolean; // 允许关闭思考
  customProtocol?: boolean; // 自定义协议（网关路径不标准时勾选）
  defaultReasoningEffort?: ReasoningEffort;
  supportedReasoningEfforts?: ReasoningEffort[];
}

export interface AgentDef {
  id: string;
  name: string;
  path: string; // 可执行标识或绝对路径
  cmd: string; // 调用模板
  modelId?: string; // 绑定的模型 id（未配置时为 undefined）
}

export interface ProtoSettings {
  enabled: boolean;
  mcp?: { command: string; args: string[] };
  http?: { url: string };
  cli?: { template: string };
  pathWhitelist: string[];
  activeSessions: { id: string; agent: string; startedAt: number }[];
}

export interface AppConfig {
  agents: AgentDef[];
  currentAgentId: string | null;
  models: ModelDef[];
  proto: ProtoSettings;
}

export function defaultConfig(): AppConfig {
  return {
    agents: [
      { id: "codex", name: "codex", path: "codex", cmd: "codex exec -s workspace-write <instruction>", modelId: undefined },
      { id: "workbuddy", name: "workbuddy (codebuddy)", path: "cbc", cmd: "cbc -p <instruction> -y", modelId: undefined },
      { id: "dsh", name: "DSH", path: "dsh", cmd: "dsh --plan <instruction>", modelId: undefined },
      { id: "cloud", name: "Cloud", path: "cloud-cli", cmd: "cloud edit <instruction>", modelId: undefined },
    ],
    currentAgentId: "codex",
    models: [
      { id: "ollama-qwen", name: "Ollama qwen2.5:14b", vendor: "Ollama", url: "http://127.0.0.1:11434/v1/chat/completions", maxInputTokens: 128000, maxOutputTokens: 4096, supportsToolCall: true, supportsReasoning: false },
      { id: "vision-pro", name: "vision-pro", vendor: "Custom", url: "", maxInputTokens: 32000, maxOutputTokens: 2048, supportsToolCall: true, supportsReasoning: true, customProtocol: true },
      { id: "vllm-multi", name: "vLLM 多模态", vendor: "vLLM", url: "http://localhost:8000/v1/chat/completions", maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCall: true, supportsReasoning: false },
      { id: "gateway", name: "聚合网关", vendor: "Custom", url: "", maxInputTokens: 128000, maxOutputTokens: 8192, supportsToolCall: true, supportsReasoning: true, customProtocol: true },
    ],
    proto: {
      enabled: false,
      pathWhitelist: [],
      activeSessions: [],
    },
  };
}

/** 存储抽象：桌面端用 Tauri fs，浏览器 / 测试用内存或注入实现。 */
export interface ConfigStore {
  read(): Promise<string | null>;
  write(content: string): Promise<void>;
}

/** 内存存储，供测试与浏览器降级使用。 */
export class MemoryConfigStore implements ConfigStore {
  private data: string | null = null;
  async read() {
    return this.data;
  }
  async write(content: string) {
    this.data = content;
  }
}

function isCredentialKey(k: string): boolean {
  // 按子串匹配凭证词（覆盖 __secret / apiKey / password 等），
  // 但不再把 "token" 当子串匹配，避免误删 maxInputTokens / maxOutputTokens 等数量字段。
  return /(password|secret|credential|apikey|api_key|authorization|bearer)/i.test(k) || /^token$/i.test(k);
}

/**
 * 配置落盘前校验：禁止写入明文凭证字段（§6.5 / 风险 8）。
 * 例外：models[].apiKey 属于本机应用数据，界面以密码框掩码显示，不写进 HTML/导出，
 * 但允许保存在本机配置里供 OpenAI 兼容端点调用使用。
 */
export function sanitizeForSave(raw: unknown): string {
  const json = JSON.stringify(raw, function (this: any, k: string, v: unknown) {
    if (!k) return v;
    // 保留模型定义里的 apiKey；其余位置的 apiKey 一律剔除
    if (k.toLowerCase() === "apikey" && this?.vendor !== undefined && this?.url !== undefined) {
      return v;
    }
    return isCredentialKey(k) ? undefined : v;
  }, 2);
  return json;
}

export class ConfigManager {
  private cfg: AppConfig;
  constructor(private store: ConfigStore, initial?: AppConfig) {
    this.cfg = initial ?? defaultConfig();
  }

  get config(): AppConfig {
    return this.cfg;
  }

  async load(): Promise<AppConfig> {
    const raw = await this.store.read();
    if (raw) {
      try {
        this.cfg = { ...defaultConfig(), ...JSON.parse(raw) };
      } catch {
        this.cfg = defaultConfig();
      }
    }
    return this.cfg;
  }

  async save(): Promise<void> {
    await this.store.write(sanitizeForSave(this.cfg));
  }

  currentAgent(): AgentDef | null {
    return this.cfg.agents.find((a) => a.id === this.cfg.currentAgentId) ?? null;
  }

  setCurrentAgent(id: string): void {
    if (!this.cfg.agents.some((a) => a.id === id)) return;
    this.cfg.currentAgentId = id;
  }

  addAgent(a: AgentDef): void {
    if (this.cfg.agents.some((x) => x.id === a.id)) return;
    this.cfg.agents.push(a);
    if (this.cfg.currentAgentId === null) this.cfg.currentAgentId = a.id;
  }

  removeAgent(id: string): void {
    this.cfg.agents = this.cfg.agents.filter((a) => a.id !== id);
    if (this.cfg.currentAgentId === id) {
      this.cfg.currentAgentId = this.cfg.agents[0]?.id ?? null;
    }
  }

  updateAgentModel(agentId: string, modelId: string | undefined): void {
    const a = this.cfg.agents.find((x) => x.id === agentId);
    if (a) a.modelId = modelId;
  }

  addModel(m: ModelDef): void {
    if (this.cfg.models.some((x) => x.id === m.id)) return;
    this.cfg.models.push(m);
  }

  /** 删除模型：绑定过它的 Agent 自动回落到剩余第一个或「未配置」。 */
  removeModel(id: string): void {
    this.cfg.models = this.cfg.models.filter((m) => m.id !== id);
    const fallback = this.cfg.models[0]?.id;
    for (const a of this.cfg.agents) {
      if (a.modelId === id) a.modelId = fallback;
    }
  }

  updateProto(patch: Partial<ProtoSettings>): void {
    this.cfg.proto = { ...this.cfg.proto, ...patch };
  }

  /** 合并发现的 Agent（不覆盖用户已配置的 cmd）。 */
  mergeDiscovered(discovered: AgentDef[]): void {
    for (const d of discovered) {
      if (!this.cfg.agents.some((a) => a.id === d.id)) this.cfg.agents.push(d);
    }
  }
}

/**
 * 在给定 PATH 字符串里扫描候选二进制，返回找到的 Agent 定义（纯函数，便于测试）。
 * 真实调用（启动、返回计划）属于 P1 协议层，这里只负责发现。
 */
export function discoverAgents(
  candidates: { id: string; name: string; bin: string }[],
  pathEnv: string
): AgentDef[] {
  const dirs = pathEnv.split(/[:;]/).filter(Boolean);
  const found: AgentDef[] = [];
  for (const c of candidates) {
    for (const dir of dirs) {
      const p = dir.endsWith("/") ? dir + c.bin : dir + "/" + c.bin;
      // 仅做命名匹配；真实存在性由「运行检查」在 P1 验证
      if (dir.toLowerCase().includes(c.bin.toLowerCase()) || c.bin.includes("/")) {
        found.push({ id: c.id, name: c.name, path: p, cmd: `${c.bin} <instruction>`, modelId: undefined });
        break;
      }
    }
  }
  return found;
}
