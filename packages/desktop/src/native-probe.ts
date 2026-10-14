/**
 * 原生模組載入探測（spike 驗收用）。
 *
 * 目的：把「四個原生模組（含它們的平台二進位套件）被解析到哪裡、原生檔案在哪、
 * 是不是從 `app.asar.unpacked` 載入」寫進啟動 log，作為「asar 內載入原生模組成功」的證據。
 *
 * 只做路徑探測（`require.resolve` ＋ 目錄掃描），不主動載入模組；真正的載入由
 * 啟動 server／索引／縮圖流程觸發。
 *
 * 平台二進位的實際位置不在主套件裡：`sqlite-vec` 的 `vec0.so` 在 `sqlite-vec-<os>-<arch>`、
 * `sharp` 的在 `@img/sharp-<platform>-<arch>`（`libvips` 另在 `@img/sharp-libvips-…`），
 * 因此兩邊都探。這些平台套件的 `exports` 只有特定欄位（沒有 main／沒有 `./package.json`），
 * 所以要用它們真的開放的規格去解析。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { toUnpackedPath } from "./asar-paths.js";

/** 受探測的原生模組（皆為 N-API／Node-API，理論上不需 rebuild，見研究檔）。 */
export const NATIVE_MODULE_NAMES = ["better-sqlite3", "sqlite-vec", "onnxruntime-node", "sharp"] as const;

/** 原生二進位的副檔名。 */
const NATIVE_EXTENSIONS = [".node", ".so", ".dylib", ".dll"];
/** 單一套件最多列出幾個二進位檔（避免 log 被 8 個平台的 prebuild 洗版）。 */
const MAX_LISTED_FILES = 6;

/** 一個套件的探測結果。 */
export interface NativeModuleReport {
  /** 這一輪探測的套件名（主套件或平台二進位套件）。 */
  name: string;
  /** 這個套件是為了哪個原生模組而探（主套件時與 `name` 相同）。 */
  owner: string;
  /** 實際解析到的進入點；解析失敗時為 null。 */
  packageEntry: string | null;
  /** 套件目錄內找到的原生二進位（相對套件目錄的路徑，已排序）。 */
  nativeFiles: string[];
  /** 原生二進位實際所在：`app.asar` 內、`app.asar.unpacked`、或開發目錄（`filesystem`）。 */
  location: "asar" | "unpacked" | "filesystem" | "unknown";
  /** 額外線索（例如 sqlite-vec 交給 `loadExtension` 的路徑）。 */
  detail: string | null;
  error: string | null;
}

/** 判斷路徑落在哪一種容器內（只看字串，不看檔案是否存在）。 */
export function classifyLocation(target: string): NativeModuleReport["location"] {
  const normalized = target.split(path.sep).join("/");
  if (normalized.includes("app.asar.unpacked/")) return "unpacked";
  if (normalized.includes("app.asar/")) return "asar";
  if (target.trim() === "") return "unknown";
  return "filesystem";
}

/**
 * 判定原生二進位的實際位置。
 *
 * `require.resolve` 在 Electron 內一律回報 asar 內的路徑（即使是解包過的檔案）；
 * 因此再看 `app.asar.unpacked` 有沒有同名檔案——有的話 Electron 只會用到那一份。
 */
export function locate(anchor: string): NativeModuleReport["location"] {
  const unpacked = toUnpackedPath(anchor);
  if (unpacked !== null && fs.existsSync(unpacked)) return "unpacked";
  return classifyLocation(anchor);
}

/** 原生二進位的檔名判斷（含版本化的共用函式庫，例如 `libvips-cpp.so.8.18.7`、`libonnxruntime.so.1`）。 */
export function isNativeBinary(fileName: string): boolean {
  return NATIVE_EXTENSIONS.some((extension) => fileName.endsWith(extension) || fileName.includes(`${extension}.`));
}

/** 套件目錄內的原生二進位檔（相對路徑、已排序）。 */
export function findNativeFiles(packageDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (isNativeBinary(entry.name)) {
        found.push(path.relative(packageDir, full));
      }
    }
  };
  walk(packageDir);
  return found.sort();
}

/** 由解析到的進入點回推套件目錄（往上有 `package.json` 的那一層）。 */
export function packageRootOf(entry: string): string {
  let dir = path.dirname(entry);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(entry);
}

/** 平台動態庫的副檔名。 */
function libraryExtension(platform: string): string {
  if (platform === "win32") return "dll";
  if (platform === "darwin") return "dylib";
  return "so";
}

/** 平台二進位套件，以及用它自己開放的 exports 規格解析的進入點。 */
export interface PlatformPackageProbe {
  name: string;
  specifier: string;
}

