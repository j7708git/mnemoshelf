/** 明確執行才下載音訊資產；所有寫入限於本 repo 的 .tmp。 */
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { cp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

const dataDir = process.platform === 'win32' ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
  : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'));
const source = process.env.MNEMOSHELF_MODEL_DIR ?? join(dataDir, 'mnemoshelf', 'models');
const output = join(process.cwd(), '.tmp', 'media-feasibility');
const relative = join('onnx-community', 'embeddinggemma-2-ONNX');
const target = join(output, 'models', relative);
await mkdir(target, { recursive: true });
if (resolve(join(source, relative)) !== resolve(target)) {
  await cp(join(source, relative), target, { recursive: true, force: false });
}
const metadata = { sha: 'daa72c51243991dfcaf9f9137d2c573d8f7790c0' };
const expectedHashes: Record<string, string> = {
  'audio_encoder_q4.onnx': 'c4cce3370e72262280d00293cac038896050a03a8e9a27e10b061ca97510296e',
  'audio_encoder_q4.onnx_data': 'ba9328e6341360974083085b44b2bba265003bda564740f7c4c23ed9928f17e2',
};
const files: Record<string, unknown>[] = [];
for (const name of ['audio_encoder_q4.onnx', 'audio_encoder_q4.onnx_data']) {
  const url = `https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/${metadata.sha}/onnx/${name}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Asset HTTP ${response.status}`);
  const destination = join(target, 'onnx', name);
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(destination));
  const digest = createHash('sha256');
  for await (const part of createReadStream(destination)) digest.update(part);
  const sha256 = digest.digest('hex');
  if (sha256 !== expectedHashes[name]) throw new Error(`Checksum mismatch: ${name}`);
  files.push({ name, url, bytes: (await stat(destination)).size, sha256 });
}
const result = { revision: metadata.sha, files, localConfigModelType: JSON.parse(await readFile(join(target, 'config.json'), 'utf8')).model_type };
await writeFile(join(output, 'download-report.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
