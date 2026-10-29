/**
 * 「連接 Agent」解析器的測試：OpenCode／codex／dsh 的三態偵測、JSONC 掃描器與路徑純函式。
 *
 * 三態的鐵律：讀不到／太大／格式壞一律是 `unknown` 加原因碼，**不可**降級成
 * `not-detected`（那會讓使用者以為「只是沒安裝」）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexConfigPaths,
  detectCodex,
  detectDsh,
  detectOpenCode,
  dshProfilesDir,
  opencodeConfigCandidates,
  opencodePluginsDir,
  type AgentGuideConfigInput,
} from "../src/agent-guide.js";

/** 讀取合成 fixture（不是使用者的真實檔案）。 */
function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/agent-guide/${name}`, import.meta.url), "utf8");
}

/** 可讀來源。 */
function ok(text: string, at = "/opt/synthetic/opencode/opencode.jsonc"): AgentGuideConfigInput {
  return { path: at, result: { ok: true, text } };
}

/** 不存在的來源（正常情況，不是錯誤）。 */
function missing(at = "/opt/synthetic/opencode/missing.json"): AgentGuideConfigInput {
  return { path: at, result: { ok: false, reason: "file-missing" } };
}

describe("detectOpenCode：plugins 三種形狀", () => {
  it("字串陣列：最後一段 opencode-plugin 命中", () => {
    const detection = detectOpenCode({
      configs: [ok(fixture("opencode-string-plugins.json"))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.matches).toContain("/opt/synthetic/tools/opencode-plugin");
  });

  it("物件陣列：package 路徑命中", () => {
    const detection = detectOpenCode({
      configs: [ok(fixture("opencode-config.jsonc"))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
    expect(detection.matches).toEqual(["/opt/synthetic/repo/packages/opencode-plugin"]);
  });

  it("物件表：鍵與值裡的 package 都當候選字串", () => {
    const detection = detectOpenCode({
      configs: [ok(fixture("opencode-table-plugins.json"))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
    expect(detection.matches).toEqual(["/opt/synthetic/table/mnemoshelf-bridge"]);
  });
});

describe("detectOpenCode：命中條件三選一與對照組", () => {
  it("package.json 的 name 含 mnemoshelf（路徑本身不含）", () => {
    const detection = detectOpenCode({
      configs: [],
      pluginDirs: [
        {
          path: "/opt/synthetic/plugins/custom-bridge",
          result: { ok: true, text: fixture("plugin-packages/mnemoshelf-bridge.json") },
        },
      ],
    });
    expect(detection.state).toBe("detected");
    expect(detection.matches).toEqual(["/opt/synthetic/plugins/custom-bridge"]);
  });

  it("候選路徑含 mnemoshelf（最後一段不是 opencode-plugin）", () => {
    const detection = detectOpenCode({
      configs: [ok(JSON.stringify({ plugins: ["/opt/synthetic/vendor/mnemoshelf/custom"] }))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
    expect(detection.matches).toEqual(["/opt/synthetic/vendor/mnemoshelf/custom"]);
  });

  it("最後一段等於 opencode-plugin（完全相等、大小寫敏感）", () => {
    const detection = detectOpenCode({
      configs: [ok(JSON.stringify({ plugins: [path.join("/opt", "tools", "opencode-plugin")] }))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
  });

  it("對照組：opencode-plugin-wrapper 不算命中（最後一段不相等）", () => {
    const detection = detectOpenCode({
      configs: [ok(JSON.stringify({ plugins: ["/opt/tools/opencode-plugin-wrapper"] }))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("not-configured");
    expect(detection.matches).toEqual([]);
  });

  it("對照組：OpenCode-Plugin 大小寫不同不算命中（最後一段比較大小寫敏感）", () => {
    const detection = detectOpenCode({
      configs: [ok(JSON.stringify({ plugins: ["/opt/tools/OpenCode-Plugin"] }))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("not-detected");
    expect(detection.matches).toEqual([]);
  });

  it("plugins/ 目錄裡沒有 package.json（空字串）不算格式錯誤", () => {
    const detection = detectOpenCode({
      configs: [],
      pluginDirs: [{ path: "/opt/synthetic/plugins/empty-dir", result: { ok: true, text: "" } }],
    });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("not-configured");
  });
});

describe("detectOpenCode：合併掃描不 first-hit-wins", () => {
  it("第一個設定沒有、第二個有 → detected", () => {
    const detection = detectOpenCode({
      configs: [
        ok(fixture("opencode-config-merged-a.json"), "/opt/synthetic/opencode/opencode.jsonc"),
        ok(fixture("opencode-config-merged-b.json"), "/opt/synthetic/opencode/opencode.json"),
      ],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.sourcesChecked).toBe(2);
    expect(detection.matches).toEqual(["/opt/synthetic/vendor/mnemoshelf/packages/opencode-plugin"]);
  });

  it("一個來源讀不到、另一個命中 → 正面證據優先（detected）", () => {
    const detection = detectOpenCode({
      configs: [
        { path: "/opt/synthetic/opencode/opencode.jsonc", result: { ok: false, reason: "read-error" } },
        ok(fixture("opencode-config-merged-b.json")),
      ],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
  });
});

describe("detectOpenCode：丟掉 options 與 environment 的內容", () => {
  it("合成 token 不進偵測結果，matches 只有 package 路徑", () => {
    const detection = detectOpenCode({
      configs: [ok(fixture("opencode-config.jsonc"))],
      pluginDirs: [],
    });
    expect(detection.state).toBe("detected");
    const serialized = JSON.stringify(detection);
    expect(serialized).not.toContain("SYNTHETIC_OPTIONS_TOKEN_DO_NOT_COPY");
    expect(serialized).not.toContain("SYNTHETIC_ENVIRONMENT_TOKEN_DO_NOT_COPY");
    expect(serialized).not.toContain("environment");
    expect(detection.matches).toEqual(["/opt/synthetic/repo/packages/opencode-plugin"]);
  });
});

describe("detectOpenCode：mcpConfigured 只看位置欄位", () => {
  it("mcp.servers 的鍵含 mnemoshelf → true", () => {
    const detection = detectOpenCode({
      configs: [ok(fixture("opencode-config.jsonc"))],
      pluginDirs: [],
    });
    expect(detection.mcpConfigured).toBe(true);
  });

  it("command 是字串且含 mnemoshelf → true", () => {
    const config = JSON.stringify({
      mcp: { servers: { other: { type: "local", command: "/opt/synthetic/mnemoshelf/bin" } } },
    });
    const detection = detectOpenCode({ configs: [ok(config)], pluginDirs: [] });
    expect(detection.mcpConfigured).toBe(true);
  });

  it("command 是陣列且任一元素含 mnemoshelf → true", () => {
    const config = JSON.stringify({
      mcp: { servers: { other: { type: "local", command: ["/usr/bin/node", "/opt/synthetic/mnemoshelf/mcp.js"] } } },
    });
    const detection = detectOpenCode({ configs: [ok(config)], pluginDirs: [] });
    expect(detection.mcpConfigured).toBe(true);
  });

  it("args 任一元素含 mnemoshelf → true", () => {
    const config = JSON.stringify({
      mcp: { servers: { other: { type: "local", command: "node", args: ["/opt/synthetic/mnemoshelf/mcp.js"] } } },
    });
    const detection = detectOpenCode({ configs: [ok(config)], pluginDirs: [] });
    expect(detection.mcpConfigured).toBe(true);
  });

  it("只設 MCP、沒有外掛 → detected／ok，matches 為空（MCP 也是正面證據）", () => {
    const config = JSON.stringify({
      mcp: { servers: { mnemoshelf: { type: "local", command: ["node", "/opt/synthetic/other.js"] } } },
    });
    const detection = detectOpenCode({ configs: [ok(config)], pluginDirs: [] });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.matches).toEqual([]);
    expect(detection.mcpConfigured).toBe(true);
  });

  it("只有 environment 內容含 mnemoshelf → false（內容一律丟棄）", () => {
    const config = JSON.stringify({
      mcp: {
        servers: {
          other: {
            type: "local",
            command: "node",
            args: ["/opt/synthetic/tools/other.js"],
            environment: { MNEMOSHELF_TOKEN: "mnemoshelf" },
          },
        },
      },
    });
    const detection = detectOpenCode({ configs: [ok(config)], pluginDirs: [] });
    expect(detection.mcpConfigured).toBe(false);
    expect(detection.state).toBe("not-detected");
  });
});

describe("detectOpenCode：三態與原因碼", () => {
  it("file-missing：所有來源都不存在 → not-detected / file-missing", () => {
    const detection = detectOpenCode({ configs: [missing(), missing()], pluginDirs: [] });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("file-missing");
    expect(detection.sourcesChecked).toBe(2);
  });

  it("not-configured：來源可讀但沒有設定 → not-detected / not-configured", () => {
    const detection = detectOpenCode({ configs: [ok("{}")], pluginDirs: [] });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("not-configured");
  });

  it("read-error：讀取失敗 → unknown / read-error（不可降級）", () => {
    const detection = detectOpenCode({
      configs: [{ path: "/opt/synthetic/opencode/opencode.jsonc", result: { ok: false, reason: "read-error" } }],
      pluginDirs: [],
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("read-error");
  });

  it("too-large：檔案過大 → unknown / too-large（不可降級）", () => {
    const detection = detectOpenCode({
      configs: [{ path: "/opt/synthetic/opencode/opencode.jsonc", result: { ok: false, reason: "too-large" } }],
      pluginDirs: [],
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("too-large");
  });

  it("invalid-format：JSONC 壞掉 → unknown / invalid-format（不可降級）", () => {
    const detection = detectOpenCode({ configs: [ok("{ this is not json")], pluginDirs: [] });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("invalid-format：最外層不是物件 → unknown / invalid-format", () => {
    const detection = detectOpenCode({ configs: [ok("[]")], pluginDirs: [] });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("plugins/ 目錄的 package.json 壞掉 → unknown / invalid-format", () => {
    const detection = detectOpenCode({
      configs: [],
      pluginDirs: [{ path: "/opt/synthetic/plugins/broken", result: { ok: true, text: "{broken" } }],
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("package.json 壞掉但目錄路徑明確命中 → 正面證據優先（detected）", () => {
    const detection = detectOpenCode({
      configs: [],
      pluginDirs: [{ path: "/opt/synthetic/plugins/opencode-plugin", result: { ok: true, text: "{broken" } }],
    });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.matches).toEqual(["/opt/synthetic/plugins/opencode-plugin"]);
  });

  it("多個硬失敗取輸入順序第一個原因碼", () => {
    const detection = detectOpenCode({
      configs: [
        missing(),
        { path: "/opt/synthetic/opencode/opencode.json", result: { ok: false, reason: "read-error" } },
      ],
      pluginDirs: [{ path: "/opt/synthetic/plugins/x", result: { ok: false, reason: "too-large" } }],
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("read-error");
    expect(detection.sourcesChecked).toBe(3);
  });

  it("候選為空 → not-detected / file-missing", () => {
    const detection = detectOpenCode({ configs: [], pluginDirs: [] });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("file-missing");
    expect(detection.sourcesChecked).toBe(0);
    expect(detection.mcpConfigured).toBe(false);
    expect(detection.hookConfigured).toBe(false);
  });

  it("matches 去重後排序", () => {
    const first = "/opt/synthetic/z/opencode-plugin";
    const second = "/opt/synthetic/a/opencode-plugin";
    const detection = detectOpenCode({
      configs: [ok(JSON.stringify({ plugins: [first, second, first] }))],
      pluginDirs: [],
    });
    expect(detection.matches).toEqual([second, first].sort());
  });
});

describe("JSONC 掃描器（透過 detectOpenCode）", () => {
  const hitPath = "/opt/synthetic/tools/opencode-plugin";

  function stateFor(text: string): { state: string; reason: string } {
    const detection = detectOpenCode({ configs: [ok(text)], pluginDirs: [] });
    return { state: detection.state, reason: detection.reason };
  }

  it("字串內的 //（$schema 網址）不當註解", () => {
    expect(stateFor(`{"$schema":"https://opencode.ai/config.json","plugins":["${hitPath}"]}`)).toEqual({
      state: "detected",
      reason: "ok",
    });
  });

  it("字串內的 /* 與 */ 不當註解", () => {
    expect(
      stateFor(`{"plugins":["${hitPath}"],"note":"a /* b */ c"}`),
    ).toEqual({ state: "detected", reason: "ok" });
  });

  it("字串內的 \\\" 轉義不會提前結束字串", () => {
    expect(
      stateFor(`{"plugins":["${hitPath}"],"note":"say \\"hi\\" // not comment"}`),
    ).toEqual({ state: "detected", reason: "ok" });
  });

  it("物件尾逗號合法", () => {
    expect(stateFor(`{"plugins":["${hitPath}"],}`)).toEqual({ state: "detected", reason: "ok" });
  });

  it("陣列尾逗號合法", () => {
    expect(stateFor(`{"plugins":["${hitPath}",],}`)).toEqual({ state: "detected", reason: "ok" });
  });

  it("尾逗號後面接塊註解也合法（先移註解再移逗號）", () => {
    expect(stateFor(`{"plugins":["${hitPath}"],/* trailing */}`)).toEqual({ state: "detected", reason: "ok" });
  });

  it("UTF-8 BOM 會被吃掉", () => {
    expect(stateFor(`\uFEFF{"plugins":["${hitPath}"]}`)).toEqual({ state: "detected", reason: "ok" });
  });

  it("檔案結尾的註解合法", () => {
    expect(stateFor(`{"plugins":["${hitPath}"]}\n// end of file`)).toEqual({ state: "detected", reason: "ok" });
  });

  it("塊註解跨行", () => {
    expect(stateFor(`{\n/* 第一行\n第二行 */\n"plugins":["${hitPath}"]\n}`)).toEqual({
      state: "detected",
      reason: "ok",
    });
  });

  it("只有註解不是合法 JSON 值 → invalid-format", () => {
    expect(stateFor("// only a comment\n/* and another */")).toEqual({
      state: "unknown",
      reason: "invalid-format",
    });
  });

  it("區塊註解沒有結尾 → invalid-format", () => {
    expect(stateFor(`{"plugins":[], /* dangling`)).toEqual({
      state: "unknown",
      reason: "invalid-format",
    });
  });

  it("字串沒有結尾 → invalid-format", () => {
    expect(stateFor(`{"plugins":["${hitPath}`)).toEqual({
      state: "unknown",
      reason: "invalid-format",
    });
  });
});

