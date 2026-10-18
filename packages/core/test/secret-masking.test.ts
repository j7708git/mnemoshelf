/**
 * 機密遮罩的單元測試（curated 規則；不追求全面）。
 *
 * **測試樣本安全**：所有「看起來像憑證」的字串都以片段拼接（`fake(...)`）在執行期組出，
 * 原始碼裡不會出現連續、可被 secret scanner 判真的字面憑證；樣本本身也是明顯假的。
 */
import { describe, expect, it } from "vitest";
import { containsRedacted, maskSecrets, REDACTED_PREFIX } from "../src/privacy/secret-masking.js";

/** 以片段拼接組出測試樣本（避免原始碼出現連續的憑證樣式）。 */
function fake(...parts: string[]): string {
  return parts.join("");
}

const pemRsa = [
  ["-----BEGIN", "RSA", "PRIVATE KEY-----"].join(" "),
  "MIIEfakefakefakefakefakefake",
  ["-----END", "RSA", "PRIVATE KEY-----"].join(" "),
].join("\n");

const samples = {
  pemRsa,
  pemOpenSsh: [
    ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" "),
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==",
    ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" "),
  ].join("\n"),
  openAiStyle: fake("s", "k-", "TESTPROJ", "_", "0123456789abcdefghij"),
  githubStyle: fake("gh", "p_", "0123456789abcdefghijklmn"),
  githubPatStyle: fake("github", "_pat_", "0123456789_abcdefghij"),
  slackStyle: fake("xox", "b-", "0123456789-abcd"),
  awsStyle: fake("AK", "IA", "ABCDEFGHIJKLMNOP"),
  googleStyle: fake("AI", "za", "0123456789abcdefghij0123456789abcde"),
  // JWT（第一段是 JSON header 的 base64url，`eyJ…`）。
  jwt: fake("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJ0ZXN0In0", ".", "c2lnbmF0dXJlMTIzNDU2"),
  bearer: fake("Bearer ", "abcdefghijklmnopqrstuvwxyz012345"),
  lowercaseBearer: fake("bearer ", "abcdefghijklmnopqrstuvwxyz012345"),
  connection: fake("post", "gres://", "demo", ":", "s3cretpass", "@", "db.example.test/app"),
  connectionEmptyUser: fake("post", "gres://", ":", "s3cretpass", "@", "db.example.test/app"),
  connectionSlashPassword: fake("my", "sql://", "demo", ":", "pa/ss", "@", "db.example.test/app"),
};

