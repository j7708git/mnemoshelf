/** 用指定 Electron main process 跑同一條音訊產品鏈；所有資料置於 .tmp。 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { spawn } from "node:child_process";

const repo = process.cwd();
const output = path.join(repo, ".tmp", "audio-indexing-acceptance");
await mkdir(output, { recursive: true });
const executable = process.env.AUDIO_ELECTRON_PATH ?? path.join(repo, ".tmp", "media-feasibility", "electron-44.10.0", "electron.exe");
await access(executable);
const code = stripTypeScriptTypes(await readFile(path.join(repo, "scripts", "audio-indexing-acceptance.ts"), "utf8"));
const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
const entry = path.join(output, "electron-entry.mjs");
await writeFile(entry, `import { app } from "electron";
import path from "node:path";
import { homedir } from "node:os";
app.setPath("userData", path.join(process.cwd(), ".tmp", "audio-indexing-acceptance", "electron-user-data"));
app.whenReady().then(async () => {
  try {
    await import(${JSON.stringify(url)});
    app.exit(Number(process.exitCode ?? 0));
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.name : "error", message: error instanceof Error ? error.message.replaceAll(homedir(), "<home>").replaceAll(process.cwd(), "<repo>") : "Electron 音訊驗收未完成。" }));
    app.exit(1);
  }
});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [entry], { cwd: repo, env, stdio: "inherit", windowsHide: true });
process.exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});
