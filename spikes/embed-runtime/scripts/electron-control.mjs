// 對照組：只啟動 Electron 的 main process，不做任何模型載入。
// 用途是區分「main process 起不來（環境問題，例如沒有 X display）」與
// 「起得來但載入模型卡住（程式問題）」。
const isMain = process.argv.includes("--main-process");

if (!isMain) {
  console.log(`ELECTRON_CONTROL_JSON=${JSON.stringify({ ok: true, mode: "run-as-node", versions: process.versions })}`);
} else {
  const { app } = await import("electron");
  await app.whenReady();
  console.log(
    `ELECTRON_CONTROL_JSON=${JSON.stringify({
      ok: true,
      mode: "main-process",
      versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    })}`,
  );
  app.quit();
}
