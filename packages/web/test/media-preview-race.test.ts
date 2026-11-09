import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// 用有狀態的 hooks 替身驅動實際元件 callback；不模擬瀏覽器解碼，也不新增 DOM 依賴。
const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value; }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
vi.mock("../src/api", async (original) => ({
  ...await original<typeof import("../src/api")>(),
  createMediaPlaybackSession: vi.fn(),
  revokeMediaPlaybackSession: vi.fn().mockResolvedValue(undefined),
  probeMediaPlaybackSession: vi.fn(),
}));

import { FilePreview } from "../src/FilePreview";
import { createMediaPlaybackSession, probeMediaPlaybackSession, type MediaProbeResult } from "../src/api";

type ElementProps = { children?: ReactNode; onClick?: () => void; onError?: () => void; src?: string; role?: string };
function elements(node: ReactNode): ReactElement<ElementProps>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<ElementProps>;
  return [element, ...elements(element.props.children)];
}
async function flush(): Promise<void> { for (let count = 0; count < 8; count++) await Promise.resolve(); }

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); hooks.cursor = 0; hooks.slots = []; hooks.effects = []; });

it.each(["http-error", "decode-error", "network-error"])("重授權後忽略舊 HEAD 的 %s 與 finally", async (outcome) => {
  vi.useFakeTimers();
  const oldSession = { url: "/old", expiresAt: new Date(Date.now() + 1000).toISOString() };
  const newSession = { url: "/new", expiresAt: new Date(Date.now() + 900000).toISOString() };
  vi.mocked(createMediaPlaybackSession).mockResolvedValueOnce(oldSession).mockResolvedValueOnce(newSession);
  let resolveProbe!: (value: MediaProbeResult) => void;
  let rejectProbe!: (reason: Error) => void;
  let resolveCurrent!: (value: MediaProbeResult) => void;
  vi.mocked(probeMediaPlaybackSession)
    .mockReturnValueOnce(new Promise((resolve, reject) => { resolveProbe = resolve; rejectProbe = reject; }))
    .mockReturnValueOnce(new Promise((resolve) => { resolveCurrent = resolve; }));
  const child = FilePreview({ rootId: 1, entry: { name: "clip.mp4", path: "clip.mp4", kind: "video", size: 32, mimeType: "video/mp4" } });
  const render = (): ReactElement<ElementProps>[] => {
    hooks.cursor = 0;
    hooks.effects = [];
    return elements((child.type as (props: unknown) => ReactNode)(child.props));
  };
  render();
  let cleanup = hooks.effects[0]!();
  try {
    await flush();
    render().find((element) => element.type === "video")!.props.onError!();
    await vi.advanceTimersByTimeAsync(1000);
    const retry = render().find((element) => element.type === "button")!;
    retry.props.onClick!();
    if (typeof cleanup === "function") cleanup();
    render();
    cleanup = hooks.effects[0]!();
    await flush();
    expect(render().find((element) => element.type === "video")?.props.src).toBe("/new");
    render().find((element) => element.type === "video")!.props.onError!();
    if (outcome === "network-error") rejectProbe(new Error("舊網路錯誤"));
    else resolveProbe(outcome === "http-error" ? { kind: "error", status: 401, message: "舊授權逾期" } : { kind: "ok", contentLength: 32, acceptRanges: true });
    await flush();
    const latest = render();
    expect(latest.find((element) => element.type === "video")?.props.src).toBe("/new");
    expect(latest.some((element) => element.props.role === "alert")).toBe(false);
    expect(latest.some((element) => element.props.role === "status")).toBe(true);
    resolveCurrent({ kind: "error", status: 409, message: "目前來源已變更" });
    await flush();
    expect(render().some((element) => element.props.role === "alert" && element.props.children === "目前來源已變更")).toBe(true);
    expect(render().some((element) => element.props.role === "status")).toBe(false);
  } finally { if (typeof cleanup === "function") cleanup(); }
});
