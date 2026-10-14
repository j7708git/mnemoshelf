import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyLocation,
  findNativeFiles,
  formatProbe,
  isNativeBinary,
  locate,
  packageRootOf,
  platformPackageProbes,
  probePackage,
} from "../src/native-probe.js";

const createdDirs: string[] = [];

function makeFixtureTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mnemoshelf-probe-"));
  createdDirs.push(root);
  fs.mkdirSync(path.join(root, "prebuilds", "linux-x64"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture","main":"index.js"}\n');
  fs.writeFileSync(path.join(root, "prebuilds", "linux-x64", "binding.node"), "x");
  fs.writeFileSync(path.join(root, "README.md"), "x");
  return root;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("classifyLocation", () => {
  it("分辨 app.asar、app.asar.unpacked 與一般檔案系統", () => {
    const asar = ["app.asar", "node_modules", "sharp", "lib.js"].join(path.sep);
    const unpacked = ["app.asar.unpacked", "node_modules", "sharp", "lib.js"].join(path.sep);
    const plain = ["repo", "packages", "desktop", "dist", "main.js"].join(path.sep);
    expect(classifyLocation(asar)).toBe("asar");
    expect(classifyLocation(unpacked)).toBe("unpacked");
    expect(classifyLocation(plain)).toBe("filesystem");
    expect(classifyLocation("")).toBe("unknown");
  });
});

describe("locate", () => {
  it("asar 內的路徑若有 app.asar.unpacked 對應檔，判定為 unpacked", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "mnemoshelf-locate-"));
    createdDirs.push(base);
    const asarFile = path.join(base, "app.asar", "node_modules", "x", "y.node");
    const unpackedFile = path.join(base, "app.asar.unpacked", "node_modules", "x", "y.node");
    fs.mkdirSync(path.dirname(unpackedFile), { recursive: true });
    fs.writeFileSync(unpackedFile, "x");
    expect(locate(asarFile)).toBe("unpacked");
    // 沒有對應檔時仍算 asar（= 真的被包在 asar 內）。
    expect(locate(path.join(base, "app.asar", "node_modules", "z", "w.node"))).toBe("asar");
  });
});

describe("findNativeFiles", () => {
  it("遞迴找出原生二進位並以相對路徑排序", () => {
    const root = makeFixtureTree();
    expect(findNativeFiles(root)).toEqual([path.join("prebuilds", "linux-x64", "binding.node")]);
  });

  it("版本化的共用函式庫也算原生二進位（libvips-cpp.so.8.18.7、libonnxruntime.so.1）", () => {
    expect(isNativeBinary("libvips-cpp.so.8.18.7")).toBe(true);
    expect(isNativeBinary("libonnxruntime.so.1")).toBe(true);
    expect(isNativeBinary("libonnxruntime.1.30.0.dylib")).toBe(true);
    expect(isNativeBinary("onnxruntime.dll")).toBe(true);
    expect(isNativeBinary("index.js")).toBe(false);
    expect(isNativeBinary("README.md")).toBe(false);
  });

  it("目錄不存在時回空陣列（不拋錯）", () => {
    expect(findNativeFiles(path.join(os.tmpdir(), "mnemoshelf-probe-does-not-exist"))).toEqual([]);
  });
});

describe("packageRootOf", () => {
  it("由進入點往上找到最近的 package.json", () => {
    const root = makeFixtureTree();
    expect(packageRootOf(path.join(root, "prebuilds", "linux-x64", "binding.node"))).toBe(root);
  });
});

describe("platformPackageProbes", () => {
  it("sqlite-vec 的 windows 平台包寫成 windows（不是 win32），規格是 ./vec0.<ext>", () => {
    expect(platformPackageProbes("sqlite-vec", "linux", "x64")).toEqual([
      { name: "sqlite-vec-linux-x64", specifier: "sqlite-vec-linux-x64/vec0.so" },
    ]);
    expect(platformPackageProbes("sqlite-vec", "win32", "x64")).toEqual([
      { name: "sqlite-vec-windows-x64", specifier: "sqlite-vec-windows-x64/vec0.dll" },
    ]);
    expect(platformPackageProbes("sqlite-vec", "darwin", "arm64")).toEqual([
      { name: "sqlite-vec-darwin-arm64", specifier: "sqlite-vec-darwin-arm64/vec0.dylib" },
    ]);
  });

  it("sharp 探測 @img 的兩個平台包（各用自己開放的 exports 規格）", () => {
    expect(platformPackageProbes("sharp", "linux", "x64")).toEqual([
      { name: "@img/sharp-linux-x64", specifier: "@img/sharp-linux-x64/sharp.node" },
      { name: "@img/sharp-libvips-linux-x64", specifier: "@img/sharp-libvips-linux-x64/package" },
    ]);
  });

  it("其他模組沒有額外的平台包", () => {
    expect(platformPackageProbes("better-sqlite3", "linux", "x64")).toEqual([]);
    expect(platformPackageProbes("onnxruntime-node", "linux", "x64")).toEqual([]);
  });
});

describe("probePackage", () => {
  it("回報原生二進位與容器位置；解析失敗時收進 error 而不拋錯", () => {
    const root = makeFixtureTree();
    const report = probePackage("fixture", "fixture", () => path.join(root, "index.js"));
    expect(report.error).toBeNull();
    expect(report.nativeFiles).toEqual([path.join("prebuilds", "linux-x64", "binding.node")]);
    expect(report.location).toBe("filesystem");
    expect(formatProbe(report)).toContain("binding.node");

    const broken = probePackage("missing", "missing", () => {
      throw new Error("Cannot find module 'missing'");
    });
    expect(broken.packageEntry).toBeNull();
    expect(broken.error).toContain("Cannot find module");
    expect(formatProbe(broken)).toContain("解析失敗");
  });

  it("依序嘗試多個規格（平台套件的 exports 只開放特定欄位）", () => {
    const root = makeFixtureTree();
    const tried: string[] = [];
    const entry = probePackage("platform-pkg", "sqlite-vec", (id) => {
      tried.push(id);
      if (id === "platform-pkg/vec0.so") throw new Error("no such export");
      return path.join(root, "index.js");
    }, ["platform-pkg/vec0.so", "platform-pkg/package.json"]);
    expect(tried).toEqual(["platform-pkg/vec0.so", "platform-pkg/package.json"]);
    expect(entry.packageEntry).toBe(path.join(root, "index.js"));
  });

  it("sqlite-vec 會回報 loadExtension 實際拿到的路徑", () => {
    const root = makeFixtureTree();
    const report = probePackage(
      "sqlite-vec",
      "sqlite-vec",
      () => path.join(root, "index.js"),
      ["sqlite-vec"],
      () => ({ getLoadablePath: () => path.join(root, "prebuilds", "linux-x64", "binding.node") }),
    );
    expect(report.detail).toContain("loadExtension 會拿到");
  });

  it("平台套件的摘要會標明是哪個模組的", () => {
    const report = probePackage("sqlite-vec-linux-x64", "sqlite-vec", () => {
      throw new Error("Cannot find module 'sqlite-vec-linux-x64'");
    });
    expect(formatProbe(report)).toContain("sqlite-vec 的平台套件");
  });
});
