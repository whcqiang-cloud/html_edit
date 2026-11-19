// iframe 点选桥接测试：可视化点击被拦截并回传字段，预览模式放行给页面自身。
// 用法：node scripts/test_iframe_bridge.mjs
import esbuild from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const res = await esbuild.build({
  entryPoints: [resolve(__dirname, "../src/lib/iframeBridge.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "node",
});
const mod = await import(
  "data:text/javascript;base64," + Buffer.from(res.outputFiles[0].text).toString("base64")
);
const { installSelectionBridge } = mod;

let failed = 0;
function check(name, cond) {
  console.log((cond ? "PASS " : "FAIL ") + name);
  if (!cond) failed++;
}

function makeDoc(html = "<html><head></head><body><h1>标题</h1><button id='b'>预览</button></body></html>") {
  const dom = new JSDOM(html);
  return { doc: dom.window.document, win: dom.window };
}

// 1. 桥接安装 + 幂等
{
  const { doc, win } = makeDoc();
  const a = installSelectionBridge(doc, win, () => {});
  const b = installSelectionBridge(doc, win, () => {});
  check("桥接幂等：重复安装复用同一实例", a === b);
  check("注入样式节点", !!doc.getElementById("__hve_sel_style__"));
  check("注入桥接锚点", !!doc.getElementById("__hve_sel_bridge__"));
}

// 2. 可视化模式：普通文字点击被拦截并回传；button/标签点击放行给页面自身
{
  const { doc, win } = makeDoc();
  let selected = null;
  let pageClicked = false;
  installSelectionBridge(doc, win, (el) => { selected = el; });
  const btn = doc.getElementById("b");
  btn.addEventListener("click", () => { pageClicked = true; });
  // 按钮：放行使能页面标签切换
  const btnEv = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  btn.dispatchEvent(btnEv);
  check("可视化：按钮点击不被拦截", btnEv.defaultPrevented === false);
  check("可视化：页面自身 onclick 正常触发（标签可切换）", pageClicked === true);
  check("可视化：按钮点击不选字段", selected === null);
  // 普通文字：拦截并回传
  const h1 = doc.querySelector("h1");
  const textEv = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  h1.dispatchEvent(textEv);
  check("可视化：普通文字点击被拦截", textEv.defaultPrevented === true);
  check("可视化：普通文字点击回传选中元素", selected === h1);
  check("可视化：选中元素被打标", h1.getAttribute("data-hve-sel") === "1");
}

// 2b. 带 onclick 的 div / data-target-brand-switch 也要放行（本文件的品牌切换按钮）
{
  const html = `<html><body><div id="tab" onclick="go()">标签</div><div data-target-brand-switch="NIO" id="brand">NIO</div><p id="txt">文字</p></body></html>`;
  const { doc, win } = makeDoc(html);
  let selected = null;
  installSelectionBridge(doc, win, (el) => { selected = el; });
  const tab = doc.getElementById("tab");
  const brand = doc.getElementById("brand");
  const e1 = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  tab.dispatchEvent(e1);
  const e2 = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  brand.dispatchEvent(e2);
  check("可视化：带 onclick 的标签放行", e1.defaultPrevented === false && selected === null);
  check("可视化：品牌切换按钮放行", e2.defaultPrevented === false && selected === null);
}

// 3. 悬停高亮
{
  const { doc, win } = makeDoc();
  installSelectionBridge(doc, win, () => {});
  const h1 = doc.querySelector("h1");
  h1.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));
  check("悬停：目标元素加高亮标记", h1.getAttribute("data-hve-hover") === "1");
  h1.dispatchEvent(new win.MouseEvent("mouseout", { bubbles: true }));
  check("移出：高亮标记清除", !h1.hasAttribute("data-hve-hover"));
}

// 4. 预览模式：setEnabled(false) 后点击穿透给页面自身逻辑
{
  const { doc, win } = makeDoc();
  let selected = null;
  let pageClicked = false;
  const api = installSelectionBridge(doc, win, (el) => { selected = el; });
  const btn = doc.getElementById("b");
  btn.addEventListener("click", () => { pageClicked = true; });
  api.setEnabled(false);
  check("setEnabled(false)：状态为关闭", api.isEnabled() === false);
  const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true });
  btn.dispatchEvent(ev);
  check("预览：默认行为放行（页面按钮可用）", ev.defaultPrevented === false);
  check("预览：页面自身 onclick 正常触发", pageClicked === true);
  check("预览：不回传选中字段", selected === null);
}

// 5. 重新启用 + 更新回调
{
  const { doc, win } = makeDoc();
  let who = "";
  const api = installSelectionBridge(doc, win, () => { who = "old"; });
  api.setEnabled(false);
  api.setOnSelect(() => { who = "new"; });
  api.setEnabled(true);
  const h1 = doc.querySelector("h1");
  h1.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  check("重新启用后点击再次被拦截", who === "new");
}

// 6. iframe 重载：window 上残留旧实例，但 document 是新的，必须重装监听
//     这是「第一次修改后，后面再点选还是第一次内容」的根因回归。
{
  let who = "none";
  const old = makeDoc();
  const first = installSelectionBridge(old.doc, old.win, () => { who = "old"; });
  // 模拟 iframe srcDoc 重载：新 document + 新 window，但 window 上残留旧桥接实例
  const fresh = makeDoc("<html><head></head><body><h1 id='h2'>新</h1></body></html>");
  fresh.win.__hve_sel_bridge__ = first;
  const second = installSelectionBridge(fresh.doc, fresh.win, (el) => { who = el.id || "new"; });
  check("重载后：桥接实例被换新", second !== first);
  fresh.doc.getElementById("h2").dispatchEvent(new fresh.win.MouseEvent("click", { bubbles: true, cancelable: true }));
  check("重载后：新页面点击能回传（不再停在第一次选择）", who === "h2");
  check("重载后：监听绑在新 document 上", second.boundDoc() === fresh.doc);
}

console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项失败"));
if (failed) process.exit(1);