describe("detectCodex", () => {
  it("config.toml 有 [mcp_servers.mnemoshelf] → detected，matches 一律 []", () => {
    const detection = detectCodex({
      config: ok(fixture("codex-config.toml"), "/opt/synthetic/.codex/config.toml"),
      hooks: missing("/opt/synthetic/.codex/hooks.json"),
    });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.mcpConfigured).toBe(true);
    expect(detection.hookConfigured).toBe(false);
    expect(detection.matches).toEqual([]);
    expect(detection.sourcesChecked).toBe(2);
  });

  it("子表頭 [mcp_servers.mnemoshelf.env] 也算已設定", () => {
    const detection = detectCodex({
      config: ok('[mcp_servers.mnemoshelf.env]\nMNEMOSHELF_PROJECT = "demo"'),
      hooks: missing(),
    });
    expect(detection.mcpConfigured).toBe(true);
    expect(detection.state).toBe("detected");
  });

  it("表頭帶字串外的尾端註解 → 仍算已設定", () => {
    const detection = detectCodex({
      config: ok('[mcp_servers.mnemoshelf] # 使用者原有的註解\ncommand = "node"'),
      hooks: missing(),
    });
    expect(detection.mcpConfigured).toBe(true);
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
  });

  it("多行陣列的元素（行首為 `[`）跳過，不會被判成壞表頭", () => {
    const config = 'allowed = [\n  [1, 2],\n  ["a", "b"],\n]\n[mcp_servers.mnemoshelf]\ncommand = "node"';
    const detection = detectCodex({
      config: ok(config),
      hooks: missing(),
    });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.mcpConfigured).toBe(true);
  });

  it("多行陣列最後一個元素沒有尾逗號也不誤判（靠括號深度，不是逗號）", () => {
    const config = 'allowed = [\n  [1, 2]\n]\n[mcp_servers.mnemoshelf]\ncommand = "node"';
    const detection = detectCodex({ config: ok(config), hooks: missing() });
    expect(detection.state).toBe("detected");
    expect(detection.mcpConfigured).toBe(true);
  });

  it("缺結尾 `]`、但字串外有逗號的壞表頭 → 仍 invalid-format（不可降級）", () => {
    const detection = detectCodex({
      config: ok("[mcp_servers.mnemoshelf,\ncommand = \"node\""),
      hooks: missing(),
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("字串內的 `#` 與 `[` 不當成註解或陣列開頭", () => {
    const config = 'note = "a # b [c]"\n[mcp_servers.mnemoshelf]\ncommand = "node"';
    const detection = detectCodex({ config: ok(config), hooks: missing() });
    expect(detection.state).toBe("detected");
    expect(detection.mcpConfigured).toBe(true);
  });

  it("多行陣列沒有收合 → invalid-format（不可默默忽略後面的表頭）", () => {
    const config = 'args = ["a", "b"\n[mcp_servers.mnemoshelf]\ncommand = "node"';
    const detection = detectCodex({ config: ok(config), hooks: missing() });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("多行字串內的一般文字（含未配對 `[`）不會被當成陣列開頭", () => {
    const config =
      'instructions = """\nUse [ carefully\n"""\n[mcp_servers.mnemoshelf]\ncommand = "node"';
    const detection = detectCodex({ config: ok(config), hooks: missing() });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.mcpConfigured).toBe(true);
  });

  it("hooks.json 的 command 含 mnemoshelf → detected（hookConfigured）", () => {
    const detection = detectCodex({
      config: ok('model = "synthetic-model"'),
      hooks: ok(fixture("codex-hooks.json"), "/opt/synthetic/.codex/hooks.json"),
    });
    expect(detection.state).toBe("detected");
    expect(detection.hookConfigured).toBe(true);
    expect(detection.mcpConfigured).toBe(false);
    expect(detection.matches).toEqual([]);
  });

  it("not-configured：兩個來源都可讀但都沒有 mnemoshelf", () => {
    const detection = detectCodex({
      config: ok('[mcp_servers.other]\ncommand = "node"'),
      hooks: ok("{}"),
    });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("not-configured");
    expect(detection.matches).toEqual([]);
  });

  it("file-missing：兩個來源都不存在", () => {
    const detection = detectCodex({ config: missing(), hooks: missing() });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("file-missing");
  });

  it("invalid-format：TOML 表頭括號不匹配", () => {
    const detection = detectCodex({
      config: ok(fixture("codex-config-broken.toml")),
      hooks: missing(),
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("invalid-format：多一個右括號也不算合法表頭", () => {
    const detection = detectCodex({
      config: ok("[mcp_servers.mnemoshelf]]\ncommand = \"node\""),
      hooks: missing(),
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("invalid-format：hooks.json 解析失敗", () => {
    const detection = detectCodex({
      config: ok('model = "synthetic-model"'),
      hooks: ok('{"hooks": '),
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("invalid-format：hooks.json 最外層不是物件", () => {
    const detection = detectCodex({
      config: ok('model = "synthetic-model"'),
      hooks: ok("[]"),
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("read-error 優先於 invalid-format（F 表順序）", () => {
    const detection = detectCodex({
      config: { path: "/opt/synthetic/.codex/config.toml", result: { ok: false, reason: "read-error" } },
      hooks: ok("{broken"),
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("read-error");
  });

  it("too-large 也是 unknown（不可降級）", () => {
    const detection = detectCodex({
      config: { path: "/opt/synthetic/.codex/config.toml", result: { ok: false, reason: "too-large" } },
      hooks: missing(),
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("too-large");
  });
});

describe("detectDsh", () => {
  it("profile 的 dependencies 含 mnemoshelf → detected，matches 是 profile 名稱", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "web",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/web/package.json",
            result: { ok: true, text: fixture("dsh-profile-package.json") },
          },
        },
      ],
    });
    expect(detection.state).toBe("detected");
    expect(detection.reason).toBe("ok");
    expect(detection.matches).toEqual(["web"]);
    expect(detection.mcpConfigured).toBe(false);
    expect(detection.hookConfigured).toBe(false);
    expect(detection.sourcesChecked).toBe(1);
  });

  it("只有 devDependencies 含 mnemoshelf 也算", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "dev",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/dev/package.json",
            result: { ok: true, text: JSON.stringify({ devDependencies: { "@mnemoshelf/dsh-plugin": "link:/opt/x" } }) },
          },
        },
      ],
    });
    expect(detection.state).toBe("detected");
    expect(detection.matches).toEqual(["dev"]);
  });

  it("只有 dsh.profile.bundles 含 mnemoshelf 也算", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "web",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/web/package.json",
            result: {
              ok: true,
              text: JSON.stringify({ dsh: { profile: { bundles: ["@mnemoshelf/dsh-plugin"] } } }),
            },
          },
        },
      ],
    });
    expect(detection.state).toBe("detected");
    expect(detection.matches).toEqual(["web"]);
  });

  it("not-configured：可讀但沒有 mnemoshelf", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "web",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/web/package.json",
            result: { ok: true, text: JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }) },
          },
        },
      ],
    });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("not-configured");
  });

  it("invalid-format：package.json 壞掉 → unknown / invalid-format", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "web",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/web/package.json",
            result: { ok: true, text: "{broken" },
          },
        },
      ],
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("invalid-format");
  });

  it("read-error：讀取失敗 → unknown / read-error", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "web",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/web/package.json",
            result: { ok: false, reason: "read-error" },
          },
        },
      ],
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("read-error");
  });

  it("too-large：檔案過大 → unknown / too-large", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "web",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/web/package.json",
            result: { ok: false, reason: "too-large" },
          },
        },
      ],
    });
    expect(detection.state).toBe("unknown");
    expect(detection.reason).toBe("too-large");
  });

  it("多個 profile：掃描全部，只回命中的名稱（排序）", () => {
    const detection = detectDsh({
      profiles: [
        {
          name: "web",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/web/package.json",
            result: { ok: true, text: JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }) },
          },
        },
        {
          name: "cli",
          packageJson: {
            path: "/opt/synthetic/.dsh/profiles/cli/package.json",
            result: { ok: true, text: fixture("dsh-profile-package.json") },
          },
        },
      ],
    });
    expect(detection.state).toBe("detected");
    expect(detection.matches).toEqual(["cli"]);
    expect(detection.sourcesChecked).toBe(2);
  });

  it("profile 清單為空 → not-detected / file-missing", () => {
    const detection = detectDsh({ profiles: [] });
    expect(detection.state).toBe("not-detected");
    expect(detection.reason).toBe("file-missing");
    expect(detection.sourcesChecked).toBe(0);
  });
});

