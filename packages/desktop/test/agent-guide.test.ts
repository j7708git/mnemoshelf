/**
 * 「連接 Agent」產生器的測試：五種片段、四張安裝卡、複製文字與複製閘門。
 *
 * 重點：
 * 1. JSON 片段一律直接 `JSON.parse` 再逐鍵斷言（不是字串比對）。
 * 2. 卡片內嵌的片段必須與 `buildHarnessConfig` 同源（同一支函式、逐字相同）。
 * 3. `codex-mcp` 是 TOML：逐行斷言，含反斜線與引號的跳脫。
 * 4. 所有輸出都不含 token；連線物件本身沒有 token 欄位。
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_GUIDE_COPY_KINDS,
  buildCopyText,
  buildHarnessConfig,
  buildInstallCard,
  buildMcpConfigSnippet,
  copyGate,
  DEFAULT_MCP_PROJECT,
  ELECTRON_RUN_AS_NODE,
  type AgentGuideConfigKind,
  type AgentGuideConnection,
  type AgentGuideCopyKind,
  type AgentGuideHarnessTab,
} from "../src/agent-guide.js";

/** 合成連線資訊；不是任何使用者的真實路徑。 */
const CONNECTION: AgentGuideConnection = {
  executablePath: "/opt/synthetic/app/Mnemoshelf",
  entryPath: "/opt/synthetic/repo/packages/server/dist/scripts/mcp.js",
  runtimeFile: "/opt/synthetic/userdata/data/runtime.json",
  project: "demo-project",
};

/** 四個 harness 各自內嵌的片段種類。 */
const HARNESS_TO_KIND: Record<AgentGuideHarnessTab, AgentGuideConfigKind> = {
  opencode: "opencode-plugins",
  codex: "codex-mcp",
  dsh: "dsh-profile",
  other: "mcp-generic",
};

/** 可複製種類 → 卡片 harness。 */
const CARD_KIND_TO_HARNESS: Partial<Record<AgentGuideCopyKind, AgentGuideHarnessTab>> = {
  "install-card-opencode": "opencode",
  "install-card-codex": "codex",
  "install-card-dsh": "dsh",
  "install-card-generic": "other",
};

/** 遞迴收集所有物件的鍵（用來證明沒有多出 token 欄位）。 */
function collectObjectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectObjectKeys(item, keys);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      collectObjectKeys(item, keys);
    }
  }
  return keys;
}

/**
 * 驗證 TOML basic string 的每個反斜線都是合法跳脫（不是完整 TOML parser）。
 * 裸 `\U`（Windows 路徑若沒跳脫就會出現）會在這裡失敗。
 */
function assertValidTomlBasicStringEscapes(snippet: string): void {
  for (const line of snippet.split("\n")) {
    let index = 0;
    while (index < line.length) {
      if (line[index] === "\\") {
        expect(["\\", '"', "n", "r", "t", "u", "b", "f"]).toContain(line[index + 1]);
        index += 2;
        continue;
      }
      index += 1;
    }
  }
}

