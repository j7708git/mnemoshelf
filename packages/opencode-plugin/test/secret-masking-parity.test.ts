import { describe, expect, it } from "vitest";
import { maskSecrets as maskCore } from "../../core/src/privacy/secret-masking.js";
import { maskSecrets as maskDsh } from "../../dsh-plugin/src/secret-masking.js";
import { maskSecrets as maskOpenCode } from "../src/secret-masking.js";

describe("兩外掛與 core 機密遮罩的行為對照", () => {
  it("合成樣本涵蓋跨切塊、Unicode、所有規則與不該遮的文字", () => {
    const synthetic = "z".repeat(36);
    const cases = [
      "明文正常 😀\r\n",
      "x".repeat(1010) + " Bearer " + synthetic + "尾段",
      "-----BEGIN " + "PRIVATE KEY-----\r\n" + synthetic + "\r\n-----END " + "PRIVATE KEY-----",
      "-----BEGIN " + "PRIVATE KEY-----",
      `postgres://demo:pass/part@example.invalid`,
      `https://demo:pass@example.invalid`,
      `eyJ${"X".repeat(8)}.${"Y".repeat(10)}.${"Z".repeat(10)}`,
      ...["sk-", "ghp_", "github_pat_", "xoxb-", "AKIA", "AIza"].map((prefix) =>
        prefix + (prefix === "AKIA" ? "X".repeat(16) : prefix === "AIza" ? "x".repeat(35) : synthetic)),
      `password = "${synthetic}"`,
      `{ "SECRET_KEY_BASE": "${synthetic}" }`,
      `password = '${synthetic}'`,
      `access_token = ${synthetic}`,
      "password = PASSWORD_MIN_LENGTH",
      "password = process.env.DEMO_PASSWORD",
      'password = "process.env.DEMO_PASSWORD"',
      "token=[REDACTED:assignment]",
      `Bearer\t  ${synthetic}`,
      `password = "ghp_${synthetic}"`,
      "https://example.invalid:443/path?email=example@example.invalid",
    ];
    const core = cases.map(maskCore);
    expect(cases.map(maskOpenCode)).toEqual(core);
    expect(cases.map(maskDsh)).toEqual(core);
    expect(core.filter((result) => result.redacted).length).toBeGreaterThan(12);
    expect(core.map(({ text }) => maskOpenCode(text).redacted)).not.toContain(true);
  });
});
