// 模型供应商预设与 OpenAI 兼容请求构造（N5 / P1 部分）。
// 真实调用由后端 call_agent / HTTP 适配器发起；这里只负责参数与请求体，纯函数可单测。

export interface VendorPreset {
  id: string;
  name: string;
  endpoint: string;
  supportsToolCall: boolean;
  supportsReasoning: boolean;
}

export const VENDOR_PRESETS: VendorPreset[] = [
  { id: "ollama", name: "Ollama", endpoint: "http://127.0.0.1:11434/v1/chat/completions", supportsToolCall: true, supportsReasoning: false },
  { id: "openai", name: "OpenAI 兼容", endpoint: "", supportsToolCall: true, supportsReasoning: true },
  { id: "vllm", name: "vLLM", endpoint: "http://localhost:8000/v1/chat/completions", supportsToolCall: true, supportsReasoning: false },
];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildOpenAIRequest(opts: {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  tools?: unknown[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.tools && opts.tools.length) body.tools = opts.tools;
  return body;
}