describe("buildHarnessConfig：JSON 片段直接解析", () => {
  it("opencode-plugins 用字面 <REPO_DIR>、不含 options、不含真實 runtimeFile", () => {
    const snippet = buildHarnessConfig("opencode-plugins", CONNECTION);
    const parsed = JSON.parse(snippet) as {
      $schema: string;
      plugins: Array<Record<string, unknown>>;
    };
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
    expect(parsed.plugins).toEqual([{ package: "<REPO_DIR>/packages/opencode-plugin" }]);
    expect(Object.keys(parsed.plugins[0]!)).toEqual(["package"]);
    expect(snippet).not.toContain(CONNECTION.runtimeFile);
    expect(snippet).not.toContain(CONNECTION.executablePath);
  });

  it("opencode-mcp 是 mcp.servers.mnemoshelf、有 environment 且沒有 env", () => {
    const parsed = JSON.parse(buildHarnessConfig("opencode-mcp", CONNECTION)) as {
      $schema: string;
      mcp: {
        servers: Record<
          string,
          { type: string; command: string[]; environment?: Record<string, string>; env?: unknown }
        >;
      };
    };
    const server = parsed.mcp.servers.mnemoshelf;
    expect(server).toBeDefined();
    expect(server!.type).toBe("local");
    expect(server!.command).toEqual([CONNECTION.executablePath, CONNECTION.entryPath]);
    expect(server!.environment).toEqual({
      MNEMOSHELF_RUNTIME_FILE: CONNECTION.runtimeFile,
      MNEMOSHELF_PROJECT: "demo-project",
      [ELECTRON_RUN_AS_NODE]: "1",
    });
    expect(server!.env).toBeUndefined();
    expect(parsed.$schema).toBe("https://opencode.ai/config.json");
  });

  it("mcp-generic 與 buildMcpConfigSnippet 輸出逐字相同", () => {
    const expected = buildMcpConfigSnippet({
      entryPath: CONNECTION.entryPath,
      runtimeFile: CONNECTION.runtimeFile,
      executablePath: CONNECTION.executablePath,
      project: CONNECTION.project,
    });
    expect(buildHarnessConfig("mcp-generic", CONNECTION)).toBe(expected);
    const parsed = JSON.parse(expected) as {
      mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(parsed.mcpServers.mnemoshelf!.type).toBe("stdio");
    expect(parsed.mcpServers.mnemoshelf!.command).toBe(CONNECTION.executablePath);
    expect(parsed.mcpServers.mnemoshelf!.args).toEqual([CONNECTION.entryPath]);
  });

  it("dsh-profile 同時有 dependencies 與 dsh.profile.bundles", () => {
    const parsed = JSON.parse(buildHarnessConfig("dsh-profile", CONNECTION)) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(parsed.dependencies["@mnemoshelf/dsh-plugin"]).toBe("link:<REPO_DIR>/packages/dsh-plugin");
    expect(parsed.dsh.profile.bundles).toContain("@mnemoshelf/dsh-plugin");
  });

  it("空白 project 視為未指定，退回 DEFAULT_MCP_PROJECT", () => {
    const parsed = JSON.parse(
      buildHarnessConfig("opencode-mcp", { ...CONNECTION, project: "   " }),
    ) as { mcp: { servers: Record<string, { environment: Record<string, string> }> } };
    expect(DEFAULT_MCP_PROJECT).toBe("mnemoshelf");
    expect(parsed.mcp.servers.mnemoshelf!.environment.MNEMOSHELF_PROJECT).toBe(DEFAULT_MCP_PROJECT);
  });
});

describe("buildHarnessConfig：codex-mcp 的 TOML", () => {
  it("逐行帶 [mcp_servers.mnemoshelf]、command、args、env 與 ELECTRON_RUN_AS_NODE", () => {
    const snippet = buildHarnessConfig("codex-mcp", CONNECTION);
    expect(snippet).toContain("[mcp_servers.mnemoshelf]");
    expect(snippet).toContain(`command = "${CONNECTION.executablePath}"`);
    expect(snippet).toContain(`args = ["${CONNECTION.entryPath}"]`);
    expect(snippet).toContain(`MNEMOSHELF_RUNTIME_FILE = "${CONNECTION.runtimeFile}"`);
    expect(snippet).toContain('MNEMOSHELF_PROJECT = "demo-project"');
    expect(snippet).toContain('ELECTRON_RUN_AS_NODE = "1"');
  });

  it("Windows 反斜線路徑會跳脫（輸出是 C:\\\\Users，不是裸 C:\\Users）", () => {
    const windowsConnection: AgentGuideConnection = {
      executablePath: "C:\\Program Files\\Mnemoshelf\\Mnemoshelf.exe",
      entryPath: "C:\\Users\\example\\AppData\\Local\\Mnemoshelf\\resources\\mcp.js",
      runtimeFile: "C:\\Users\\example\\AppData\\Roaming\\Mnemoshelf\\data\\runtime.json",
      project: "demo-project",
    };
    const snippet = buildHarnessConfig("codex-mcp", windowsConnection);
    expect(snippet).toContain('command = "C:\\\\Program Files\\\\Mnemoshelf\\\\Mnemoshelf.exe"');
    expect(snippet).toContain("C:\\\\Users\\\\example\\\\AppData");
    // 輸出裡不得出現未跳脫的單反斜線形式（`C:\Users`）；`\U` 不是合法 TOML 跳脫。
    expect(snippet).not.toContain("C:\\Users\\example");
    assertValidTomlBasicStringEscapes(snippet);
  });

  it("引號與換行也跳脫，不會把 TOML 字串截斷", () => {
    const tricky: AgentGuideConnection = {
      ...CONNECTION,
      executablePath: 'synthetic/"quoted"/path',
      entryPath: "synthetic/line\nbreak",
    };
    const snippet = buildHarnessConfig("codex-mcp", tricky);
    expect(snippet).toContain('command = "synthetic/\\"quoted\\"/path"');
    expect(snippet).toContain('args = ["synthetic/line\\nbreak"]');
    assertValidTomlBasicStringEscapes(snippet);
  });
});

describe("buildHarnessConfig：固定快照", () => {
  it("opencode-plugins", () => {
    expect(buildHarnessConfig("opencode-plugins", CONNECTION)).toMatchInlineSnapshot(`
      "{
        "$schema": "https://opencode.ai/config.json",
        "plugins": [
          {
            "package": "<REPO_DIR>/packages/opencode-plugin"
          }
        ]
      }"
    `);
  });

  it("opencode-mcp", () => {
    expect(buildHarnessConfig("opencode-mcp", CONNECTION)).toMatchInlineSnapshot(`
      "{
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
          "servers": {
            "mnemoshelf": {
              "type": "local",
              "command": [
                "/opt/synthetic/app/Mnemoshelf",
                "/opt/synthetic/repo/packages/server/dist/scripts/mcp.js"
              ],
              "environment": {
                "MNEMOSHELF_RUNTIME_FILE": "/opt/synthetic/userdata/data/runtime.json",
                "MNEMOSHELF_PROJECT": "demo-project",
                "ELECTRON_RUN_AS_NODE": "1"
              }
            }
          }
        }
      }"
    `);
  });

  it("mcp-generic", () => {
    expect(buildHarnessConfig("mcp-generic", CONNECTION)).toMatchInlineSnapshot(`
      "{
        "mcpServers": {
          "mnemoshelf": {
            "type": "stdio",
            "command": "/opt/synthetic/app/Mnemoshelf",
            "args": [
              "/opt/synthetic/repo/packages/server/dist/scripts/mcp.js"
            ],
            "env": {
              "MNEMOSHELF_RUNTIME_FILE": "/opt/synthetic/userdata/data/runtime.json",
              "MNEMOSHELF_PROJECT": "demo-project",
              "ELECTRON_RUN_AS_NODE": "1"
            }
          }
        }
      }"
    `);
  });

  it("codex-mcp", () => {
    expect(buildHarnessConfig("codex-mcp", CONNECTION)).toMatchInlineSnapshot(`
      "[mcp_servers.mnemoshelf]
      command = "/opt/synthetic/app/Mnemoshelf"
      args = ["/opt/synthetic/repo/packages/server/dist/scripts/mcp.js"]
      env = { MNEMOSHELF_RUNTIME_FILE = "/opt/synthetic/userdata/data/runtime.json", MNEMOSHELF_PROJECT = "demo-project", ELECTRON_RUN_AS_NODE = "1" }"
    `);
  });

  it("dsh-profile", () => {
    expect(buildHarnessConfig("dsh-profile", CONNECTION)).toMatchInlineSnapshot(`
      "{
        "dependencies": {
          "@mnemoshelf/dsh-plugin": "link:<REPO_DIR>/packages/dsh-plugin"
        },
        "dsh": {
          "profile": {
            "bundles": [
              "@mnemoshelf/dsh-plugin"
            ]
          }
        }
      }"
    `);
  });
});

describe("buildInstallCard：卡片與片段同源", () => {
  const input: AgentGuideConnection = {
    ...CONNECTION,
    runtimeFile: "/opt/fake/data/runtime.json",
    dshProfile: "web",
  };

  for (const [harness, kind] of Object.entries(HARNESS_TO_KIND) as Array<[AgentGuideHarnessTab, AgentGuideConfigKind]>) {
    it(`${harness} 卡片內嵌 buildHarnessConfig("${kind}") 的原字串`, () => {
      const snippet = buildHarnessConfig(kind, input);
      const card = buildInstallCard(harness, input);
      expect(card).toContain(snippet);
    });
  }

  it("四張卡的第 1 步都確認 runtimeFile 存在並列真實路徑", () => {
    for (const harness of Object.keys(HARNESS_TO_KIND) as AgentGuideHarnessTab[]) {
      const card = buildInstallCard(harness, input);
      expect(card).toContain("## 1.");
      expect(card).toContain("runtime");
      expect(card).toContain(input.runtimeFile);
      expect(card).toContain("重新啟動");
    }
  });

  it("開頭三行內講清楚你是誰、要做什麼、做完長什麼樣", () => {
    for (const harness of Object.keys(HARNESS_TO_KIND) as AgentGuideHarnessTab[]) {
      const firstLines = buildInstallCard(harness, input).split("\n").slice(0, 3).join("\n");
      expect(firstLines).toContain("你是");
      expect(firstLines).toContain("做完");
    }
  });

  it("opencode 卡含 clone／build、Windows 路徑提醒與驗證指令", () => {
    const card = buildInstallCard("opencode", input);
    expect(card).toContain("pnpm --filter @mnemoshelf/opencode-plugin build");
    expect(card).toContain("~/.config/opencode/opencode.jsonc");
    expect(card).toContain("不是** `%APPDATA%`");
    expect(card).toContain("反斜線");
    expect(card).toContain("opencode run --standalone --print-logs");
    expect(card).toContain("/memory");
  });

  it("codex 卡含 config.toml、codex mcp list 與「沒有自動召回 hook」", () => {
    const card = buildInstallCard("codex", input);
    expect(card).toContain("~/.codex/config.toml");
    expect(card).toContain("codex mcp list");
    expect(card).toContain("recall.mjs");
    expect(card).toContain("AGENTS.md");
    expect(card).toContain("沒有**自動召回 hook");
  });

  it("dsh 卡優先給 dsh plugin add 絕對路徑，並含兩段手動片段與 install", () => {
    const card = buildInstallCard("dsh", input);
    expect(card).toContain("dsh plugin --profile web add <REPO_DIR>/packages/dsh-plugin");
    expect(card).toContain("dsh plugin --profile web install");
    expect(card).toContain("絕對路徑");
    expect(card).toContain("不要用 `./`");
    expect(card).toContain("dsh web");
  });

  it("dsh 卡未指定 profile 時用字面 <PROFILE>", () => {
    const card = buildInstallCard("dsh", { ...input, dshProfile: undefined });
    expect(card).toContain("dsh plugin --profile <PROFILE> add");
  });

  it("other 卡指向欄位對照並要求確認六個工具", () => {
    const card = buildInstallCard("other", input);
    expect(card).toContain("其他 client 的欄位對照");
    expect(card).toContain("六個工具");
    expect(card).toContain("search_memories");
  });
});

describe("不含 token", () => {
  const SYNTHETIC_TOKEN = "SYNTHETIC_TOKEN_VALUE_not_a_real_credential";

  it("AgentGuideConnection 沒有 token 欄位（型別與執行期都沒有）", () => {
    // @ts-expect-error AgentGuideConnection 不得有 token 欄位
    const withToken: AgentGuideConnection = { ...CONNECTION, token: SYNTHETIC_TOKEN };
    expect("token" in CONNECTION).toBe(false);
    expect("token" in withToken).toBe(true);
    expect(collectObjectKeys(CONNECTION)).not.toContain("token");
  });

  it("token 塞進 runtimeFile／executablePath 時只作為路徑值，不會變成憑證欄位", () => {
    const input: AgentGuideConnection = {
      ...CONNECTION,
      executablePath: `/opt/synthetic/${SYNTHETIC_TOKEN}/Mnemoshelf`,
      runtimeFile: `/opt/synthetic/${SYNTHETIC_TOKEN}/runtime.json`,
    };
    // 不涉及這兩個路徑的片段完全不該出現它。
    expect(buildHarnessConfig("opencode-plugins", input)).not.toContain(SYNTHETIC_TOKEN);
    expect(buildHarnessConfig("dsh-profile", input)).not.toContain(SYNTHETIC_TOKEN);

    // JSON 片段沒有任何名為 token／MNEMOSHELF_TOKEN 的鍵。
    for (const kind of ["opencode-plugins", "opencode-mcp", "mcp-generic", "dsh-profile"] as const) {
      const keys = collectObjectKeys(JSON.parse(buildHarnessConfig(kind, input)));
      expect(keys).not.toContain("token");
      expect(keys).not.toContain("MNEMOSHELF_TOKEN");
    }

    // opencode-mcp 的 environment 恰好是三個既定鍵。
    const parsed = JSON.parse(buildHarnessConfig("opencode-mcp", input)) as {
      mcp: { servers: Record<string, { environment: Record<string, string> }> };
    };
    expect(Object.keys(parsed.mcp.servers.mnemoshelf!.environment).sort()).toEqual(
      [ELECTRON_RUN_AS_NODE, "MNEMOSHELF_PROJECT", "MNEMOSHELF_RUNTIME_FILE"].sort(),
    );

    // 卡片必須列出真實的 runtimeFile 路徑（第 1 步），但不得出現憑證欄位或 Bearer。
    for (const harness of Object.keys(HARNESS_TO_KIND) as AgentGuideHarnessTab[]) {
      const card = buildInstallCard(harness, input);
      expect(card).toContain(input.runtimeFile);
      expect(card).not.toMatch(/MNEMOSHELF_TOKEN|Bearer|token\s*[:=]/i);
    }
  });
});

describe("buildCopyText：唯一入口", () => {
  it("install-card-* 與對應 harness 的 buildInstallCard 逐字相同", () => {
    for (const [kind, harness] of Object.entries(CARD_KIND_TO_HARNESS) as Array<[AgentGuideCopyKind, AgentGuideHarnessTab]>) {
      expect(buildCopyText(kind, CONNECTION)).toBe(buildInstallCard(harness, CONNECTION));
    }
  });

  it("其餘種類與 buildHarnessConfig 逐字相同", () => {
    const configKinds: AgentGuideConfigKind[] = [
      "opencode-plugins",
      "opencode-mcp",
      "mcp-generic",
      "codex-mcp",
      "dsh-profile",
    ];
    for (const kind of configKinds) {
      expect(buildCopyText(kind, CONNECTION)).toBe(buildHarnessConfig(kind, CONNECTION));
    }
  });
});

describe("copyGate", () => {
  const ALL_OK = { appImage: undefined, runtimeFileExists: true, entryPathExists: true } as const;
  /** 不需要 runtime.json 的種類。 */
  const RUNTIME_OPTIONAL: AgentGuideCopyKind[] = ["opencode-plugins", "dsh-profile"];
  /** 不需要 MCP 入口腳本的種類。 */
  const ENTRY_OPTIONAL: AgentGuideCopyKind[] = [
    "opencode-plugins",
    "dsh-profile",
    "install-card-opencode",
    "install-card-dsh",
  ];

  it("檔案齊全且非 AppImage → 九種都可複製", () => {
    for (const kind of AGENT_GUIDE_COPY_KINDS) {
      expect(copyGate({ kind, ...ALL_OK })).toEqual({ allowed: true, reason: null });
    }
  });

  it("缺 runtime.json → 需要的種類擋下（runtime-missing），外掛／dsh 片段不受影響", () => {
    for (const kind of AGENT_GUIDE_COPY_KINDS) {
      const decision = copyGate({ kind, ...ALL_OK, runtimeFileExists: false });
      if (RUNTIME_OPTIONAL.includes(kind)) {
        expect(decision).toEqual({ allowed: true, reason: null });
      } else {
        expect(decision).toEqual({ allowed: false, reason: "runtime-missing" });
      }
    }
  });

  it("缺 MCP 入口 → 需要的種類擋下（entry-missing）", () => {
    for (const kind of AGENT_GUIDE_COPY_KINDS) {
      const decision = copyGate({ kind, ...ALL_OK, entryPathExists: false });
      if (ENTRY_OPTIONAL.includes(kind)) {
        expect(decision).toEqual({ allowed: true, reason: null });
      } else {
        expect(decision).toEqual({ allowed: false, reason: "entry-missing" });
      }
    }
  });

  it("AppImage 只影響需要 MCP 入口的種類（appimage）", () => {
    for (const kind of AGENT_GUIDE_COPY_KINDS) {
      const decision = copyGate({ kind, ...ALL_OK, appImage: "/opt/synthetic/Mnemoshelf.AppImage" });
      if (ENTRY_OPTIONAL.includes(kind)) {
        expect(decision).toEqual({ allowed: true, reason: null });
      } else {
        expect(decision).toEqual({ allowed: false, reason: "appimage" });
      }
    }
  });

  it("優先序：runtime-missing → entry-missing → appimage", () => {
    expect(
      copyGate({
        kind: "opencode-mcp",
        appImage: "/opt/synthetic/Mnemoshelf.AppImage",
        runtimeFileExists: false,
        entryPathExists: false,
      }),
    ).toEqual({ allowed: false, reason: "runtime-missing" });
    expect(
      copyGate({
        kind: "opencode-mcp",
        appImage: "/opt/synthetic/Mnemoshelf.AppImage",
        runtimeFileExists: true,
        entryPathExists: false,
      }),
    ).toEqual({ allowed: false, reason: "entry-missing" });
  });

  it("APPIMAGE 是空白字串視為不在 AppImage 環境", () => {
    expect(copyGate({ kind: "codex-mcp", ...ALL_OK, appImage: "   " })).toEqual({ allowed: true, reason: null });
  });

  it("執行期未知種類被擋下（unknown-kind）", () => {
    const kind = "bogus-kind" as AgentGuideCopyKind;
    expect(copyGate({ kind, ...ALL_OK })).toEqual({ allowed: false, reason: "unknown-kind" });
  });
});
