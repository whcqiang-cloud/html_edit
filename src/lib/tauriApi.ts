// Tauri 文件操作封装：打开 / 保存 / 导出 HTML
// 在浏览器环境（dev 无 Tauri）下自动降级为 <input>/<a download>，保证可独立预览调试。

type OpenResult = { content: string; path: string } | null;

const isTauri = (): boolean =>
  typeof window !== "undefined" &&
  // @ts-expect-error Tauri v2 注入的全局对象
  (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__);

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
 * 保存 HTML 内容到指定路径（覆盖）。仅桌面端可用。
 */
export async function saveHtmlFile(
  path: string,
  content: string
): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  await fs.writeTextFile(path, content);
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
    await fs.writeTextFile(path, content);
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
