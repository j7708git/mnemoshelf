import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const [ref = "HEAD", label = "baseline"] = process.argv.slice(2);
if (!/^[a-zA-Z0-9_-]+$/.test(label) || !/^[a-zA-Z0-9_.-]+$/.test(ref)) throw new Error("ref／label 含非法字元");
const require = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const ts = require("typescript") as typeof import("../../packages/core/node_modules/typescript/lib/typescript.js");
const commit = execFileSync("git", ["rev-parse", "--verify", ref], { cwd: base, encoding: "utf8" }).trim();
const destination = path.join(base, ".tmp", "indexing-benchmark", `frozen-${label}`);
await fs.mkdir(destination, { recursive: true });
const components = [
  { name: "indexer", parts: ["packages", "core", "src", "indexer", "indexer.ts"] },
  { name: "scan", parts: ["packages", "core", "src", "indexer", "scan.ts"] },
  { name: "worker-embedder", parts: ["packages", "server", "src", "worker-embedder.ts"] },
  { name: "embedder-worker", parts: ["packages", "server", "src", "embedder-worker.ts"] },
];
const frozenTargets = new Map(components.map(({ name, parts }) => [path.join(base, ...parts).replace(/\.ts$/, ".js"), path.join(destination, `${name}.js`)]));
const packageTargets = new Map([["@mnemoshelf/core", path.join(base, "packages", "core", "dist", "index.js")], ["@mnemoshelf/embedder-transformers", path.join(base, "packages", "embedder-transformers", "dist", "index.js")]]);
const manifest = [];
for (const { name, parts } of components) {
  const source = execFileSync("git", ["show", `${commit}:${path.posix.join(...parts)}`], { cwd: base, encoding: "utf8" });
  const originalLocation = path.join(base, ...parts);
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
  const rewritten = compiled.replace(/from "([^"]+)"/g, (match, specifier: string) => {
    if (packageTargets.has(specifier)) return `from "${pathToFileURL(packageTargets.get(specifier)!).href}"`;
    if (specifier.startsWith("node:")) return match;
    if (!specifier.startsWith(".")) return `from "${pathToFileURL(createRequire(originalLocation).resolve(specifier)).href}"`;
    const sourceTarget = path.resolve(path.dirname(originalLocation), specifier);
    const segments = path.relative(base, sourceTarget).split(path.sep);
    const src = segments.indexOf("src"); if (src >= 0) segments[src] = "dist";
    const target = frozenTargets.get(sourceTarget) ?? path.join(base, ...segments);
    return `from "${pathToFileURL(target).href}"`;
  });
  await fs.writeFile(path.join(destination, `${name}.ts`), source);
  await fs.writeFile(path.join(destination, `${name}.js`), rewritten);
  manifest.push({ component: name, sourceSha256: createHash("sha256").update(source).digest("hex"), executableSha256: createHash("sha256").update(rewritten).digest("hex") });
}
await fs.writeFile(path.join(destination, "manifest.json"), JSON.stringify({ commit, typescript: ts.version, sharedDependencies: "current built core storage/path/chunk helpers and model implementation; their hashes must match between runs", manifest }, null, 2));
console.log(JSON.stringify({ directory: path.relative(base, destination), commit, manifest }, null, 2));
