#!/usr/bin/env node
/** 合成資料的產品 UI 驗收；只用 Node／CDP，不把 token 寫入 URL 或報告。 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const mode = process.argv[2];
if (!["standalone", "packaged"].includes(mode)) throw new Error("用法：node scripts/video-ui-acceptance/run.mjs standalone|packaged");
const run = path.join(repo, ".tmp", "video-ui-acceptance", `${mode}-${Date.now()}-${randomBytes(3).toString("hex")}`);
const root = path.join(run, "root");
const source = process.env.MNEMOSHELF_UI_SYNTHETIC_ROOT ?? path.join(repo, ".tmp", "video-d2", "root-mixed");
const token = randomBytes(32).toString("hex") + "=";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withDeadline(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer); }
}
const report = { mode, startedAt: new Date().toISOString(), steps: [], ok: false, normalShutdown: false };
let child, service, browser, page, inspectorUrl, coreOrigin;
let launchOutput = "";
let childClosed = false;
await fs.mkdir(run, { recursive: true });

function openCdp(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const events = [];
    let next = 0;
    const timer = setTimeout(() => { socket.close(); reject(new Error("CDP 連線逾時")); }, 5000);
    socket.addEventListener("error", (event) => { clearTimeout(timer); reject(new Error(`無法連線 CDP：${event.message ?? event.error?.message ?? "unknown"}`)); }, { once: true });
    socket.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.method === "Network.responseReceived") events.push({ type: "response", id: msg.params.requestId, url: msg.params.response.url, status: msg.params.response.status });
      if (msg.method === "Network.requestWillBeSent") events.push({ type: "request", id: msg.params.requestId, url: msg.params.request.url, headers: msg.params.request.headers });
      if (msg.method === "Network.requestWillBeSentExtraInfo") events.push({ type: "request-extra", id: msg.params.requestId, url: "", headers: msg.params.headers });
      const waiter = pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result); }
    });
    socket.addEventListener("close", () => {
      for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("CDP 已斷線")); }
      pending.clear();
    });
    socket.addEventListener("open", () => { clearTimeout(timer); resolve({ events, send(method, params = {}) {
      const id = ++next;
      return new Promise((yes, no) => {
        const timeout = setTimeout(() => { pending.delete(id); no(new Error(`CDP ${method} 逾時`)); }, 30_000);
        pending.set(id, { resolve: yes, reject: no, timer: timeout });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch (error) { clearTimeout(timeout); pending.delete(id); no(error); }
      });
    }, close() { socket.close(); } }); }, { once: true });
  });
}
async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "DOM 操作失敗");
  return result.result.value;
}
async function wait(expression, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { if (await evaluate(expression)) return; } catch {} await sleep(250); }
  throw new Error(`UI 等待逾時：${expression.slice(0, 200)}`);
}
async function click(text, scope = "document") {
  const code = `(() => {const b=[...${scope}.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}&&!x.disabled);if(!b)return false;b.click();return true})()`;
  await wait(code);
}
async function fill(selector, value) {
  const code = `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`;
  await wait(code);
}
async function shot(name) {
  const dom = await evaluate("document.body.innerText");
  let image;
  try { image = await page.send("Page.captureScreenshot", { format: "png" }); }
  catch (error) {
    report.steps.push({ name: `${name}-screenshot-retry`, error: String(error?.message ?? error) });
    await sleep(250);
    image = await page.send("Page.captureScreenshot", { format: "png" });
  }
  await fs.writeFile(path.join(run, `${name}.png`), Buffer.from(image.data, "base64"));
  report.steps.push({ name, screenshot: `${name}.png`, dom: String(dom).replaceAll(root, "<synthetic-root>").replaceAll(token, "[redacted]").replaceAll(encodeURIComponent(token), "[redacted]").slice(0, 16000) });
}
async function linkModelTree(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (entry.isDirectory()) await linkModelTree(src, dst);
    else if (entry.isFile()) {
      try { await fs.link(src, dst); }
      catch (error) { if (!["EXDEV", "EPERM", "EACCES"].includes(error.code)) throw error; await fs.copyFile(src, dst); }
    } else throw new Error("模型快取含非一般檔案，拒絕複製");
  }
}
async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function recordBuildEvidence(app) {
  const manifestSetting = process.env.VIDEO_UI_BUILD_MANIFEST;
  if (!manifestSetting || path.isAbsolute(manifestSetting)) throw new Error("packaged 需以 VIDEO_UI_BUILD_MANIFEST 指定 repo 內相對路徑");
  const manifestPath = path.resolve(repo, manifestSetting);
  const relative = path.relative(repo, manifestPath);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("build manifest 必須在 repo 內");
  const bytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8"));
  const resources = path.join(path.dirname(app), "resources");
  const files = [path.join(resources, "app.asar"), path.join(resources, "bin", "ffmpeg.exe"), path.join(resources, "bin", "ffprobe.exe")];
  const verified = [];
  for (const file of files) {
    const key = path.relative(repo, file);
    const expected = manifest.packaged?.[key]?.sha256;
    const actual = await hashFile(file);
    if (typeof expected !== "string" || actual !== expected) throw new Error("packaged 產物與 build manifest hash 不符");
    verified.push({ file: path.relative(resources, file), sha256: actual });
  }
  report.buildEvidence = { manifest: relative, sha256: createHash("sha256").update(bytes).digest("hex"), head: manifest.head, verified };
}
async function launch() {
  let coreUrl, browserUrl;
  const modelCache = process.env.MNEMOSHELF_MODEL_DIR ?? path.join(repo, ".tmp", "media-feasibility", "models");
  const modelBase = path.join(modelCache, "onnx-community", "embeddinggemma-2-ONNX");
  for (const parts of [["config.json"], ["tokenizer.json"], ["tokenizer_config.json"], ["preprocessor_config.json"], ...["model", "vision_encoder", "audio_encoder"].flatMap((name) => [["onnx", `${name}_q4.onnx`], ["onnx", `${name}_q4.onnx_data`]])]) {
    const info = await fs.stat(path.join(modelBase, ...parts));
    if (!info.isFile() || info.size === 0) throw new Error("模型快取必要檔缺失或為空");
  }
  const isolatedModels = mode === "packaged" ? path.join(run, "user-data", "models") : path.join(run, "models");
  await linkModelTree(modelCache, isolatedModels);
  if (mode === "standalone") {
    const modulePath = path.join(repo, "packages", "server", "dist", "index.js");
    const { createServer } = await import(pathToFileURL(modulePath).href);
    service = await createServer({ token, dataDir: path.join(run, "data"), port: 0, webDir: path.join(repo, "packages", "web", "dist"), env: { ...process.env, MNEMOSHELF_MODEL_DIR: isolatedModels, MNEMOSHELF_AGENT_DISCOVERY: "off" } });
    coreUrl = service.url;
    const chrome = process.env.MNEMOSHELF_UI_CHROME ?? path.join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe");
    child = spawn(chrome, [`--user-data-dir=${path.join(run, "chrome")}`, "--remote-debugging-port=0", "--no-first-run", "--headless=new", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", coreUrl], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } else {
    const app = process.env.MNEMOSHELF_UI_PACKAGED ?? path.join(repo, "packages", "desktop", "dist-app", "win-unpacked", "mnemoshelf.exe");
    await recordBuildEvidence(app);
    const cleanEnv = { ...process.env };
    for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "MNEMOSHELF_FFMPEG_PATH", "MNEMOSHELF_FFPROBE_PATH", "MNEMOSHELF_FFMPEG_DIR"]) delete cleanEnv[key];
    report.windowMode = "visible-isolated";
    child = spawn(app, ["--remote-debugging-port=0", "--inspect=0", "--autoplay-policy=no-user-gesture-required"], { cwd: path.dirname(app), env: { ...cleanEnv, MNEMOSHELF_DESKTOP_USER_DATA: path.join(run, "user-data"), MNEMOSHELF_TOKEN: token, MNEMOSHELF_PORT: "0", MNEMOSHELF_EMBED_DEVICE: "cpu" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  }
  child.once("close", () => { childClosed = true; });
  child.stdout.on("data", (b) => { launchOutput += b; });
  child.stderr.on("data", (b) => { launchOutput += b; });
  child.once("error", (err) => { launchOutput += ` launch error: ${err.message}`; });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const ws = /DevTools listening on (ws:\/\/[^\s]+)/.exec(launchOutput)?.[1];
    const core = /Core 服務已啟動：(http:\/\/[^\s（]+)/.exec(launchOutput)?.[1];
    inspectorUrl = /Debugger listening on (ws:\/\/[^\s]+)/.exec(launchOutput)?.[1];
    if (mode === "packaged") coreUrl = core;
    if (ws && coreUrl && (mode !== "packaged" || inspectorUrl)) { browserUrl = ws; break; }
    if (child.exitCode !== null) throw new Error("程式啟動後退出");
    await sleep(250);
  }
  if (!browserUrl || !coreUrl) throw new Error("啟動逾時：沒有產品服務或 CDP");
  coreOrigin = coreUrl;
  browser = await openCdp(browserUrl);
  const cdpBase = new URL(browserUrl); cdpBase.protocol = "http:"; cdpBase.pathname = "/json/list";
  let target;
  for (let i = 0; i < 240 && !target; i++) {
    const response = await fetch(cdpBase, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) target = (await response.json()).find((item) => item.type === "page" && item.url.startsWith(coreUrl));
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("找不到產品 renderer");
  page = await openCdp(target.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send("Network.enable");
  if (mode === "standalone") { await fill("#mnemoshelf-token", token); await click("連線"); }
  await wait("document.body.innerText.includes('已連線到本機服務')");
}

async function search(query, predicate) {
  await fill("#mnemoshelf-search-query", query);
  await click("搜尋", "document.querySelector('form')");
  await wait(`document.body.innerText.includes('共 ') && [...document.querySelectorAll('li button')].some(b=>${predicate})`, 600_000);
}
try {
  report.runnerSha256 = await hashFile(fileURLToPath(import.meta.url));
  await fs.cp(source, root, { recursive: true, errorOnExist: true });
  await launch();
  if (process.env.MNEMOSHELF_UI_LAUNCH_ONLY === "1") {
    report.launchOnly = true;
    await shot("00-launch");
    report.uiFlowPassed = false;
  } else {
  await click("加入");
  await fill("input[placeholder^='例如']", root);
  for (const label of ["這個資料夾含照片", "這個資料夾含音訊", "這個資料夾含影片"]) {
    const ok = await evaluate(`(() => {const label=[...document.querySelectorAll('label')].find(x=>x.textContent.includes(${JSON.stringify(label)}));const box=label?.querySelector('input[type=checkbox]');if(!box||box.disabled)return false;if(!box.checked)box.click();return true})()`);
    if (!ok) throw new Error(`無法啟用 ${label}`);
  }
  await click("加入並預覽");
  await wait("document.body.innerText.includes('影片候選：') && [...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='開始索引'&&!b.disabled)");
  await shot("01-preview");
  await click("開始索引");
  const indexDeadline = Date.now() + 900_000;
  while (Date.now() < indexDeadline && !page.events.some((event) => /\/roots\/\d+\/index$/.test(event.url) && event.status === 200)) await sleep(500);
  if (!page.events.some((event) => /\/roots\/\d+\/index$/.test(event.url) && event.status === 200)) throw new Error("索引請求未成功完成");
  await wait("document.body.innerText.includes('已連線到本機服務') && !document.body.innerText.includes('正在建立索引')", 120_000);
  const diagnosticsResponse = await fetch(new URL("/diagnostics", coreOrigin), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!diagnosticsResponse.ok) throw new Error("無法讀取索引後 diagnostics");
  const diagnostics = await diagnosticsResponse.json();
  report.embedderRuntime = diagnostics.embedderRuntime;
  if (mode === "packaged" && (diagnostics.embedderRuntime?.loaded !== true || diagnostics.embedderRuntime?.device !== "cpu")) throw new Error("packaged 模型未確認已載入 CPU");
  await shot("02-indexed");
  await click("搜尋", "document.querySelector('nav')");
  await click("向量 vector");
  const cases = [
    ["星空 番茄炒蛋 列車月台", "notes.txt", "檔案・text"],
    ["深藍色背景上有一顆黃色圓形", "starry-circle.png", "檔案・image"],
    ["番茄炒蛋的烹飪做法，最後加鹽調味", "t01.wav", "音訊片段"],
    ["深藍色星空背景上有一顆黃色圓形緩慢移動", "v01.mp4", "影片畫面"],
  ];
  for (let i = 0; i < cases.length; i++) {
    const [query, file, label] = cases[i];
    const predicate = `b.textContent.includes(${JSON.stringify(file)})&&b.textContent.includes(${JSON.stringify(label)})`;
    await search(query, predicate);
    await shot(`03-search-${i}`);
    if (i < 3) {
      await wait(`(() => {const b=[...document.querySelectorAll('li button')].find(b=>${predicate});if(!b)return false;b.click();return true})()`);
      await wait(`document.querySelector('li button[aria-current="true"]')?.textContent.includes(${JSON.stringify(file)})`);
      const ready = ["!!document.querySelector('pre') && document.querySelector('pre').textContent.length>0", "!!document.querySelector('img[alt=\"starry-circle.png\"]') && document.querySelector('img[alt=\"starry-circle.png\"]').complete && document.querySelector('img[alt=\"starry-circle.png\"]').naturalWidth>0", "!!document.querySelector('audio[aria-label=\"t01.wav\"]') && document.querySelector('audio[aria-label=\"t01.wav\"]').readyState>=1 && Number.isFinite(document.querySelector('audio[aria-label=\"t01.wav\"]').duration)"][i];
      await wait(ready, 120_000);
      await shot(`03-preview-${i}`);
    }
  }
  async function selectVideo(label) {
    const predicate = `b.textContent.includes('v01.mp4')&&b.textContent.includes(${JSON.stringify(label)})`;
    await wait(`(() => {const b=[...document.querySelectorAll('li button')].find(b=>${predicate});if(!b)return false;b.click();return true})()`);
    await wait("!!document.querySelector('video') && document.querySelector('video').readyState>=1", 120_000);
    const selectedText = await evaluate("document.querySelector('li button[aria-current=true]').textContent");
    const match = label === "影片畫面"
      ? /取樣幀\s+(\d+):(\d+(?:\.\d+)?)/.exec(selectedText)
      : /影片音軌\s+(\d+):(\d+(?:\.\d+)?)/.exec(selectedText);
    if (!match) throw new Error(`無法讀取 ${label} 的實際命中時間`);
    const target = Number(match[1]) * 60 + Number(match[2]);
    const seek = await evaluate(`(async () => {const v=document.querySelector('video');v.pause();v.currentTime=Math.min(v.duration-0.2,${target}+1);await new Promise((resolve,reject)=>{v.addEventListener('seeked',resolve,{once:true});setTimeout(()=>reject(new Error('準備 seek 逾時')),15000)});const done=new Promise((resolve,reject)=>{v.addEventListener('seeked',()=>resolve(v.currentTime),{once:true});setTimeout(()=>reject(new Error('seeked timeout')),15000)});[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='跳到命中片段').click();return await done})()`);
    if (Math.abs(seek - target) > 0.25) throw new Error(`${label} seek 不符命中時間`);
    await evaluate("document.querySelector('video').play()");
    await sleep(1200);
    const after = await evaluate("document.querySelector('video').currentTime");
    if (!(after > seek + 0.2)) throw new Error(`${label} 播放未推進`);
    report.steps.push({ name: label, targetSeconds: target, seekSeconds: seek, playedSeconds: after });
  }
  await selectVideo("影片畫面");
  await evaluate("document.querySelector('video').scrollIntoView({block:'center'})");
  await shot("04-visual-play");
  await evaluate("document.querySelector('li button[aria-current=true]').scrollIntoView({block:'center'})");
  await shot("04-visual-hit");
  await search("番茄炒蛋的烹飪做法，最後加鹽調味", "b.textContent.includes('v01.mp4')&&b.textContent.includes('影片音軌')");
  await selectVideo("影片音軌");
  await evaluate("document.querySelector('video').scrollIntoView({block:'center'})");
  await shot("05-audio-play");
  await evaluate("document.querySelector('li button[aria-current=true]').scrollIntoView({block:'center'})");
  await shot("05-audio-hit");
  const priorUrl = await evaluate("document.querySelector('video').getAttribute('src')");
  const rangeRequests = page.events.filter((event) => event.type === "request" && event.url.includes("media-sessions"));
  if (!rangeRequests.some((req) => page.events.some((entry) => (entry.type === "request" || entry.type === "request-extra") && entry.id === req.id && Object.keys(entry.headers).some((key) => key.toLowerCase() === "range")) && page.events.some((response) => response.type === "response" && response.id === req.id && response.status === 206))) throw new Error("未觀察到播放器 Range 206");
  report.steps.push({ name: "playback-range", status: 206 });
  // 保留畫面上的舊命中，修改合成副本後重新選取該命中，驗實際授權回應及 UI 提示。
  await evaluate("(window.__acceptanceVideo=document.querySelector('video'), true)");
  await fs.copyFile(path.join(root, "v02.mp4"), path.join(root, "v01.mp4"));
  await sleep(5200);
  await wait("[...document.querySelectorAll('[role=alert]')].some(x=>x.textContent.includes('重新索引'))", 15000);
  if (!(await evaluate("window.__acceptanceVideo.paused"))) throw new Error("來源變更後播放器未停止");
  await evaluate("[...document.querySelectorAll('[role=alert]')].find(x=>x.textContent.includes('重新索引')).scrollIntoView({block:'center'})");
  await shot("06-source-changed");
  const buttons = "[...document.querySelectorAll('li button')]";
  await wait(`(() => {const b=${buttons}.find(x=>x.getAttribute('aria-current')!=='true');if(!b)return false;b.click();return true})()`);
  const revokeDeadline = Date.now() + 10_000;
  let revoked = false;
  while (Date.now() < revokeDeadline && !revoked) {
    const status = await evaluate(`fetch(${JSON.stringify(priorUrl)}, {method:'HEAD',cache:'no-store'}).then(r=>r.status)`);
    revoked = status === 401;
    if (!revoked) await sleep(100);
  }
  if (!revoked) throw new Error("撤銷後舊播放授權仍可使用");
  report.steps.push({ name: "revoked-session", status: 401 });
  await wait(`(() => {const b=${buttons}.find(x=>x.textContent.includes('v01.mp4')&&x.textContent.includes('影片音軌'));if(!b)return false;b.click();return true})()`);
  await wait("[...document.querySelectorAll('[role=alert]')].some(x=>x.textContent.includes('重新索引'))", 120_000);
  if (!page.events.some((event) => event.status === 409 && event.url.includes("media-sessions"))) throw new Error("未觀察到舊命中 409");
  await evaluate("[...document.querySelectorAll('[role=alert]')].find(x=>x.textContent.includes('重新索引')).scrollIntoView({block:'center'})");
  await shot("06-stale-rejected");
  const sensitive = [token, encodeURIComponent(token)];
  if (page.events.some((event) => sensitive.some((secret) => event.url.toLowerCase().includes(secret.toLowerCase())))) throw new Error("網路 URL 含 token");
  report.steps.push({ name: "network-url-token", checked: page.events.filter((event) => event.url !== "").length, leaked: false });
  report.uiFlowPassed = true;
  }
} catch (error) {
  report.error = String(error?.message ?? error).replaceAll(token, "[redacted]").replaceAll(encodeURIComponent(token), "[redacted]").replaceAll(root, "<synthetic-root>");
  if (page) await shot("failure").catch(() => {});
} finally {
  if (mode === "packaged" && inspectorUrl && child?.exitCode === null) {
    let inspector;
    try {
      inspector = await Promise.race([openCdp(inspectorUrl), sleep(5000).then(() => { throw new Error("inspector 連線逾時"); })]);
      await Promise.race([inspector.send("Runtime.evaluate", { expression: "process.emit('SIGTERM')" }), sleep(2000)]);
    } catch (error) { report.shutdownError = String(error?.message ?? error); }
    finally { inspector?.close(); }
  } else if (browser) {
    try { await Promise.race([browser.send("Browser.close"), sleep(5000)]); } catch {}
  }
  browser?.close();
  page?.close();
  if (child) {
    const deadline = Date.now() + 20_000;
    while (!childClosed && Date.now() < deadline) await sleep(100);
    report.normalShutdown = childClosed && child.exitCode === 0 && (mode !== "packaged" || launchOutput.includes("收到 SIGTERM：關閉服務後結束"));
    if (!childClosed && child.pid !== undefined) {
      report.cleanupForced = true;
      if (process.platform === "win32") {
        const cleaner = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        await Promise.race([new Promise((resolve) => { cleaner.once("close", resolve); cleaner.once("error", resolve); }), sleep(5000)]);
        if (cleaner.exitCode === null && cleaner.signalCode === null) {
          cleaner.kill();
          await Promise.race([new Promise((resolve) => cleaner.once("close", resolve)), sleep(3000)]);
        }
      } else child.kill("SIGKILL");
      const cleanupDeadline = Date.now() + 10_000;
      while (!childClosed && Date.now() < cleanupDeadline) await sleep(100);
      report.cleanupObserved = childClosed;
    }
  }
  if (service) {
    try {
      const serviceClosed = await withDeadline(service.close().then(() => true), 30_000);
      if (!serviceClosed) { report.serviceCloseTimeout = true; report.normalShutdown = false; }
    } catch (error) { report.serviceCloseError = String(error?.message ?? error).replaceAll(token, "[redacted]").replaceAll(encodeURIComponent(token), "[redacted]"); report.normalShutdown = false; }
  }
  const leakedAfterClose = page?.events.some((event) => [token, encodeURIComponent(token)].some((secret) => event.url.toLowerCase().includes(secret.toLowerCase()))) ?? false;
  if (leakedAfterClose) report.error = "網路 URL 含 token";
  report.runnerEndSha256 = await hashFile(fileURLToPath(import.meta.url));
  report.ok = report.uiFlowPassed === true && report.normalShutdown === true && !report.cleanupForced && !leakedAfterClose && report.runnerSha256 === report.runnerEndSha256;
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(run, "launch.log"), launchOutput.replaceAll(token, "[redacted]").replaceAll(encodeURIComponent(token), "[redacted]").replaceAll(root, "<synthetic-root>"));
  await fs.writeFile(path.join(run, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: report.ok, normalShutdown: report.normalShutdown, report: path.relative(repo, path.join(run, "report.json")), error: report.error }));
  if (report.serviceCloseTimeout) process.exit(1);
  if (!report.ok || !report.normalShutdown) process.exitCode = 1;
}
