/** 用已存在的 Electron 執行同一份探測；不觸發 npm 的自動下載，不顯示視窗。 */
import { join } from 'node:path';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { spawn } from 'node:child_process';

const root = process.cwd();
const output = join(root, '.tmp', 'media-feasibility');
const executable = process.env.MEDIA_ELECTRON_PATH ?? join(output, 'electron-44.10.0', 'electron.exe');
await access(executable);
await mkdir(output, { recursive: true });
const source = await readFile(join(root, 'scripts', 'media-feasibility.ts'), 'utf8');
const code = stripTypeScriptTypes(source);
const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const entry = join(output, 'electron-probe.mjs');
await writeFile(entry, `import { app } from 'electron';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
const marker = join(process.cwd(), '.tmp', 'media-feasibility', 'electron-stage.txt');
writeFileSync(marker, 'main-entered');
app.setPath('userData', join(process.cwd(), '.tmp', 'media-feasibility', 'electron-user-data'));
app.whenReady().then(async () => {
  writeFileSync(marker, 'ready-before-inference');
  try { await import(${JSON.stringify(url)}); app.quit(); }
  catch (error) {
    console.error(String(error).replaceAll(homedir(), '<home>').replaceAll(process.cwd(), '<repo>'));
    app.exit(1);
  }
});
`);
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [entry], { cwd: root, env: childEnv, windowsHide: true, stdio: 'inherit' });
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code) => resolve(code ?? 1));
});
