import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelBootstrap, type BootstrapState, type ModelBootstrapContext } from "../src/model-bootstrap.js";
import { MODEL_PROFILE, modelRootDir } from "../src/model-profile.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-bootstrap-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const modelDirOf = (): string => modelRootDir(dir, MODEL_PROFILE);

/** 假的下載器：把「必要檔案」寫到磁碟（每個 16 bytes），並回報進度。 */
function fakeDownload(options: { failTimes?: number; progressFiles?: string[] } = {}) {
  const failures = { count: 0 };
  const remaining = options.failTimes ?? 0;
  const download = async (context: ModelBootstrapContext): Promise<void> => {
    if (failures.count < remaining) {
      failures.count += 1;
      // 模擬網路中斷：先把部分檔案寫下去（用來驗證重試會重用已完成的檔案）。
      const partial = MODEL_PROFILE.essentialFiles[0]!;
      const full = path.join(modelDirOf(), ...partial.split("/"));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, Buffer.alloc(16, 1));
      // 中斷時留下的暫存檔（FileCache 的命名）。
      await fs.writeFile(`${full}.tmp.999.tag`, Buffer.alloc(32, 2));
      throw new Error(`模擬第 ${failures.count} 次網路中斷`);
    }
    for (const file of options.progressFiles ?? MODEL_PROFILE.essentialFiles) {
      context.onProgress({ status: "download", file });
      context.onProgress({ status: "progress", file, loaded: 8, total: 16 });
    }
    for (const file of MODEL_PROFILE.essentialFiles) {
      const full = path.join(modelDirOf(), ...file.split("/"));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, Buffer.alloc(16, 3));
    }
  };
  return { download, failures };
}

function bootstrap(options: {
  download: (context: ModelBootstrapContext) => Promise<void>;
  verify?: () => Promise<void>;
  updates?: BootstrapState[];
  maxAttempts?: number;
}): ModelBootstrap {
  return new ModelBootstrap({
    profile: MODEL_PROFILE,
    modelDir: dir,
    download: options.download,
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.updates === undefined ? {} : { onUpdate: (state) => options.updates!.push(state) }),
    // 測試不真的等退避時間。
    delay: async () => {},
    retryDelayMs: () => 0,
  });
}

describe("ModelBootstrap", () => {
  it("磁碟上已經有模型時直接就緒，不下載", async () => {
    for (const file of MODEL_PROFILE.essentialFiles) {
      const full = path.join(modelDirOf(), ...file.split("/"));
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, Buffer.alloc(16, 4));
    }
    let called = false;
    const state = await bootstrap({
      download: async () => {
        called = true;
      },
    }).start();
    expect(state.phase).toBe("ready");
    expect(called).toBe(false);
    expect(state.message).toContain("磁碟上的快取");
  });

  it("未就緒時下載、驗證後就緒", async () => {
    let verified = false;
    const fake = fakeDownload({ progressFiles: ["onnx/model_q4.onnx_data"] });
    const state = await bootstrap({
      download: fake.download,
      verify: async () => {
        verified = true;
      },
    }).start();
    expect(state.phase).toBe("ready");
    expect(verified).toBe(true);
    expect(state.missingFiles).toEqual([]);
  });

  it("下載失敗會自動重試，並在第二次成功（不清掉已完成的檔案）", async () => {
    const fake = fakeDownload({ failTimes: 1 });
    const updates: BootstrapState[] = [];
    const state = await bootstrap({ download: fake.download, updates }).start();
    expect(state.phase).toBe("ready");
    expect(state.failures).toHaveLength(1);
    expect(state.failures[0]!.error.message).toContain("網路中斷");
    // 第一次失敗時寫下的檔案被當成「已沿用」，所以第二次嘗試一開始就有進度。
    const secondAttempt = updates.find((item) => item.attempt === 2);
    expect(secondAttempt?.reusedBytes).toBeGreaterThan(0);
  });

  it("一再失敗時進入失敗狀態，附可讀訊息與處理建議", async () => {
    const fake = fakeDownload({ failTimes: 5 });
    const state = await bootstrap({ download: fake.download, maxAttempts: 3 }).start();
    expect(state.phase).toBe("failed");
    expect(state.failures).toHaveLength(3);
    expect(state.message).toContain("模型下載失敗");
    expect(state.hint).toContain("重試");
  });

  it("下載結束但檔案仍不齊全時視為失敗", async () => {
    const state = await bootstrap({
      download: async () => {
        // 什麼都不寫：模擬「沒有真的下載」。
      },
      maxAttempts: 1,
    }).start();
    expect(state.phase).toBe("failed");
    expect(state.lastError?.message).toContain("仍缺少必要檔案");
  });

  it("驗證失敗也算這一輪失敗（可重試）", async () => {
    let attempts = 0;
    const fake = fakeDownload();
    const state = await bootstrap({
      download: fake.download,
      verify: async () => {
        attempts += 1;
        throw new Error("模型載入失敗");
      },
      maxAttempts: 2,
    }).start();
    expect(attempts).toBe(2);
    expect(state.phase).toBe("failed");
    expect(state.lastError?.message).toBe("模型載入失敗");
  });

  it("中斷留下的暫存檔會被清掉並回報", async () => {
    const full = path.join(modelDirOf(), "config.json");
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(`${full}.tmp.4242.zz`, Buffer.alloc(8, 9));

    const state = await bootstrap({ download: fakeDownload().download }).start();
    expect(state.phase).toBe("ready");
    expect(state.removedTempFiles).toEqual(["config.json.tmp.4242.zz"]);
    await expect(fs.stat(`${full}.tmp.4242.zz`)).rejects.toThrow();
  });

  it("進行中重複呼叫 start() 不會跑兩輪；就緒後再呼叫也不會重下載", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = bootstrap({
      download: async (context) => {
        calls += 1;
        await gate;
        const fake = fakeDownload();
        await fake.download(context);
      },
    });
    const first = engine.start();
    const second = engine.start();
    // start() 先非同步確認磁碟狀態，稍等一下再確認下載只被觸發一次。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release!();
    const [stateA, stateB] = await Promise.all([first, second]);
    expect(stateA.phase).toBe("ready");
    expect(stateB.phase).toBe("ready");
    expect(calls).toBe(1);

    const again = await engine.start();
    expect(again.phase).toBe("ready");
    expect(calls).toBe(1);
  });
});
