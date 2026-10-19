// 測試用 worker（真正的 node:worker_threads 執行緒）：
// 收到 init 後回 ready；收到任何 request 就**直接結束執行緒**（exit code 3），
// 模擬 onnxruntime native 層把 worker 弄死的崩潰。用來驗證 WorkerEmbedder 的
// 「在途呼叫要清楚錯誤、不 hang；下一次呼叫自動重建一次」。
//
// 這不是產品程式碼，也不載入模型；info 必須與測試注入的 FakeEmbedder 相同。
import { parentPort } from "node:worker_threads";

const info = {
  id: "fake-embedder@test",
  dim: 512,
  capabilities: { text: true, image: true, audio: false, video: false },
};

const runtimeStatus = {
  requestedDevice: "cpu",
  device: "cpu",
  loaded: false,
  fallbackReason: null,
  batchSize: 16,
  serializedInference: false,
  dmlDeviceId: 0,
};

parentPort.on("message", (message) => {
  if (message.type === "init") {
    parentPort.postMessage({ type: "ready", ok: true, info, runtimeStatus });
    return;
  }
  if (message.type === "request" || message.type === "cancel") {
    process.exit(3);
  }
});
