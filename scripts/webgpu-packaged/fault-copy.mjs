/** 只修改額外 App 副本的一處 WebGPU 載入參數，再做 ad-hoc 簽章。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { supervise } from '../webgpu-integration/supervisor.mjs';
const base = path.join(process.cwd(), '.tmp', 'webgpu-packaged');
const id = process.env.PACKAGED_ID;
assert(id && /^[a-zA-Z0-9_-]+$/.test(id), '須提供唯一 PACKAGED_ID');
assert(process.env.PACKAGED_APP, '須提供 PACKAGED_APP');
const source = path.resolve(process.env.PACKAGED_APP);
assert(source.startsWith(base + path.sep) && source.endsWith('.app'));
const out = path.join(base, 'fault-copies', id);
await mkdir(path.dirname(out), { recursive: true }); await mkdir(out);
const target = path.join(out, 'Mnemoshelf.app');
await cp(source, target, { recursive: true, verbatimSymlinks: true, errorOnExist: true });
const unpacked = path.join('Contents', 'Resources', 'app.asar.unpacked', 'node_modules');
async function find(dir, parts = []) {
  let results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) results.push(...await find(path.join(dir, entry.name), [...parts, entry.name]));
    else if (entry.isFile() && entry.name === 'embedder.js' && parts.slice(-2).join(':') === 'embedder-transformers:dist') results.push([...parts, entry.name]);
  }
  return results;
}
const candidates = await find(path.join(target, unpacked));
assert.equal(candidates.length, 1, '必須只有一個 unpacked compiled embedder');
const sourceFile = path.join(source, unpacked, ...candidates[0]);
const file = path.join(target, unpacked, ...candidates[0]);
async function hash(file) { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); }
const before = await hash(sourceFile); assert.equal(await hash(file), before);
const text = await readFile(file, 'utf8');
const oldText = 'const model = (await AutoModel.from_pretrained(this.modelId, {\n                config,\n                device,';
const newText = 'const model = (await AutoModel.from_pretrained(this.modelId, {\n                config,\n                device: device === "webgpu" ? "packaged-invalid-provider" : device,';
assert.equal(text.split(oldText).length, 2, '注入點必須唯一');
await writeFile(file, text.replace(oldText, newText));
const after = await hash(file); assert.notEqual(before, after); assert.equal(await hash(sourceFile), before);
async function command(args) {
  const child = spawn('codesign', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { output += data; });
  const result = await supervise(child, { timeoutMs: 20 * 60 * 1000, maxRssBytes: 6 * 1024 ** 3 });
  assert.equal(result.exit.code, 0, `codesign 失敗：${output}`); assert(!result.timedOut && !result.memoryExceeded);
  return { result, output };
}
const sign = await command(['--force', '--preserve-metadata=identifier,entitlements,requirements,flags,runtime', '--sign', '-', target]);
const verify = await command(['--verify', '--deep', '--strict', '--verbose=2', target]);
assert.equal(await hash(sourceFile), before, '原 App 變更');
await writeFile(path.join(out, 'fault.json'), JSON.stringify({ sourceEmbedderSha256: before, faultEmbedderSha256: after, targetParts: candidates[0], injection: 'AutoModel.from_pretrained 的 device 只在 webgpu 時改為非法 provider；CPU 保持原值', sign, verify }, null, 2));
console.log(JSON.stringify({ target, before, after, signed: true }));
