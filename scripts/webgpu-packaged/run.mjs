/** 啟動正式 app bundle；所有資料、素材及連線資訊限定在新建的驗收目錄。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { supervise } from '../webgpu-integration/supervisor.mjs';
import { accountingMatches, runtimeMatches } from './assertions.mjs';

const repo = process.cwd();
const base = path.join(repo, '.tmp', 'webgpu-packaged');
const id = process.env.PACKAGED_ID;
const scenario = process.env.PACKAGED_SCENARIO;
assert(id && /^[a-zA-Z0-9_-]+$/.test(id), '須提供唯一 PACKAGED_ID');
assert(['gpu', 'default', 'fault', 'budget', 'gui'].includes(scenario), 'PACKAGED_SCENARIO 無效');
assert(process.env.PACKAGED_APP && process.env.PACKAGED_CACHE, '須提供 PACKAGED_APP 與 PACKAGED_CACHE');
const app = path.resolve(process.env.PACKAGED_APP);
assert(app.startsWith(base + path.sep) && app.endsWith('.app'), 'App 必須位於隔離產物目錄');
const executable = path.join(app, 'Contents', 'MacOS', 'mnemoshelf');
const output = path.join(base, 'runs', id);
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const userData = path.join(output, 'user-data');
const corpus = path.join(output, 'corpus');
await mkdir(userData); await mkdir(corpus);
const manifest = JSON.parse(await readFile(path.join(repo, '.tmp', 'webgpu-integration', 'verified-models.json'), 'utf8'));
const cache = path.resolve(process.env.PACKAGED_CACHE);
async function inventory(dir, parts = []) {
  let entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), '模型 cache 不得含 symlink');
    if (entry.isDirectory()) entries.push(...await inventory(path.join(dir, entry.name), [...parts, entry.name]));
    else { assert(entry.isFile(), '模型 cache 不得含特殊檔案'); entries.push([...parts, entry.name].join(':')); }
  }
  return entries.sort();
}
assert.deepEqual(await inventory(cache), manifest.map((entry) => entry.parts.join(':')).sort(), '模型清單不符');
assert(manifest.length > 0 && manifest.some((entry) => entry.parts.at(-1) === 'model_q4.onnx'));
async function hash(file) { const h = createHash('sha256'); for await (const data of createReadStream(file)) h.update(data); return h.digest('hex'); }
for (const entry of manifest) {
  assert(entry.parts.every((part) => typeof part === 'string' && part !== '.' && part !== '..' && !part.includes(path.sep)), '模型路徑無效');
  assert.equal(await hash(path.join(cache, ...entry.parts)), entry.sha256, '來源模型 hash 不符');
}
await cp(cache, path.join(userData, 'models'), { recursive: true, errorOnExist: true });
for (const entry of manifest) assert.equal(await hash(path.join(userData, 'models', ...entry.parts)), entry.sha256, '模型副本 hash 不符');
await writeFile(path.join(corpus, 'hello.txt'), 'Network firewall rules block incoming connections and permit trusted outbound requests. Inspect packet filters and audit security policy.\n');
if (scenario !== 'gui') {
  const fixtureDir = path.join(repo, '.tmp', 'webgpu-integration');
  const fixtures = JSON.parse(await readFile(path.join(fixtureDir, 'fixtures.json'), 'utf8'));
  const red = fixtures.files.find((entry) => entry.name === 'red.png');
  assert(red, '合成圖片 fixture 缺少 manifest');
  const image = path.join(fixtureDir, 'fixtures', 'red.png');
  assert.equal(await hash(image), red.sha256, '合成圖片 hash 不符');
  await copyFile(image, path.join(corpus, 'red.png'));
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MNEMOSHELF_') && !key.startsWith('ELECTRON_') && !key.startsWith('PACKAGED_') && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH'));
Object.assign(env, { MNEMOSHELF_DESKTOP_USER_DATA: userData, MNEMOSHELF_PORT: '0', MNEMOSHELF_INDEX_RATE: 'off', MNEMOSHELF_TOKEN: randomBytes(32).toString('hex') });
if (scenario !== 'default') env.MNEMOSHELF_EMBED_DEVICE = 'webgpu';
if (scenario === 'gui') Object.assign(env, { MNEMOSHELF_AUTOTEST: 'bootstrap,index', MNEMOSHELF_AUTOTEST_OUT: path.join(output, 'gui'), MNEMOSHELF_AUTOTEST_SAMPLE_ROOT: corpus, MNEMOSHELF_AUTOTEST_TEXT: 'hello.txt', MNEMOSHELF_AUTOTEST_QUERY: 'network firewall', MNEMOSHELF_AUTOTEST_INDEX_TIMEOUT_MS: '900000', MNEMOSHELF_AUTOTEST_BOOTSTRAP_TIMEOUT_MS: '900000' });
const started = Date.now();
const child = spawn(executable, scenario === 'gui' ? ['--use-mock-keychain'] : ['--use-mock-keychain', '--headless'], { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(createWriteStream(path.join(output, 'stdout.log')));
child.stderr.pipe(createWriteStream(path.join(output, 'stderr.log')));
const supervision = supervise(child, { timeoutMs: 20 * 60 * 1000, maxRssBytes: 6 * 1024 ** 3 });
let alive = true; child.once('exit', () => { alive = false; });
const report = { id, scenario, keychainMode: 'mock-for-isolated-smoke', startedAt: new Date(started).toISOString(), passed: false, modelFiles: manifest, checks: {}, snapshots: {} };
const check = (name, condition) => { report.checks[name] = Boolean(condition); assert(condition, name); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let runtime;
try {
  for (let i = 0; i < 120 && alive; i++) {
    try { runtime = JSON.parse(await readFile(path.join(userData, 'data', 'runtime.json'), 'utf8')); break; } catch { await sleep(500); }
  }
  assert(runtime && typeof runtime.token === 'string', '隔離 runtime 未就緒');
  const url = new URL(runtime.url); assert(url.hostname === '127.0.0.1', '服務必須是 loopback');
  async function request(method, endpoint, body) {
    const response = await fetch(new URL(endpoint, url), { method, headers: { authorization: `Bearer ${runtime.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15 * 60 * 1000) });
    assert(response.ok, `HTTP ${response.status} ${method} ${endpoint}`); return response.json();
  }
  if (scenario !== 'gui') {
    const root = await request('POST', '/roots', { path: corpus, mode: 'index', modalities: ['text', 'image'], respectGitignore: false, watch: false });
    report.index = await request('POST', `/roots/${root.id}/index`);
    check('index', report.index.processed === 2 && report.index.failedFiles.length === 0);
    let status = (await request('GET', '/diagnostics')).embedderRuntime;
    report.snapshots.afterIndex = status;
    check('loaded', status.loaded === true);
    check('runtime', runtimeMatches(scenario, status));
    const search = await request('POST', '/search', { query: 'network firewall', mode: 'vector', rootIds: [root.id], k: 5 });
    check('search', search.mode === 'vector' && search.hits.some((hit) => hit.relPath === 'hello.txt'));
    const imageSearch = await request('POST', '/search', { query: 'red color', mode: 'vector', rootIds: [root.id], k: 5 });
    check('image-search', imageSearch.mode === 'vector' && imageSearch.hits.some((hit) => hit.relPath === 'red.png'));
    if (scenario === 'fault') {
      await writeFile(path.join(corpus, 'second.txt'), 'A lighthouse guides sailors through the harbor with a bright beacon.\n');
      report.retryIndex = await request('POST', `/roots/${root.id}/index`);
      check('fault-reindex', report.retryIndex.processed === 1 && report.retryIndex.failedFiles.length === 0);
      const retrySearch = await request('POST', '/search', { query: 'lighthouse harbor beacon', mode: 'vector', rootIds: [root.id], k: 5 });
      check('fault-followup-search', retrySearch.mode === 'vector' && retrySearch.hits.some((hit) => hit.relPath === 'second.txt'));
      status = (await request('GET', '/diagnostics')).embedderRuntime;
      report.snapshots.afterFaultRetry = status;
      check('fault-still-cpu', runtimeMatches('fault', status));
    }
    if (scenario === 'budget') {
      const longSearch = await request('POST', '/search', { query: 'firewall '.repeat(3000), mode: 'vector', rootIds: [root.id], k: 5 });
      report.longSearchHits = longSearch.hits.length;
      status = (await request('GET', '/diagnostics')).embedderRuntime;
      report.snapshots.afterBudget = status;
      check('budget-fallback', status.requestedDevice === 'webgpu' && status.device === 'cpu' && status.fallbackReason?.code === 'token-budget');
      const followup = await request('POST', '/search', { query: 'network firewall', mode: 'vector', rootIds: [root.id], k: 5 });
      check('search-after-budget', followup.mode === 'vector' && followup.hits.some((hit) => hit.relPath === 'hello.txt'));
    }
    child.kill('SIGTERM');
  } else {
    // GUI 自動驗收操作 renderer；在退出前讀取同一產品服務的 runtime 診斷。
    while (alive) {
      try { const diagnostic = await request('GET', '/diagnostics'); const status = diagnostic.embedderRuntime; if (status?.loaded && diagnostic.roots.some((root) => root.lastIndex?.processed > 0 && root.lastIndex?.finishedAt)) { report.snapshots.gui = status; break; } } catch { /* 程序退出時由報告判定。 */ }
      await sleep(500);
    }
  }
} catch (error) {
  report.error = String(error);
  if (alive) {
    child.kill('SIGTERM');
    const forced = setTimeout(() => {
      if (!alive || !child.pid) return;
      try { if (process.platform === 'win32') child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; }
    }, 5000);
    child.once('close', () => clearTimeout(forced));
  }
}
report.supervisor = await supervision;
report.wallMs = Date.now() - started;
const stdout = await readFile(path.join(output, 'stdout.log'), 'utf8');
report.checks.packagedMain = stdout.includes(`isPackaged=true；appPath=${path.join(app, 'Contents', 'Resources', 'app.asar')}；resourcesPath=${path.join(app, 'Contents', 'Resources')}`);
try { assert.deepEqual(await inventory(path.join(userData, 'models')), manifest.map((entry) => entry.parts.join(':')).sort()); for (const entry of manifest) assert.equal(await hash(path.join(userData, 'models', ...entry.parts)), entry.sha256); report.checks.modelHashesAfter = true; } catch (error) { report.checks.modelHashesAfter = false; report.error ??= String(error); }
try {
  const { openDatabase } = await import('../../packages/core/dist/index.js');
  const db = openDatabase(path.join(userData, 'data', 'mnemoshelf.db'), { readonly: true });
  try {
    const chunks = db.prepare('select count(*) as n from chunks').get().n;
    const vectors = db.prepare("select count(*) as n from vectors where key like 'c:%'").get().n;
    report.accounting = { chunks, vectors };
    report.checks.chunkVectors = accountingMatches(chunks, vectors);
    if (scenario !== 'gui') {
      const imageChunks = db.prepare("select count(*) as n from chunks where rel_path = 'red.png'").get().n;
      report.accounting.imageChunks = imageChunks; report.checks.imageChunks = imageChunks > 0;
    }
  } finally { db.close(); }
} catch (error) { report.checks.chunkVectors = false; report.error ??= String(error); }
if (scenario === 'gui') {
  try {
    const gui = JSON.parse(await readFile(path.join(output, 'gui', 'report.json'), 'utf8'));
    report.gui = { ok: gui.ok, isPackaged: gui.environment?.isPackaged, steps: gui.steps, screenshots: gui.screenshots };
    report.checks.gui = gui.ok === true && gui.environment?.isPackaged === true && gui.screenshots.some((item) => item.endsWith('09-search-hits.png'));
    const status = report.snapshots.gui;
    report.checks.guiGpu = runtimeMatches('gpu', status);
  } catch (error) { report.error ??= String(error); }
}
report.passed = !report.error && Object.values(report.checks).length > 0 && Object.values(report.checks).every(Boolean) && report.supervisor.exit.code === 0 && !report.supervisor.timedOut && !report.supervisor.memoryExceeded && report.supervisor.sampledPeakRssBytes !== null && report.supervisor.sampleFailures === 0;
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ id, scenario, passed: report.passed, error: report.error, checks: report.checks, exit: report.supervisor.exit }));
process.exitCode = report.passed ? 0 : 1;
