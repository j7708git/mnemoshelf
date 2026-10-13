// 產生測試圖片到 .tmp/assets/：1 張公開測試圖（下載）+ 5 張合成圖。
// 合成圖用 ImageMagick `convert` 把 assets/*.svg 轉成 PNG；文字圖用 ImageMagick
// 直接排版（ImageMagick 內建的 MSVG renderer 缺 CJK 字型，會把中文吃掉，故改用 -annotate
// 指定 Noto Sans CJK，見 README「已知環境需求」）。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ASSET_OUT_DIR, ASSET_SRC_DIR, ensureDir, humanBytes } from "../lib/paths.mjs";
import { IMAGES } from "../lib/corpus-images.mjs";

/** 文字圖的內容（與 corpus-images.mjs 的 descEn/descZh 對應）。 */
const TEXT_IMAGE_TEXT = "Hello 你好";
/** 若系統沒有 Noto Sans CJK，可依序退到這些字型；都找不到就用 ImageMagick 預設字型（中文可能變成方塊）。 */
const CJK_FONT_CANDIDATES = ["Noto-Sans-CJK-TC", "Noto-Sans-CJK-JP", "AR-PL-UMing-TW", "DejaVu-Sans"];

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

function hasBinary(name) {
  try {
    run("sh", ["-c", `command -v ${name}`]);
    return true;
  } catch {
    return false;
  }
}

/** 把 SVG 轉成 PNG：優先用 rsvg-convert（正確度高），否則用 ImageMagick convert。 */
function svgToPng(svgPath, outPath, size) {
  if (hasBinary("rsvg-convert")) {
    run("rsvg-convert", ["-w", String(size), "-h", String(size), "-o", outPath, svgPath]);
  } else {
    run("convert", ["-background", "white", "-resize", `${size}x${size}`, svgPath, outPath]);
  }
}

/** 文字圖：直接用 ImageMagick 排版，確保 CJK 有字型可用。 */
function makeTextImage(outPath, size) {
  let lastError;
  for (const font of CJK_FONT_CANDIDATES) {
    try {
      run("convert", [
        "-size", `${size}x${size}`, "xc:white",
        "-font", font,
        "-pointsize", String(Math.round(size / 6)),
        "-fill", "black",
        "-gravity", "center",
        "-annotate", "+0+0", TEXT_IMAGE_TEXT,
        outPath,
      ]);
      return font;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`無法產生文字圖：${lastError?.message ?? "unknown"}`);
}

async function main() {
  ensureDir(ASSET_OUT_DIR);
  const report = [];
  for (const image of IMAGES) {
    const outPath = path.join(ASSET_OUT_DIR, image.file);
    if (!fs.existsSync(outPath)) {
      if (image.kind === "download") {
        const response = await fetch(image.url);
        if (!response.ok) throw new Error(`下載 ${image.url} 失敗：HTTP ${response.status}`);
        fs.writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));
      } else if (image.id === "text_hello") {
        const font = makeTextImage(outPath, 448);
        report.push({ id: image.id, generator: `imagemagick-annotate(${font})` });
      } else {
        svgToPng(path.join(ASSET_SRC_DIR, image.svg), outPath, 448);
        report.push({ id: image.id, generator: "svg" });
      }
    }
    report.push({ id: image.id, file: outPath, bytes: fs.statSync(outPath).size });
  }
  for (const item of report) {
    if (item.bytes !== undefined) console.log(`[assets] ${item.id.padEnd(16)} ${humanBytes(item.bytes).padStart(9)}  ${item.file}`);
    else console.log(`[assets] ${item.id.padEnd(16)} (${item.generator})`);
  }
}

await main();
