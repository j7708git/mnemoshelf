import { FakeEmbedder, runEmbedderContract } from "../src/testing/index.js";

// FakeEmbedder 無語意，但必須通過同一套介面／向量性質契約。
// 測試名稱即為 "Embedder contract (fake)"。
runEmbedderContract("fake", () => new FakeEmbedder());
