import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

await import("./prepare-assets");
const root = process.cwd();
await rm(join(root, "dist"), { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(root, "index.html")],
  outdir: join(root, "dist"),
  target: "browser",
  sourcemap: "linked",
  define: {
    "process.env.BUN_PUBLIC_INSTANT_APP_ID": JSON.stringify(process.env.BUN_PUBLIC_INSTANT_APP_ID ?? ""),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await cp(join(root, "src/assets"), join(root, "dist/assets"), { recursive: true });

console.log(`Built ${result.outputs.length} files into dist/`);
