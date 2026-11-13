// 只供隔離驗收：實際產品 worker 入口不變，模型資產缺失時直接失敗，禁止下載。
import { env } from "../../packages/embedder-transformers/node_modules/@huggingface/transformers/dist/transformers.node.mjs";
env.allowRemoteModels = false;
await import("../../packages/server/dist/embedder-worker.js");
