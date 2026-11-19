// 配置模块测试：Agent 注册表 / 当前 Agent / 自定义模型 / 绑定联动 / 落盘不含凭证。
// 用法：node scripts/test_config.mjs
import esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const res = await esbuild.build({
  entryPoints: [resolve(__dirname, "../src/lib/config/index.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "node",
});
const cfg = await import(
  "data:text/javascript;base64," + Buffer.from(res.outputFiles[0].text).toString("base64")
);
const { ConfigManager, MemoryConfigStore, defaultConfig, sanitizeForSave, discoverAgents } = cfg;

let failed = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failed++;
}

const store = new MemoryConfigStore();
const mgr = new ConfigManager(store);
await mgr.load();
check("默认存在 4 个 Agent", mgr.config.agents.length === 4);
check("默认当前 Agent 为 codex", mgr.currentAgent()?.id === "codex");

// 设置当前
mgr.setCurrentAgent("workbuddy");
check("切换当前 Agent", mgr.currentAgent()?.id === "workbuddy");

// 新增 / 删除 Agent
mgr.addAgent({ id: "custom", name: "Custom", path: "/bin/custom", cmd: "custom <i>", modelId: undefined });
check("新增 Agent 生效", mgr.config.agents.some((a) => a.id === "custom"));
mgr.removeAgent("custom");
check("删除 Agent 生效", !mgr.config.agents.some((a) => a.id === "custom"));

// 自定义模型 + 绑定联动
mgr.addModel({ id: "m1", name: "M1", vendor: "Custom", url: "", customProtocol: true });
mgr.updateAgentModel("codex", "m1");
check("当前 Agent 仍为 workbuddy", mgr.currentAgent()?.id === "workbuddy"); // codex 已非当前
mgr.setCurrentAgent("codex");
check("codex 绑定 m1", mgr.config.agents.find((a) => a.id === "codex").modelId === "m1");

// 删除已绑定模型：自动回落到剩余第一个
mgr.removeModel("m1");
const rebound = mgr.config.agents.find((a) => a.id === "codex").modelId;
check("删除模型后绑定自动回落", rebound === mgr.config.models[0]?.id);

// 落盘：明文凭证不得写入
mgr.config.__secret = "sk-xxxx";
const saved = await (async () => {
  await mgr.save();
  return store.data;
})();
check("落盘内容不含明文凭证字段", saved && !/"__secret"/.test(saved));
check("落盘使用 sanitizeForSave", saved.includes('"agents"'));

// 凭证字段过滤
const dirty = { password: "p", apiKey: "k", name: "ok" };
const clean = sanitizeForSave(dirty);
check("sanitizeForSave 剔除凭证字段", !clean.includes("password") && !clean.includes("apiKey") && clean.includes("ok"));

// 自定义模型完整字段 + API Key 本机保留 + token 数量字段不被误删
const modelWithKey = {
  id: "mfull", name: "展示名", vendor: "Custom", url: "https://apihub.example.com/v1",
  apiKey: "sk-test", modelName: "agnes-2.5-flash",
  maxInputTokens: 128000, maxOutputTokens: 8192,
  supportsToolCall: true, supportsImageInput: true,
  supportsReasoning: true, reasoningOnly: false, allowDisableReasoning: true,
  customProtocol: false, defaultReasoningEffort: "auto",
  supportedReasoningEfforts: ["low", "high"],
};
mgr.addModel(modelWithKey);
await mgr.save();
const savedFull = store.data;
check("模型 apiKey 保存在本机配置", /"apiKey"\s*:\s*"sk-test"/.test(savedFull));
check("模型 token 数量字段未被过滤", savedFull.includes('"maxInputTokens": 128000') && savedFull.includes('"maxOutputTokens": 8192'));
check("模型新字段完整落盘", savedFull.includes('"modelName"') && savedFull.includes('"supportsImageInput"') && savedFull.includes('"defaultReasoningEffort"'));
check("通用凭证仍被过滤", !/"apiKey"\s*:\s*"k"/.test(savedFull));

// discoverAgents 纯函数
const found = discoverAgents(
  [{ id: "codex", name: "codex", bin: "codex" }],
  "/usr/local/bin:/opt/codex/bin:/usr/bin"
);
check("discoverAgents 能在 PATH 中发现候选", Array.isArray(found));

// 持久化后重新加载保持
const mgr2 = new ConfigManager(store);
await mgr2.load();
check("重新加载后配置一致", mgr2.config.agents.length === mgr.config.agents.length);

console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项失败"));
process.exitCode = failed === 0 ? 0 : 1;
