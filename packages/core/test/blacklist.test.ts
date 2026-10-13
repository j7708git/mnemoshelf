import { describe, expect, it } from "vitest";
import { blockedReason, isBlocked, normalizeSegment } from "../src/roots/blacklist.js";

describe("isBlocked", () => {
  it("擋掉設定與金鑰目錄", () => {
    expect(isBlocked(".ssh")).toBe(true);
    expect(isBlocked(".ssh/id_rsa")).toBe(true);
    expect(isBlocked("notes/.ssh/id_rsa")).toBe(true);
    expect(isBlocked(".gnupg/secring.gpg")).toBe(true);
    expect(isBlocked(".password-store/work/email.gpg")).toBe(true);
    expect(isBlocked(".aws/credentials")).toBe(true);
    expect(isBlocked(".kube/config")).toBe(true);
  });

  it("擋掉機密檔名樣式", () => {
    expect(isBlocked(".env")).toBe(true);
    expect(isBlocked(".env.local")).toBe(true);
    expect(isBlocked("config/.env.production")).toBe(true);
    expect(isBlocked("id_rsa")).toBe(true);
    expect(isBlocked("keys/id_rsa.pub")).toBe(true);
    expect(isBlocked("id_ed25519")).toBe(true);
    expect(isBlocked("cert.pem")).toBe(true);
    expect(isBlocked("server.key")).toBe(true);
    expect(isBlocked("bundle.p12")).toBe(true);
    expect(isBlocked("vault.kdbx")).toBe(true);
  });

  it("放行 .env.example，且不誤判 .environment.md", () => {
    expect(isBlocked(".env.example")).toBe(false);
    expect(isBlocked("config/.env.example")).toBe(false);
    expect(isBlocked(".environment.md")).toBe(false);
    expect(isBlocked("docs/environment.md")).toBe(false);
  });

  it("一般檔案與目錄不命中", () => {
    expect(isBlocked("")).toBe(false);
    expect(isBlocked("notes/readme.md")).toBe(false);
    expect(isBlocked("src/keys.ts")).toBe(false);
    expect(isBlocked("environment/setup.md")).toBe(false);
    // 只是名稱包含關鍵字，不是路徑片段
    expect(isBlocked("notes/ssh-notes.md")).toBe(false);
    expect(isBlocked("myenv.md")).toBe(false);
  });

  it("大小寫不敏感", () => {
    expect(isBlocked(".SSH/id_rsa")).toBe(true);
    expect(isBlocked(".Env")).toBe(true);
    expect(isBlocked("ID_RSA")).toBe(true);
    expect(isBlocked("Cert.PEM")).toBe(true);
    expect(isBlocked(".Env.Example")).toBe(false);
  });

  it("同時接受 POSIX 與 Windows 分隔符", () => {
    expect(isBlocked("C:\\data\\project\\.ssh\\id_rsa")).toBe(true);
    expect(isBlocked("C:\\data\\project\\.env")).toBe(true);
    expect(isBlocked("C:\\data\\project\\.env.example")).toBe(false);
    expect(isBlocked("notes\\sub\\.password-store\\x.gpg")).toBe(true);
  });

  describe("Windows 路徑變形（注入 platform='win32' 模擬，不需真的在 Windows 跑）", () => {
    it("尾端的點與空白會被忽略（Windows 語意）", () => {
      expect(isBlocked(".env.", "win32")).toBe(true);
      expect(isBlocked(".ssh ", "win32")).toBe(true);
      expect(isBlocked("notes\\.gnupg. ", "win32")).toBe(true);
      expect(isBlocked("id_rsa.", "win32")).toBe(true);
      expect(isBlocked("cert.pem ", "win32")).toBe(true);
      // 放行清單仍優先：去掉尾點後是 .env.example
      expect(isBlocked(".env.example.", "win32")).toBe(false);
      // 去掉尾點後是 .environment.md，仍不誤判
      expect(isBlocked(".environment.md.", "win32")).toBe(false);
    });

    it("NTFS ADS（`:stream`）只比對 `:` 之前的部分", () => {
      expect(isBlocked(".env::$DATA", "win32")).toBe(true);
      expect(isBlocked(".env::$data", "win32")).toBe(true);
      expect(isBlocked("notes\\.ssh::$DATA\\x", "win32")).toBe(true);
      expect(isBlocked("id_rsa:stream", "win32")).toBe(true);
      expect(isBlocked(".env.example::$DATA", "win32")).toBe(false);
      expect(isBlocked("readme.md:$DATA", "win32")).toBe(false);
    });

    it("非 Windows 平台不做這些正規化（行為不變）", () => {
      for (const platform of ["linux", "darwin"] as const) {
        expect(isBlocked(".env.", platform)).toBe(false);
        expect(isBlocked(".ssh ", platform)).toBe(false);
        expect(isBlocked(".env::$DATA", platform)).toBe(false);
        // 原本就會命中的仍命中
        expect(isBlocked(".env", platform)).toBe(true);
        expect(isBlocked(".ssh/id_rsa", platform)).toBe(true);
      }
    });

    it("normalizeSegment 的正規化結果（供除錯與文件）", () => {
      expect(normalizeSegment(".env.", "win32")).toBe(".env");
      expect(normalizeSegment(".ssh ", "win32")).toBe(".ssh");
      expect(normalizeSegment(".env::$DATA", "win32")).toBe(".env");
      expect(normalizeSegment(".env.::$DATA", "win32")).toBe(".env");
      expect(normalizeSegment(".ENV.", "win32")).toBe(".env");
      expect(normalizeSegment(".env.", "linux")).toBe(".env.");
      expect(normalizeSegment(".ENV", "linux")).toBe(".env");
    });

    it("Windows 的變形也會反映在 blockedReason", () => {
      expect(blockedReason(".env.", "win32")).toBe("受保護的檔名樣式");
      expect(blockedReason(".ssh ", "win32")).toBe("受保護的設定或金鑰目錄");
      expect(blockedReason(".env.", "linux")).toBeNull();
    });
  });

  it("blockedReason 說明命中的類別", () => {
    expect(blockedReason("notes/readme.md")).toBeNull();
    expect(blockedReason(".ssh/id_rsa")).toBe("受保護的設定或金鑰目錄");
    expect(blockedReason("cert.pem")).toBe("受保護的檔名樣式");
  });
});
