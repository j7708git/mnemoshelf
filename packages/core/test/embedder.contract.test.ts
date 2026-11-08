import { FakeEmbedder, runEmbedderContract } from "../src/testing/index.js";

// FakeEmbedder 無語意，但必須通過同一套介面／向量性質契約。
// 測試名稱即為 "Embedder contract (fake)"。
runEmbedderContract("fake", () => new FakeEmbedder());
runEmbedderContract("fake-audio", () => new FakeEmbedder({ audio: true }));
runEmbedderContract("fake-video", () => new FakeEmbedder({ video: true }));
runEmbedderContract("fake-audio-video", () => new FakeEmbedder({ audio: true, video: true }));
