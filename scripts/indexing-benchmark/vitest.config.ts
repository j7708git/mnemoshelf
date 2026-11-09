import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
export default { root: directory, cacheDir: path.join(directory, "..", "..", ".tmp", "indexing-benchmark", "vite-cache"), test: { include: ["benchmark.test.ts"], environment: "node" } };
