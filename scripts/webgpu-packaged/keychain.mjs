/** 真實 Keychain：同一隔離 profile 的三次正式 main 啟動。不得輸出 token 或密文。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { supervise } from '../webgpu-integration/supervisor.mjs';
import { runtimeMatches } from './assertions.mjs';

const repo = process.cwd();
const id = process.env.KEYCHAIN_ID;
assert(id && /^[a-zA-Z0-9_-]+$/.test(id), '須指定唯一 KEYCHAIN_ID');
const app = path.join(repo, '.tmp', 'webgpu-packaged', 'build', 'mac-arm64', 'mnemoshelf.app');
const sourceCache = path.join(repo, '.tmp', 'webgpu-integration', 'cache');
const output = path.join(repo, '.tmp', 'webgpu-keychain', 'runs', id);
const profile = path.join(output, 'user-data');
const corpus = path.join(output, 'corpus');
const runtimeFile = path.join(profile, 'data', 'runtime.json');
const tokenFile = path.join(profile, 'token.bin');
const executable = path.join(app, 'Contents', 'MacOS', 'mnemoshelf');
const appAsar = path.join(app, 'Contents', 'Resources', 'app.asar');
const expectedAsar = process.env.KEYCHAIN_APP_ASAR_SHA256;
assert(expectedAsar && /^[a-f0-9]{64}$/.test(expectedAsar), '須提供原件 KEYCHAIN_APP_ASAR_SHA256');
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // 禁止覆寫或續用既有 profile。
const report = { id, keychainMode: 'real', passed: false, startedAt: new Date().toISOString(), phases: [], checks: {}, rounds: [] };
async function save() { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
function check(name, value, target = report.checks) { target[name] = Boolean(value); if (!value) throw new Error(`檢查失敗：${name}`); }
async function phase(round, name) { report.phases.push({ round, name, at: new Date().toISOString() }); console.log(`第 ${round} 輪：${name}`); await save(); }
async function hash(file) { const h = createHash('sha256'); for await (const data of createReadStream(file)) h.update(data); return h.digest('hex'); }
async function inventory(dir, parts = []) {
  let entries = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), 'cache 含 symlink');
    if (entry.isDirectory()) entries.push(...await inventory(path.join(dir, entry.name), [...parts, entry.name]));
    else { assert(entry.isFile(), 'cache 含特殊檔'); entries.push([...parts, entry.name].join(':')); }
  }
  return entries.sort();
}
const manifest = JSON.parse(await readFile(path.join(repo, '.tmp', 'webgpu-integration', 'verified-models.json'), 'utf8'));
async function verifyModels(dir) {
  assert.equal(manifest.length, 12, '模型清單應有 12 個檔案');
  assert(manifest.every((item) => item.parts.every((part) => typeof part === 'string' && part !== '.' && part !== '..' && !part.includes(path.sep))));
  assert.deepEqual(await inventory(dir), manifest.map((item) => item.parts.join(':')).sort());
  for (const item of manifest) assert.equal(await hash(path.join(dir, ...item.parts)), item.sha256, '模型指紋不符');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let firstToken, firstCipher, rootId;
const pids = new Set();
try {
  await phase(0, '核對原件、簽章及模型');
  check('appAsarHash', await hash(appAsar) === expectedAsar);
  const sign = spawn('codesign', ['--verify', '--deep', '--strict', app], { detached: true, stdio: 'ignore' });
  const signed = await supervise(sign, { timeoutMs: 20 * 60 * 1000, maxRssBytes: 6 * 1024 ** 3 });
  report.codesign = signed;
  check('codesign', signed.exit.code === 0 && !signed.timedOut && !signed.memoryExceeded);
  await verifyModels(sourceCache);
  await mkdir(profile); await mkdir(corpus);
  await cp(sourceCache, path.join(profile, 'models'), { recursive: true, errorOnExist: true });
  await verifyModels(path.join(profile, 'models'));
  check('modelCopy', true);
  await writeFile(path.join(corpus, 'hello.txt'), 'Network firewall rules block incoming connections and permit trusted outbound requests. Inspect packet filters and audit security policy.\n');
  const fixtureRoot = path.join(repo, '.tmp', 'webgpu-integration');
  const fixtureManifest = JSON.parse(await readFile(path.join(fixtureRoot, 'fixtures.json'), 'utf8'));
  const red = fixtureManifest.files.find((item) => item.name === 'red.png');
  assert(red && await hash(path.join(fixtureRoot, 'fixtures', 'red.png')) === red.sha256, '合成圖片指紋不符');
  await copyFile(path.join(fixtureRoot, 'fixtures', 'red.png'), path.join(corpus, 'red.png'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MNEMOSHELF_') && !key.startsWith('ELECTRON_') && !key.startsWith('KEYCHAIN_') && key !== 'NODE_OPTIONS' && key !== 'NODE_PATH'));
  Object.assign(env, { MNEMOSHELF_DESKTOP_USER_DATA: profile, MNEMOSHELF_PORT: '0', MNEMOSHELF_INDEX_RATE: 'off', MNEMOSHELF_EMBED_DEVICE: 'webgpu' });
  for (let round = 1; round <= 3; round++) {
    const result = { round, checks: {}, startedAt: new Date().toISOString() }; report.rounds.push(result);
    const existsBefore = await lstat(runtimeFile).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
    check('noPreviousRuntime', !existsBefore, result.checks);
    await phase(round, '啟動正式 App；等待系統授權/服務啟動');
    const start = Date.now();
    const args = ['--headless'];
    result.launchEvidence = { args, envTokenPresent: Object.hasOwn(env, 'MNEMOSHELF_TOKEN'), mockKeychain: args.includes('--use-mock-keychain') };
    const child = spawn(executable, args, { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', (part) => { stdout += String(part); });
    // stderr 不寫檔也不印出，避免意外曝光內容。
    child.stderr.resume();
    const supervision = supervise(child, { timeoutMs: 20 * 60 * 1000, maxRssBytes: 6 * 1024 ** 3 });
    let alive = true; child.once('exit', () => { alive = false; });
    const heartbeat = setInterval(() => console.log(`第 ${round} 輪：等待系統授權/服務啟動`), 15000);
    let runtime;
    try {
      check('freshPid', Number.isInteger(child.pid) && !pids.has(child.pid), result.checks); pids.add(child.pid); result.pid = child.pid; await save();
      while (alive && Date.now() - start < 20 * 60 * 1000) {
        try { runtime = JSON.parse(await readFile(runtimeFile, 'utf8')); if (runtime.schemaVersion === 1 && runtime.pid === child.pid && Date.parse(runtime.startedAt) >= start && typeof runtime.token === 'string' && runtime.token.length > 0) break; runtime = null; } catch { /* 原子寫入完成前繼續等。 */ }
        await sleep(500);
      }
      clearInterval(heartbeat);
      check('freshRuntime', Boolean(runtime && runtime.schemaVersion === 1 && runtime.pid === child.pid && Date.parse(runtime.startedAt) >= start), result.checks);
      result.startupWaitMs = Date.now() - start;
      result.runtimeEvidence = { schemaVersion: runtime.schemaVersion, pid: runtime.pid, startedAt: runtime.startedAt };
      await phase(round, '服務就緒，檢查 token 與 REST');
      const url = new URL(runtime.url); check('loopback', url.hostname === '127.0.0.1' && url.protocol === 'http:', result.checks);
      const cipher = await readFile(tokenFile);
      const fileInfo = await lstat(tokenFile);
      check('tokenFileRegular0600', fileInfo.isFile() && !fileInfo.isSymbolicLink() && (fileInfo.mode & 0o777) === 0o600, result.checks);
      check('tokenNotPlaintext', cipher.length > 0 && !cipher.includes(Buffer.from(runtime.token)), result.checks);
      if (round === 1) { firstToken = runtime.token; firstCipher = cipher; }
      else { check('sameToken', runtime.token === firstToken, result.checks); check('sameCipherBytes', cipher.equals(firstCipher), result.checks); }
      async function request(method, endpoint, body, auth = firstToken) {
        const response = await fetch(new URL(endpoint, url), { method, headers: { ...(auth === null ? {} : { authorization: `Bearer ${auth}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15 * 60 * 1000) });
        return response;
      }
      const authorized = await request('GET', '/roots'); check('oldTokenAuthorized', authorized.status === 200, result.checks);
      const wrong = await request('GET', '/roots', undefined, 'incorrect-test-token'); check('wrongToken401', wrong.status === 401, result.checks);
      const missing = await request('GET', '/roots', undefined, null); check('missingToken401', missing.status === 401, result.checks);
      if (round === 1) {
        const response = await request('POST', '/roots', { path: corpus, mode: 'index', modalities: ['text', 'image'], respectGitignore: false, watch: false });
        check('rootCreated', response.ok, result.checks); rootId = (await response.json()).id;
        await phase(round, '索引合成文字與圖片'); const modelStart = Date.now();
        const indexedResponse = await request('POST', `/roots/${rootId}/index`); check('indexHttp', indexedResponse.ok, result.checks);
        const indexed = await indexedResponse.json(); result.modelIndexMs = Date.now() - modelStart;
        check('indexTwoFiles', indexed.processed === 2 && indexed.failedFiles.length === 0, result.checks);
      }
      const queryStart = Date.now();
      for (const [query, filename] of [['network firewall', 'hello.txt'], ['red color', 'red.png']]) {
        const response = await request('POST', '/search', { query, mode: 'vector', rootIds: [rootId], k: 5 }); check(`searchHttp-${filename}`, response.ok, result.checks);
        const search = await response.json(); check(`vectorHit-${filename}`, search.mode === 'vector' && search.hits.some((hit) => hit.relPath === filename), result.checks);
      }
      result.vectorSearchMs = Date.now() - queryStart;
      const diagnostics = await request('GET', '/diagnostics'); check('diagnosticsHttp', diagnostics.ok, result.checks);
      result.embedderRuntime = (await diagnostics.json()).embedderRuntime;
      check('webgpuProbe', runtimeMatches('gpu', result.embedderRuntime), result.checks);
      await phase(round, '正常關閉'); child.kill('SIGTERM');
    } catch (error) {
      clearInterval(heartbeat); result.error = error instanceof Error && error.message.startsWith('檢查失敗：') ? error.message : '執行失敗，詳查 phase 與退出狀態';
      if (alive) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => { if (alive && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (failure) { if (failure.code !== 'ESRCH') throw failure; } } }, 5000);
        child.once('close', () => clearTimeout(timer));
      }
    }
    result.supervisor = await supervision; result.wallMs = Date.now() - start;
    result.checks.packagedMain = stdout.includes(`isPackaged=true；appPath=${appAsar}；resourcesPath=${path.join(app, 'Contents', 'Resources')}`);
    result.checks.tokenSource = (round === 1 ? stdout.includes('已產生 token 並加密寫入') : stdout.includes('token 來源：既有密文檔')) && !/token 來源：環境變數|只保留在本次執行|無法解密|沒有可用的 safeStorage|token 無法寫入/.test(stdout);
    result.checks.runtimeRemovedByApp = !(await lstat(runtimeFile).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; }));
    result.checks.cleanExit = result.supervisor.exit.code === 0 && !result.supervisor.timedOut && !result.supervisor.memoryExceeded && result.supervisor.sampledPeakRssBytes !== null && result.supervisor.sampleFailures === 0;
    await verifyModels(path.join(profile, 'models')); result.checks.modelHashesAfter = true;
    await save();
    if (result.error || Object.values(result.checks).some((value) => !value)) throw new Error(`第 ${round} 輪失敗`);
  }
  check('appAsarUnchanged', await hash(appAsar) === expectedAsar);
  report.passed = report.rounds.length === 3 && report.rounds.every((item) => Object.values(item.checks).every(Boolean));
} catch (error) { report.error = error instanceof Error && (error.message.startsWith('檢查失敗：') || /^第 \d 輪失敗$/.test(error.message)) ? error.message : '前置或執行失敗，詳查 phase 與 checks'; }
report.finishedAt = new Date().toISOString(); await save();
console.log(JSON.stringify({ id, passed: report.passed, error: report.error, rounds: report.rounds.map(({ round, checks }) => ({ round, checks })) }));
process.exitCode = report.passed ? 0 : 1;
