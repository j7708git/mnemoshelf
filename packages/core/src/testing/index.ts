/** 契約測試的公開入口（`@mnemoshelf/core/testing`）。 */
export { runMetadataStoreContract, type MetadataStoreFactory } from "./metadata-store.contract.js";
export { runVectorIndexContract, type VectorIndexFactory } from "./vector-index.contract.js";
export { FakeEmbedder, FAKE_EMBEDDER_DIM, FAKE_EMBEDDER_MAX_INPUT_CHARS } from "./fake-embedder.js";
export { runEmbedderContract, type EmbedderFactory } from "./embedder.contract.js";
