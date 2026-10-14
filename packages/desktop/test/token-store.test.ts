import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateToken, toTokenInfo, type SafeStorageLike } from "../src/token-store.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemoshelf-token-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** 假的 safeStorage：把密文加上固定前綴，用來確認真的經過加密路徑。 */
function fakeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (encrypted) => {
      const text = encrypted.toString("utf8");
      if (!text.startsWith("enc:")) throw new Error("無法解密");
      return text.slice(4);
    },
  };
}

const tokenFile = (): string => path.join(dir, "token.bin");

describe("loadOrCreateToken", () => {
  it("第一次啟動產生 token 並以密文落地（0600）", async () => {
    const state = await loadOrCreateToken({ tokenFile: tokenFile(), storage: fakeStorage(), generate: () => "generated-token" });
    expect(state.token).toBe("generated-token");
    expect(state.source).toBe("generated");
    expect(state.persisted).toBe(true);
    expect(state.notice).toBeNull();

    const raw = await fs.readFile(tokenFile(), "utf8");
    expect(raw).toBe("enc:generated-token");
    expect(raw).not.toContain("generated-token\n");
    const mode = (await fs.stat(tokenFile())).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("第二次啟動沿用同一個 token（不再重新產生）", async () => {
    await loadOrCreateToken({ tokenFile: tokenFile(), storage: fakeStorage(), generate: () => "first" });
    const second = await loadOrCreateToken({ tokenFile: tokenFile(), storage: fakeStorage(), generate: () => "second" });
    expect(second.token).toBe("first");
    expect(second.source).toBe("stored");
    expect(second.persisted).toBe(true);
  });

  it("環境變數有值時沿用，且不落地", async () => {
    const state = await loadOrCreateToken({
      tokenFile: tokenFile(),
      storage: fakeStorage(),
      env: { MNEMOSHELF_TOKEN: "from-env" },
      generate: () => "generated",
    });
    expect(state).toMatchObject({ token: "from-env", source: "env", persisted: false, notice: null });
    await expect(fs.stat(tokenFile())).rejects.toThrow();
  });

  it("密文解不開時重新產生（金鑰庫換了、檔案被截斷等）", async () => {
    await fs.writeFile(tokenFile(), "not-our-format");
    const state = await loadOrCreateToken({ tokenFile: tokenFile(), storage: fakeStorage(), generate: () => "recovered" });
    expect(state).toMatchObject({ token: "recovered", source: "generated", persisted: true });
    expect(await fs.readFile(tokenFile(), "utf8")).toBe("enc:recovered");
  });

  it("沒有可用的加密後端：只留在本次執行，不寫任何檔案", async () => {
    const state = await loadOrCreateToken({
      tokenFile: tokenFile(),
      storage: fakeStorage(false),
      generate: () => "session-token",
    });
    expect(state.source).toBe("session");
    expect(state.persisted).toBe(false);
    expect(state.encryptionAvailable).toBe(false);
    expect(state.notice).toContain("金鑰庫");
    await expect(fs.stat(tokenFile())).rejects.toThrow();
  });

  it("寫入失敗時仍可用（token 只留在本次執行）並回報可讀訊息", async () => {
    const state = await loadOrCreateToken({
      tokenFile: path.join(dir, "nope", "token.bin"),
      storage: {
        isEncryptionAvailable: () => true,
        encryptString: () => {
          throw new Error("金鑰庫拒絕存取");
        },
        decryptString: () => "",
      },
      generate: () => "unpersisted",
    });
    expect(state.token).toBe("unpersisted");
    expect(state.persisted).toBe(false);
    expect(state.notice).toContain("無法寫入");
  });

  it("環境變數只有空白時視為沒有設定", async () => {
    const state = await loadOrCreateToken({
      tokenFile: tokenFile(),
      storage: fakeStorage(),
      env: { MNEMOSHELF_TOKEN: "   " },
      generate: () => "generated",
    });
    expect(state.source).toBe("generated");
  });
});

describe("toTokenInfo", () => {
  it("外送的狀態不含 token 本身", () => {
    const info = toTokenInfo({
      token: "secret",
      source: "generated",
      persisted: true,
      encryptionAvailable: true,
      location: "/tmp/token.bin",
      notice: null,
    });
    expect(Object.keys(info).sort()).toEqual(["encryptionAvailable", "location", "notice", "persisted", "source"]);
    expect(JSON.stringify(info)).not.toContain("secret");
  });
});