/**
 * 平台二進位套件的探測清單（由 platform／arch 推導；不硬寫 Linux）。
 *
 * - `sqlite-vec` 的命名把 `win32` 寫成 `windows`，`exports` 只開放 `./vec0.<ext>`。
 * - `sharp` 分成 `@img/sharp-<platform>-<arch>`（`./sharp.node`）與
 *   `@img/sharp-libvips-<platform>-<arch>`（`./package`，因為二進位不在 exports 的 main 路徑上）。
 */
export function platformPackageProbes(owner: string, platform: string, arch: string): PlatformPackageProbe[] {
  if (owner === "sqlite-vec") {
    const os = platform === "win32" ? "windows" : platform;
    const name = `sqlite-vec-${os}-${arch}`;
    return [{ name, specifier: `${name}/vec0.${libraryExtension(platform)}` }];
  }
  if (owner === "sharp") {
    const sharp = `@img/sharp-${platform}-${arch}`;
    const libvips = `@img/sharp-libvips-${platform}-${arch}`;
    return [
      { name: sharp, specifier: `${sharp}/sharp.node` },
      { name: libvips, specifier: `${libvips}/package` },
    ];
  }
  return [];
}

/** 依序嘗試多個規格解析，回傳第一個成功的進入點。 */
function resolveFirst(specifiers: readonly string[], resolve: (id: string) => string): string {
  let lastError: unknown = null;
  for (const specifier of specifiers) {
    try {
      return resolve(specifier);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 探測單一套件；任何錯誤都收進 `error`，不讓探測本身中斷啟動。 */
export function probePackage(
  name: string,
  owner: string,
  resolve: (id: string) => string,
  specifiers: readonly string[] = [name],
  requireModule?: (id: string) => unknown,
): NativeModuleReport {
  try {
    const entry = resolveFirst(specifiers, resolve);
    const root = packageRootOf(entry);
    let detail: string | null = null;
    if (owner === "sqlite-vec" && name === "sqlite-vec" && requireModule !== undefined) {
      try {
        const loaded = requireModule("sqlite-vec") as { getLoadablePath?: () => string } | null;
        const loadable = loaded?.getLoadablePath?.();
        detail =
          loadable === undefined
            ? "getLoadablePath() 不可用"
            : `loadExtension 會拿到 ${loadable}（實際位置：${locate(loadable)}）`;
      } catch (error) {
        detail = `載入 sqlite-vec 失敗：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const nativeFiles = findNativeFiles(root);
    const anchor = nativeFiles.length > 0 ? path.join(root, nativeFiles[0]!) : entry;
    return { name, owner, packageEntry: entry, nativeFiles, location: locate(anchor), detail, error: null };
  } catch (error) {
    return {
      name,
      owner,
      packageEntry: null,
      nativeFiles: [],
      detail: null,
      location: "unknown",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 探測全部原生模組與其平台二進位套件（以本檔所在位置為解析起點，即打包後的 `app.asar/dist`）。 */
export function probeNativeModules(
  moduleNames: readonly string[] = NATIVE_MODULE_NAMES,
  platform: string = process.platform,
  arch: string = process.arch,
): NativeModuleReport[] {
  const requireFromApp = createRequire(import.meta.url);
  const resolve = (id: string): string => requireFromApp.resolve(id);
  const requireModule = (id: string): unknown => requireFromApp(id) as unknown;
  const reports: NativeModuleReport[] = [];
  for (const name of moduleNames) {
    reports.push(probePackage(name, name, resolve, [name], requireModule));
    for (const probe of platformPackageProbes(name, platform, arch)) {
      reports.push(probePackage(probe.name, name, resolve, [probe.specifier, `${probe.name}/package.json`, probe.name]));
    }
  }
  return reports;
}

/** 人類可讀的探測摘要（一行一套件）。 */
export function formatProbe(report: NativeModuleReport): string {
  const label = report.name === report.owner ? report.name : `${report.name}（${report.owner} 的平台套件）`;
  if (report.error !== null) return `- ${label}: ✗ 解析失敗（${report.error}）`;
  const listed = report.nativeFiles.slice(0, MAX_LISTED_FILES).join(", ");
  const more = report.nativeFiles.length > MAX_LISTED_FILES ? ` …（共 ${report.nativeFiles.length} 個）` : "";
  const files = report.nativeFiles.length === 0 ? "（未找到原生二進位）" : `${listed}${more}`;
  const detail = report.detail === null ? "" : `；${report.detail}`;
  return `- ${label}: ${report.location}；二進位：${files}；進入點：${report.packageEntry}${detail}`;
}
