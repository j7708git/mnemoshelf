/**
 * 更新完整性（U4）：SHA512 checksum 與離線行為，以及「不關閉簽章驗證」的原始碼護欄。
 *
 * electron-updater 需要真的 Electron 才能載入，這裡用 fake updater 重現它的下載契約：
 * 下載完成前比對 `latest*.yml` 的 sha512（base64）與檔案內容；不符就丟
 * `ERR_CHECKSUM_MISMATCH`，狀態機停在 error，不進入安裝。
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdater, type CreateUpdaterOptions, type UpdaterController } from "../src/updater/index.js";
import { FakeAutoUpdater } from "./fakes/updater.js";

const tempDirs: string[] = [];
const controllers: UpdaterController[] = [];

afterEach(async () => {
  for (const controller of controllers) controller.stop();
  controllers.length = 0;
  for (const dir of tempDirs) await fs.rm(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-u4-integrity-"));
  tempDirs.push(dir);
  return dir;
}

interface Harness {
  fake: FakeAutoUpdater;
  controller: UpdaterController;
}

function setup(options: Partial<CreateUpdaterOptions> = {}): Harness {
  const fake = new FakeAutoUpdater();
  const controller = createUpdater({
    platform: "linux",
    currentVersion: "0.4.1",
    isPackaged: true,
    headless: false,
    env: { APPIMAGE: path.join(os.tmpdir(), "Mnemoshelf-0.4.1-linux-x86_64.AppImage") },
    argv: [],
    execPath: path.join(os.tmpdir(), "Mnemoshelf-0.4.1-linux-x86_64.AppImage"),
    loadAutoUpdater: vi.fn(async () => fake),
    closeServerOnly: vi.fn(async () => undefined),
    installWatchdogMs: 0,
    initialCheckDelayMs: -1,
    checkIntervalMs: 0,
    ...options,
  });
  controllers.push(controller);
  return { fake, controller };
}

async function reachAvailable(fake: FakeAutoUpdater, controller: UpdaterController): Promise<void> {
  fake.checkForUpdates.mockImplementation(async () => {
    fake.emit("checking-for-update");
    fake.emit("update-available", { version: "0.5.1", releaseNotes: null });
    return null;
  });
  const state = await controller.check({ manual: true });
  expect(state.state).toBe("available");
}

interface UpdateFixture {
  payloadPath: string;
  metadataPath: string;
}

/**
 * 建立假的更新檔與 metadata（`latest-linux.yml` 的最小形狀）。
 *
 * `sha512` 的格式與 electron-builder 一致：檔案的 SHA-512、base64 編碼。
 */
async function createFixture(root: string, metadataSha512?: string): Promise<UpdateFixture> {
  const payloadPath = path.join(root, "Mnemoshelf-0.5.1-linux-x86_64.AppImage");
  await fs.writeFile(payloadPath, Buffer.from("fake AppImage bytes\n"));
  const metadataPath = path.join(root, "latest-linux.yml.json");
  const sha512 =
    metadataSha512 ?? createHash("sha512").update(await fs.readFile(payloadPath)).digest("base64");
  await fs.writeFile(metadataPath, JSON.stringify({ version: "0.5.1", path: path.basename(payloadPath), sha512 }));
  return { payloadPath, metadataPath };
}

/** 讓 fake 的 downloadUpdate 像 electron-updater 一樣先驗 checksum，再發 update-downloaded。 */
function gateDownloadOnChecksum(fake: FakeAutoUpdater, fixture: UpdateFixture): void {
  fake.downloadUpdate.mockImplementation(async () => {
    const metadata = JSON.parse(await fs.readFile(fixture.metadataPath, "utf8")) as {
      version: string;
      sha512: string;
    };
    const actual = createHash("sha512").update(await fs.readFile(fixture.payloadPath)).digest("base64");
    if (actual !== metadata.sha512) {
      throw Object.assign(new Error("sha512 checksum mismatch after full download"), {
        code: "ERR_CHECKSUM_MISMATCH",
      });
    }
    fake.emit("download-progress", { percent: 100, transferred: 1, total: 1, bytesPerSecond: 1 });
    fake.emit("update-downloaded", { version: metadata.version });
    return null;
  });
}

describe("SHA512 完整性", () => {
  it("checksum 相符 → downloaded，才可安裝", async () => {
    const root = await tempDir();
    const fixture = await createFixture(root);
    const { fake, controller } = setup();
    await reachAvailable(fake, controller);
    gateDownloadOnChecksum(fake, fixture);

    const downloaded = await controller.download();
    expect(downloaded.state).toBe("downloaded");
    expect(downloaded.error).toBeNull();

    fake.quitAndInstall.mockImplementation(() => undefined);
    const installing = await controller.install();
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(installing.state).toBe("installing");
  });

  it("檔案被篡改 → checksum 錯誤，不呼叫 quitAndInstall、目前版本不變", async () => {
    const root = await tempDir();
    const fixture = await createFixture(root);
    // metadata 是正確的，下載到的檔案多了一個 byte。
    await fs.appendFile(fixture.payloadPath, "tampered");
    const { fake, controller } = setup();
    await reachAvailable(fake, controller);
    gateDownloadOnChecksum(fake, fixture);

    const state = await controller.download();
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("checksum");
    expect(state.error?.message).toContain("更新檔驗證失敗");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(state.currentVersion).toBe("0.4.1");

    // 安裝流程不會從 error 狀態啟動。
    const afterInstall = await controller.install();
    expect(afterInstall.state).toBe("error");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it("metadata 的 sha512 被篡改 → checksum 錯誤，不進入安裝", async () => {
    const root = await tempDir();
    const wrongSha512 = createHash("sha512").update("different content").digest("base64");
    const fixture = await createFixture(root, wrongSha512);
    const { fake, controller } = setup();
    await reachAvailable(fake, controller);
    gateDownloadOnChecksum(fake, fixture);

    const state = await controller.download();
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("checksum");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(state.currentVersion).toBe("0.4.1");
  });

  it("原始碼沒有關閉 electron-updater 的簽章驗證開關", async () => {
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (await fs.readdir(srcDir, { recursive: true })).filter(
      (file) => file.endsWith(".ts") || file.endsWith(".cts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await fs.readFile(path.join(srcDir, file), "utf8");
      expect(source, `${file} 不應設定 verifyUpdateCodeSignature`).not.toContain("verifyUpdateCodeSignature");
    }

    // electron-builder 設定也不能有實際生效的開關（註解可以說明「不要設」）。
    const builderConfig = await fs.readFile(new URL("../electron-builder.yml", import.meta.url), "utf8");
    const activeConfig = builderConfig
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(activeConfig).not.toContain("verifyUpdateCodeSignature");
  });
});

describe("離線", () => {
  it("檢查更新失敗（離線）→ 可讀錯誤、不崩潰、目前版本不變、不能安裝", async () => {
    const { fake, controller } = setup();
    fake.checkForUpdates.mockRejectedValue(
      Object.assign(new Error("net::ERR_INTERNET_DISCONNECTED"), { code: "ERR_INTERNET_DISCONNECTED" }),
    );

    const state = await controller.check({ manual: true });
    expect(state.state).toBe("error");
    expect(state.error?.code).toBe("offline");
    expect(state.error?.message).toContain("網路不可用");
    expect(state.currentVersion).toBe("0.4.1");
    expect(state.availableVersion).toBeNull();

    const afterInstall = await controller.install();
    expect(afterInstall.state).toBe("error");
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });
});
