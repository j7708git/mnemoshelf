import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
export default { root: path.resolve(dir, "..", ".."), cacheDir: path.join(dir, "..", "..", ".tmp", "video-acceptance", "vite-cache"), test: { include: ["scripts/video-acceptance/*.test.ts"], environment: "node" } };
