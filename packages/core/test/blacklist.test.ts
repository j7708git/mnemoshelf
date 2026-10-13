import { describe, expect, it } from "vitest";
import { blockedReason, isBlocked } from "../src/roots/blacklist.js";

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

  it("blockedReason 說明命中的類別", () => {
    expect(blockedReason("notes/readme.md")).toBeNull();
    expect(blockedReason(".ssh/id_rsa")).toBe("受保護的設定或金鑰目錄");
    expect(blockedReason("cert.pem")).toBe("受保護的檔名樣式");
  });
});
