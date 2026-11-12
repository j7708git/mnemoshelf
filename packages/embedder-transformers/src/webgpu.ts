import { createRequire } from "node:module";

type SupportedBackend = { name: string; bundled: boolean };

/** 由 transformers 的安裝位置解析它使用的原生 ORT，避免新增依賴。 */
export function hasNativeWebGpu(list?: () => SupportedBackend[]): boolean {
  const listBackends = list ?? (() => {
    const requireOrt = createRequire(import.meta.resolve("@huggingface/transformers"));
    const ort = requireOrt("onnxruntime-node") as { listSupportedBackends(): SupportedBackend[] };
    return ort.listSupportedBackends();
  });
  return listBackends().some((item) => item.name === "webgpu" && item.bundled);
}