describe("maskSecrets：規則命中（真陽性）", () => {
  it("PEM 私鑰（RSA／OPENSSH、含截斷標頭）整段遮罩", () => {
    const rsa = maskSecrets(`前\n${samples.pemRsa}\n後`);
    expect(rsa.redacted).toBe(true);
    expect(rsa.count).toBe(1);
    expect(rsa.text).toContain(`${REDACTED_PREFIX}private-key]`);
    expect(rsa.text).not.toContain("MIIEfakefakefakefake");
    expect(rsa.text).toContain("前");
    expect(rsa.text).toContain("後");

    const openssh = maskSecrets(samples.pemOpenSsh);
    expect(openssh.text).toBe(`${REDACTED_PREFIX}private-key]`);

    const truncated = maskSecrets(`金鑰：${["-----BEGIN", "EC", "PRIVATE KEY-----"].join(" ")}`);
    expect(truncated.text).toContain(`${REDACTED_PREFIX}private-key]`);
  });

  it("常見 token 前綴（OpenAI／GitHub／GitHub PAT／Slack／AWS／Google）皆遮罩", () => {
    const secrets = [
      samples.openAiStyle,
      samples.githubStyle,
      samples.githubPatStyle,
      samples.slackStyle,
      samples.awsStyle,
      samples.googleStyle,
    ];
    for (const secret of secrets) {
      const result = maskSecrets(`值：${secret}`);
      expect(result.redacted, secret.slice(0, 2)).toBe(true);
      expect(result.text).toContain(`${REDACTED_PREFIX}token]`);
      expect(result.text).not.toContain(secret.slice(-12));
    }
  });

  it("F1：`sk-` 採 20 字元門檻（19 不遮、20 遮）", () => {
    const nineteen = fake("s", "k-", "a".repeat(19));
    expect(maskSecrets(nineteen).redacted).toBe(false);
    const twenty = fake("s", "k-", "a".repeat(20));
    expect(maskSecrets(twenty).text).toContain(`${REDACTED_PREFIX}token]`);

    // F-B：`sk-learn…`（scikit-learn 生態套件名）即使超過 20 字元也不遮。
    for (const packageName of ["sk-learn-extra-trees-classifier", "sk-learn-basics", "sk-learn-clustering"]) {
      const result = maskSecrets(packageName);
      expect(result.redacted, packageName).toBe(false);
      expect(result.text).toBe(packageName);
    }
    // 真的 sk- token（例如 sk-proj-…）仍遮。
    const skProject = fake("sk-", "proj-", "abcdef0123456789abcdef");
    expect(maskSecrets(skProject).text).toContain(`${REDACTED_PREFIX}token]`);
  });

  it("F1：JWT（`eyJ` 開頭的 JSON header）遮罩；dotted 識別字不遮", () => {
    const jwt = maskSecrets(`token=${samples.jwt}`);
    expect(jwt.text).toContain(`${REDACTED_PREFIX}jwt]`);
    expect(jwt.text).not.toContain(samples.jwt);

    for (const identifier of [
      "application.services.authentication",
      "my_package.some_module.function_name",
      "com.example.mnemoshelf",
    ]) {
      const result = maskSecrets(identifier);
      expect(result.redacted, identifier).toBe(false);
      expect(result.text).toBe(identifier);
    }
  });

  it("Bearer 大小寫不拘，保留原前綴樣式", () => {
    const upper = maskSecrets(`Authorization: ${samples.bearer}`);
    expect(upper.text).toContain(`Bearer ${REDACTED_PREFIX}bearer]`);
    expect(upper.text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");

    const lower = maskSecrets(`authorization: ${samples.lowercaseBearer}`);
    expect(lower.text).toContain(`bearer ${REDACTED_PREFIX}bearer]`);
    expect(lower.text).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("F2：敏感名稱的賦值（含常見複合名稱、JSON 風格）", () => {
    const placeholder = fake(REDACTED_PREFIX, "assignment]");
    const doubleQuoted = maskSecrets(fake("pass", "word", ' = "', "supersecretvalue", '"'));
    expect(doubleQuoted.text).toBe(fake("pass", "word", ' = "', placeholder, '"'));

    const singleQuoted = maskSecrets(fake("api", "_key: '", "abcdef0123456789", "'"));
    expect(singleQuoted.text).toBe(fake("api", "_key: '", placeholder, "'"));

    const bare = maskSecrets(fake("sec", "ret=", "hunter2hunter2hunter2"));
    expect(bare.text).toBe(fake("sec", "ret=", placeholder));

    // F2：常見複合名稱（底線不再被 `\b` 卡住）。
    for (const key of ["client_secret", "access_token", "refresh_token", "private_key", "apikey", "auth_token"]) {
      const result = maskSecrets(fake(key, ' = "', "abc123def456ghi789", '"'));
      expect(result.text, key).toBe(fake(key, ' = "', placeholder, '"'));
    }

    // F2：JSON 風格（key 有引號、值有引號）。
    const json = maskSecrets(fake('{"tok', 'en":"', "abcdef0123456789", '"}'));
    expect(json.text).toBe(fake('{"tok', 'en":"', placeholder, '"}'));

    // 太短的值不遮。
    const short = maskSecrets(fake("pass", "word", ' = "', "short", '"'));
    expect(short.redacted).toBe(false);
    expect(short.text).toBe(fake("pass", "word", ' = "', "short", '"'));
  });

  it("F2：連線字串的帳密（含空帳號、密碼含 `/`）遮罩；沒有密碼的 URL 不動", () => {
    const result = maskSecrets(`DB=${samples.connection}`);
    expect(result.text).toContain(`postgres://${REDACTED_PREFIX}connection-string]@db.example.test/app`);
    expect(result.text).not.toContain("s3cretpass");

    const emptyUser = maskSecrets(samples.connectionEmptyUser);
    expect(emptyUser.text).toBe(`postgres://${REDACTED_PREFIX}connection-string]@db.example.test/app`);

    const slashPassword = maskSecrets(samples.connectionSlashPassword);
    expect(slashPassword.text).toBe(`mysql://${REDACTED_PREFIX}connection-string]@db.example.test/app`);
    expect(slashPassword.text).not.toContain("pa/ss");

    // `ssh://git@host` 沒有 `user:pass`，不是機密。
    const ssh = maskSecrets("repo: ssh://git@github.example/repo.git");
    expect(ssh.redacted).toBe(false);
    expect(ssh.text).toBe("repo: ssh://git@github.example/repo.git");

    // 一般 URL 不動。
    const url = maskSecrets("https://example.test:8443/path?x=1");
    expect(url.redacted).toBe(false);

    // F-A：一般 URL 的 `:port/@` 與 query email 不得被當成帳密（寫入不可回復，必須不遮）。
    for (const normalUrl of [
      "https://example.com:8080/@me 的使用者端點",
      "http://localhost:3000/@user",
      "https://example.com:443/path?email=a@b",
    ]) {
      const result = maskSecrets(normalUrl);
      expect(result.redacted, normalUrl).toBe(false);
      expect(result.text).toBe(normalUrl);
    }
    // 但一般 URL 真的帶 `user:pass@` 仍要遮。
    const httpsCredentials = maskSecrets("https://user:pass@example.test/path");
    expect(httpsCredentials.text).toBe(
      `https://${REDACTED_PREFIX}connection-string]@example.test/path`,
    );
  });

  it("同一段文字的多個機密都遮，count 反應命中次數", () => {
    const text = `${samples.openAiStyle} 與 ${samples.awsStyle}`;
    const result = maskSecrets(text);
    expect(result.redacted).toBe(true);
    expect(result.count).toBe(2);
    expect(result.text.match(/\[REDACTED:token\]/g)).toHaveLength(2);
  });
});

describe("maskSecrets：idempotency 與誤遮對照（F1 regression）", () => {
  it("已遮罩文字再遮一次：文字不變、redacted=false、count=0", () => {
    const first = maskSecrets(
      [
        samples.pemRsa,
        samples.openAiStyle,
        samples.githubStyle,
        samples.jwt,
        samples.bearer,
        samples.connection,
        fake("password", ' = "', "supersecretvalue", '"'),
      ].join("\n"),
    );
    expect(first.redacted).toBe(true);
    expect(first.count).toBeGreaterThanOrEqual(7);

    const second = maskSecrets(first.text);
    expect(second.text).toBe(first.text);
    expect(second.redacted).toBe(false);
    expect(second.count).toBe(0);
    expect(containsRedacted(first.text)).toBe(true);
  });

  it("F1：正常程式／套件／識別字／URL／版本／路徑不誤遮", () => {
    const falsePositiveCandidates = [
      "commit abcdef1234567890abcdef1234567890abcdef12 修好了",
      "id=550e8400-e29b-41d4-a716-446655440000",
      fake("const tok", "en = await getToken();"),
      fake("const data = { sec", "ret: computeSecret() };"),
      "用 Intl.Segmenter 斷詞，兩字中文詞可以搜到。",
      "https://example.test/docs/storage-ports.md",
      "https://example.test:8443/api/v1/resource",
      "https://example.com:8080/@me 的使用者端點",
      "http://localhost:3000/@user",
      "https://example.com:443/path?email=a@b",
      "sk-learn-basics",
      "sk-learn-extra-trees-classifier",
      "sk-learn-clustering",
      "version v1.2.3",
      "packages/server/src/index.ts",
      "application.services.authentication",
      "my_package.some_module.function_name",
      "digest=0123456789abcdef0123456789abcdef01234567",
      fake("pass", "word", ' = "', "short", '"'),
      "ssh://git@github.example/repo.git",
      // 程式中的參考（不是字面憑證）也不遮：
      fake("const api", "Key = process.", "env.API_KEY;"),
      fake("const access", "Token = req.", "body.accessToken;"),
      fake("pass", "word", ' = "req.', "body.", "pass", 'word"'),
    ];
    for (const text of falsePositiveCandidates) {
      const result = maskSecrets(text);
      expect(result.redacted, text).toBe(false);
      expect(result.text).toBe(text);
    }
  });

  it("空字串與非字串輸入", () => {
    expect(maskSecrets("")).toEqual({ text: "", redacted: false, count: 0 });
    expect(() => maskSecrets(42 as unknown as string)).toThrow(TypeError);
  });
});
