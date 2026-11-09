// 在真正的 WorkerEmbedder 初始化前，禁止 transformers.js 遠端下載。
import { env } from "../../packages/embedder-transformers/node_modules/@huggingface/transformers/src/transformers.js";
import { workerData } from "node:worker_threads";
env.allowRemoteModels = false;
await import(workerData?.entry ?? "../../packages/server/dist/embedder-worker.js");
