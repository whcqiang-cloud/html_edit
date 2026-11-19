// Tauri 文件操作封装：打开 / 保存 / 导出 HTML
// 在浏览器环境（dev 无 Tauri）下自动降级为 <input>/<a download>，保证可独立预览调试。

type OpenResult = { content: string; path: string } | null;

const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  // @ts-expect-error Tauri v2 注入的全局对象
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__);

/** Tauri 命令调用封装（仅桌面端使用）。 */
async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke(cmd, args);
}

/**
 * 打开一个 HTML 文件，返回内容与路径。
 * 桌面端用原生对话框，浏览器端用 <input type=file>。
 */
export async function openHtmlFile(): Promise<OpenResult> {
  if (isTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const selected = await dialog.open({
      multiple: false,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    const content = await fs.readTextFile(selected as string);
    return { content, path: selected as string };
  }

  // 浏览器降级
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".html,.htm,text/html";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () =>
        resolve({ content: String(reader.result ?? ""), path: file.name });
      reader.readAsText(file);
    };
    input.click();
  });
}

/**
 * 保存 HTML 内容到指定路径（覆盖）。
 * 桌面端：写本地文件；浏览器端：触发下载。
 */
export async function saveHtmlFile(
  path: string,
  content: string
): Promise<void> {
  console.log("[saveHtmlFile] 写入路径:", path, "内容长度:", content.length);
  if (!content || content.length === 0) {
    throw new Error("保存内容为空，拒绝写入");
  }
  if (isTauri()) {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.writeTextFile(path, content);
    console.log("[saveHtmlFile] 写入完成");
    return;
  }
  // 浏览器降级：触发下载
  const blob = new Blob([content], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = path.split("/").pop() || "document.html";
  a.click();
  URL.revokeObjectURL(url);
  console.log("[saveHtmlFile] 浏览器下载完成");
}

/**
 * 选择本地图片文件，返回 base64 data URL（可直接用于 <img src>）。
 * 支持 jpg / jpeg / png / gif / webp / svg / bmp / ico 等常见格式。
 * 桌面端用原生对话框，浏览器端用 <input type=file>。
 */
export async function selectLocalImage(): Promise<string | null> {
  const extensions = [
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico",
  ];

  if (isTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const selected = await dialog.open({
      multiple: false,
      filters: [{ name: "图片", extensions }],
    });
    if (!selected || Array.isArray(selected)) return null;
    const filePath = selected as string;
    console.log("[selectLocalImage] 选中文件:", filePath);
    // 读取为二进制，再转 base64（Tauri v2 用 readFile）
    const bytes = await fs.readFile(filePath);
    console.log("[selectLocalImage] 读取字节数:", bytes.length);
    const ext = filePath.split(".").pop()?.toLowerCase() || "png";
    const mime = extToMime(ext);
    const base64 = bytesToBase64(bytes);
    const dataUrl = `data:${mime};base64,${base64}`;
    console.log("[selectLocalImage] 生成 data URL 长度:", dataUrl.length);
    return dataUrl;
  }

  // 浏览器降级
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = extensions.map((e) => "." + e).join(",") + ",image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
    ico: "image/x-icon",
  };
  return map[ext] || "image/png";
}

function bytesToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  const parts: string[] = [];
  const STEP = 0x4000; // 16384 字节，远低于 V8/WebKit 的参数上限 (~65536)
  for (let i = 0; i < len; i += STEP) {
    const end = Math.min(i + STEP, len);
    const chunk = Array.from(bytes.subarray(i, end)) as number[];
    parts.push(String.fromCharCode.apply(null, chunk));
  }
  return btoa(parts.join(""));
}

/**
 * 另存为 / 导出为 HTML。桌面端弹出保存对话框，浏览器端触发下载。
 */
export async function saveHtmlAs(
  content: string,
  defaultName = "document.html"
): Promise<string | null> {
  if (isTauri()) {
    const dialog = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const path = await dialog.save({
      defaultPath: defaultName,
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (!path) return null;
    const encoder = new TextEncoder();
    await fs.writeFile(path, encoder.encode(content));
    return path;
  }

  // 浏览器降级
  const blob = new Blob([content], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(url);
  return defaultName;
}

/**
 * 退出应用：桌面端关闭当前窗口；浏览器环境由用户关闭标签页。
 */
export async function closeApp(): Promise<void> {
  if (isTauri()) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
    return;
  }
  throw new Error("浏览器环境请直接关闭标签页");
}

// ---- 应用级全局配置（N2/N3/N4）：Agent / 模型 / 外部调用 ----
// 写进本机配置文件，不写进 HTML、不随文件保存；不含明文凭证。
import type { AgentDef, ConfigStore } from "./config";

/** 读配置原始 JSON（桌面端走 Tauri 命令，浏览器走 localStorage）。 */
export async function readConfigRaw(): Promise<string | null> {
  if (isTauri()) {
    return await invoke<string | null>("read_config");
  }
  return localStorage.getItem("htmledit.config");
}

/** 写配置原始 JSON。 */
export async function writeConfigRaw(content: string): Promise<void> {
  if (isTauri()) {
    await invoke("write_config", { content });
    return;
  }
  localStorage.setItem("htmledit.config", content);
}

/** 返回一个接入真实存储的 ConfigStore（供 ConfigManager 使用）。 */
export function createConfigStore(): ConfigStore {
  return {
    read: () => readConfigRaw(),
    write: (c: string) => writeConfigRaw(c),
  };
}

/** 发现本机 / 可发现路径下的 Agent（桌面端走 Tauri 命令，浏览器返回空）。 */
export async function discoverAgents(): Promise<AgentDef[]> {
  if (isTauri()) {
    return await invoke<AgentDef[]>("discover_agents");
  }
  return [];
}

export interface AgentEditResult {
  ok: boolean;
  message?: string;
  error?: string;
  backup?: string;
  stdout?: string;
  stderr?: string;
}

/**
 * Agentic 编辑：把真实文件交给本机 Agent 自己读取、修改、保存。
 * 后端会先备份原文件，再调用 agentic CLI。改完由调用方重新读取文件刷新。
 */
export async function agentEditFile(
  filePath: string,
  instruction: string,
  agentId: string,
  screenshotPath?: string | null,
  selection?: string | null
): Promise<AgentEditResult> {
  if (isTauri()) {
    try {
      return await invoke<AgentEditResult>("agent_edit_file", {
        filePath,
        instruction,
        agentId,
        screenshotPath: screenshotPath ?? null,
        selection: selection ?? null,
      });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  return { ok: false, error: "浏览器环境不支持 Agentic 编辑，请在桌面应用中使用" };
}

/** 还原 Agent 编辑前的备份文件。 */
export async function restoreAgentBackup(
  filePath: string,
  backupPath: string
): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (isTauri()) {
    try {
      return await invoke("restore_agent_backup", { filePath, backupPath });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  return { ok: false, error: "浏览器环境不支持还原" };
}

/** 把 data URL 图片写到临时文件，返回绝对路径，供 Agent 的 -i 截图参数使用。 */
export async function saveTempImage(dataUrl: string): Promise<string | null> {
  if (!isTauri()) return null;
  const m = dataUrl.match(/^data:image\/([a-zA-Z0-9]+);base64,(.*)$/);
  if (!m) return null;
  const ext = m[1] === "jpeg" ? "jpg" : m[1];
  const b64 = m[2];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const { tempDir, join } = await import("@tauri-apps/api/path");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const name = `hve-shot-${Date.now()}.${ext}`;
  const p = await join(await tempDir(), name);
  await writeFile(p, bytes);
  return p;
}

