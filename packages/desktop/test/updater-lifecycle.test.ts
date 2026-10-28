/**
 * `closeServerOnly()` 與 `shutdown()` 的契約（不啟動 Electron）。
 *
 * 驗收條件 4：關閉 server 時**不得**呼叫 `app.exit`；`shutdown()` 仍然會結束行程。
 * main.ts 的兩個函式都薄薄地包在 `createServerLifecycle()` 上，這裡以 spy 驗證語意。
 */
import { describe, expect, it, vi } from "vitest";
import { createServerLifecycle } from "../src/updater/lifecycle.js";

describe("closeServerOnly／shutdown", () => {
  it("closeServerOnly 只關一次、不呼叫 exit", async () => {
    const closeServer = vi.fn(async () => undefined);
    const exit = vi.fn();
    const lifecycle = createServerLifecycle({ closeServer, exit });

    await lifecycle.closeServerOnly();
    await lifecycle.closeServerOnly();
    await Promise.all([lifecycle.closeServerOnly(), lifecycle.closeServerOnly()]);

    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("shutdown 先關 server 再 exit(code)", async () => {
    const calls: string[] = [];
    const lifecycle = createServerLifecycle({
      closeServer: async () => {
        calls.push("close");
      },
      exit: (code) => {
        calls.push(`exit:${code}`);
      },
      beforeExit: () => calls.push("beforeExit"),
    });

    await lifecycle.shutdown(0);
    expect(calls).toEqual(["close", "beforeExit", "exit:0"]);
  });

  it("關閉失敗時 closeServerOnly reject（並行呼叫共用同一個失敗），shutdown 仍會結束", async () => {
    const exit = vi.fn();
    const beforeExit = vi.fn();
    const messages: string[] = [];
    const closeServer = vi.fn(async () => {
      throw new Error("synthetic close failure");
    });
    const lifecycle = createServerLifecycle({
      closeServer,
      exit,
      beforeExit,
      log: (message) => messages.push(message),
    });

    const results = await Promise.allSettled([lifecycle.closeServerOnly(), lifecycle.closeServerOnly()]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(String(result.reason)).toContain("synthetic close failure");
      }
    }
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("synthetic close failure");

    await lifecycle.shutdown(1);
    expect(beforeExit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("main.ts 使用同一個 lifecycle（靜態檢查：沒有在 closeServerOnly 內呼叫 app.exit）", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(source).toContain("createServerLifecycle");
    expect(source).toContain("async function closeServerOnly");
    const closeOnly = source.slice(
      source.indexOf("async function closeServerOnly"),
      source.indexOf("/** 收掉服務後結束行程"),
    );
    expect(closeOnly).not.toContain("app.exit");
    expect(closeOnly).toContain("serverLifecycle.closeServerOnly");
  });
});