describe("路徑純函式（全部用 node:path 組合）", () => {
  const home = path.join("synthetic", "home", "example");

  it("opencodeConfigCandidates 依序回 .jsonc 與 .json", () => {
    expect(opencodeConfigCandidates(home)).toEqual([
      path.join(home, ".config", "opencode", "opencode.jsonc"),
      path.join(home, ".config", "opencode", "opencode.json"),
    ]);
  });

  it("opencodePluginsDir 是使用者層 plugins/（不是專案層 .opencode/）", () => {
    const pluginsDir = opencodePluginsDir(home);
    expect(pluginsDir).toBe(path.join(home, ".config", "opencode", "plugins"));
    expect(pluginsDir).not.toContain(`${path.sep}.opencode`);
  });

  it("codexConfigPaths 回 config.toml 與 hooks.json", () => {
    expect(codexConfigPaths(home)).toEqual({
      config: path.join(home, ".codex", "config.toml"),
      hooks: path.join(home, ".codex", "hooks.json"),
    });
  });

  it("dshProfilesDir 沒有 DSH_HOME 時用 ~/.dsh/profiles", () => {
    expect(dshProfilesDir({ home, env: {} })).toBe(path.join(home, ".dsh", "profiles"));
    expect(dshProfilesDir({ home, env: { DSH_HOME: "   " } })).toBe(path.join(home, ".dsh", "profiles"));
  });

  it("dshProfilesDir 的 DSH_HOME 非空時覆寫根目錄", () => {
    expect(dshProfilesDir({ home, env: { DSH_HOME: path.join("synthetic", "dsh-home") } })).toBe(
      path.join("synthetic", "dsh-home", "profiles"),
    );
  });
});
