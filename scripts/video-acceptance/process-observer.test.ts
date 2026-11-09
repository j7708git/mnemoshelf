import { describe, expect, it } from "vitest";
import { observeMediaProcesses } from "./process-observer.mjs";

describe("本程序觀測", () => {
  it("只在有資料時報告 RSS 樣本，沒有媒體程序時不虛構子程序", async () => {
    const observer = observeMediaProcesses();
    try {
      expect(await observer.ready()).toBe(process.platform === "win32");
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const result = observer.snapshot();
      expect(result.events).toHaveLength(0);
      if (process.platform === "win32") {
        expect(result.samplerError).toBeNull();
        expect(result.samples.length).toBeGreaterThan(0);
        expect(result.samples[0].complete).toBe(true);
        expect(result.samples[0].ffmpegRss).toBe(0);
        expect(result.samples[0].totalRss).toBe(result.samples[0].nodeRss);
      } else expect(result.samplerError).toBe("unsupported-platform");
    } finally { await observer.close(); }
  }, 10000);
});
