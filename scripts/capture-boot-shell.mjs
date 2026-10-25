/**
 * 重新生成原生启动窗的位图资产：src-tauri/assets/boot-shell.png。
 *
 * 原生启动窗（src-tauri/src/splash.rs）在 WebView2 首帧出现前自绘这张图，
 * 所以它必须与 index.html 里的启动壳像素一致 —— 直接从真实渲染结果截图，
 * 而不是在 Rust 里重画一遍。改过 index.html 的启动壳样式后需要重新运行。
 *
 * 用法：
 *   1. npx tauri build --no-bundle        （或已有可用的 release 产物）
 *   2. node scripts/capture-boot-shell.mjs
 *
 * 抓的是 2 倍图：100% 缩放下按 1:1 缩小仍是清晰的，高 DPI 下也不糊。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = process.env.PIZZIC_EXE || "D:\\.cache\\rust-target\\release\\pizzic.exe";
const OUT = path.join(ROOT, "src-tauri", "assets", "boot-shell.png");
const PORT = 9223;
const CSS_WIDTH = 1360;
const CSS_HEIGHT = 880;
const SCALE = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(EXE)) throw new Error(`找不到可执行文件：${EXE}`);

const child = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

async function attach() {
  for (let i = 0; i < 1200; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(200) });
      const page = (await res.json()).find((t) => t.type === "page" && !t.url.startsWith("about:"));
      if (page) return page;
    } catch {}
    await sleep(20);
  }
  throw new Error("没能连上 WebView2 调试端口");
}

const page = await attach();
const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(page.webSocketDebuggerUrl);
  s.onopen = () => resolve(s);
  s.onerror = () => reject(new Error("调试连接失败"));
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evalJs = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send("Page.enable");
// 首屏加载完成前重载会被打断，先等它稳定。
for (let i = 0; i < 400; i++) {
  if ((await evalJs(`document.readyState`)) === "complete") break;
  await sleep(25);
}
await sleep(300);

await send("Network.enable");
// 拦掉应用主包：只留下 index.html 里的静态壳，它就不会被前端撤掉。
// 必须配合 ignoreCache 重载，否则主包会直接从缓存里跑起来。
await send("Network.setBlockedURLs", { urls: ["*/assets/index-*.js"] });

process.stdout.write("等待启动壳绘制…\n");
await send("Page.reload", { ignoreCache: true });

// 壳画出来（有两帧）之后才截图
let painted = false;
for (let i = 0; i < 400; i++) {
  painted = await evalJs(`new Promise((resolve) => {
    if (!document.getElementById("boot")) return resolve(false);
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
  })`);
  if (painted) break;
  await sleep(20);
}
if (!painted) throw new Error("启动壳没有出现，截图会是无壳画面");
// 扫光停在起始位置（不可见），原生窗口画的是静止态；
// 换成真实 webview 后动画才开始，交接时只有「动起来」这一处变化。
await evalJs(`document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; })`);
await sleep(60);

const shot = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
  clip: { x: 0, y: 0, width: CSS_WIDTH, height: CSS_HEIGHT, scale: SCALE },
});
const data = shot.result?.data;
if (!data) throw new Error("截图失败");
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.from(data, "base64"));

const size = fs.statSync(OUT).size;
const px = await evalJs(`JSON.stringify({
  boot: !!document.getElementById("boot"),
  w: innerWidth, h: innerHeight, dpr: devicePixelRatio,
})`);
console.log(`已写入 ${path.relative(ROOT, OUT)}（${(size / 1024).toFixed(1)} KB）`);
console.log(`页面状态 ${px}`);

try { ws.close(); } catch {}
child.kill();
setTimeout(() => process.exit(0), 300);
