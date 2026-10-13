// Electron 環境下的最小載入測試（Q6）：載入 q8 文字+圖片模型，嵌入 1 句文字與 2 張圖，
// 檢查維度、NaN、正規化與「圖 vs 自己的描述」是否勝過另一張圖。輸出 JSON 到 stdout。
//
// 用法（兩種模式都會由 scripts/bench-electron.mjs 自動嘗試）：
//   ELECTRON_RUN_AS_NODE=1 <electron 路徑> scripts/electron-run.mjs            # Electron 的 Node
//   <electron 路徑> scripts/electron-run.mjs --main-process                    # 真正的 main process
import fs from "node:fs";
import path from "node:path";
import { configureCache, loadEmbedder, loadImageFile, queryPrefix, runModel, truncateAndNormalize, vectorStats, cosine } from "../lib/embedder.mjs";
import { ASSET_OUT_DIR } from "../lib/paths.mjs";

const isMainProcess = process.argv.includes("--main-process");
const runtime = isMainProcess
  ? { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, modules: process.versions.modules }
  : { electron: process.versions.electron ?? null, node: process.versions.node, modules: process.versions.modules };

async function run() {
  const report = { runtime, dtype: "q8", ok: false, steps: [], errors: [] };
  try {
    configureCache("q8");
    const started = performance.now();
    const { processor, model, sessions } = await loadEmbedder({ dtype: "q8", modalities: "text+image" });
    report.sessions = sessions;
    report.loadMs = Number((performance.now() - started).toFixed(1));
    report.rssAfterLoadMiB = Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1));
    report.steps.push("load");

    const textPrefixed = queryPrefix("兩隻貓一起在沙發上睡覺");
    const textInputs = await processor([textPrefixed]);
    const textOut = await runModel(model, textInputs);
    report.textDims = textOut.dims;
    report.textStats = vectorStats(textOut.data[0]);
    report.steps.push("text");

    const imageFiles = ["cats.png", "red_circle.png"];
    const rawImages = [];
    for (const file of imageFiles) {
      const candidate = path.join(ASSET_OUT_DIR, file.replace(/\.png$/, ".jpg"));
      const resolved = fs.existsSync(candidate) ? candidate : path.join(ASSET_OUT_DIR, file);
      rawImages.push({ id: file, image: await loadImageFile(resolved) });
    }
    const imageInputs = await processor(null, rawImages.map((item) => [item.image]));
    const imageOut = await runModel(model, imageInputs);
    report.imageDims = imageOut.dims;
    report.imageStats = imageOut.data.map((row) => vectorStats(row));
    report.steps.push("image");

    // 圖 vs 自己的描述 應該勝過 vs 另一張圖的描述
    const queries = {
      cats: queryPrefix("兩隻貓一起在沙發上睡覺"),
      circle: queryPrefix("純白背景正中央的一個紅色實心圓形"),
    };
    const queryInputs = await processor([queries.cats, queries.circle]);
    const queryOut = await runModel(model, queryInputs);
    report.simMatrix = imageOut.data.map((image, index) => ({
      image: rawImages[index].id,
      cats: cosine(image, queryOut.data[0]),
      circle: cosine(image, queryOut.data[1]),
    }));
    report.catsTop1 = report.simMatrix[0].cats > report.simMatrix[0].circle;
    report.circleTop1 = report.simMatrix[1].circle > report.simMatrix[1].cats;
    report.ok = report.catsTop1 && report.circleTop1 && report.textStats.nan === 0;
    report.steps.push("probe");
  } catch (error) {
    report.errors.push({ message: String(error?.message ?? error), stack: String(error?.stack ?? "") });
  }
  return report;
}

async function main() {
  const report = await run();
  const outIndex = process.argv.indexOf("--out");
  const outFile = outIndex === -1 ? null : process.argv[outIndex + 1];
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(`ELECTRON_REPORT_JSON=${JSON.stringify(report)}`);
  if (!report.ok) process.exitCode = 1;
}

if (isMainProcess) {
  // 真正的 Electron main process：不開任何視窗，跑完就結束。
  const { app } = await import("electron");
  await app.whenReady();
  await main();
  app.quit();
} else {
  await main();
}
