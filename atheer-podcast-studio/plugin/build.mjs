// Bundles src/main.ts into dist/index.js and copies static files.
// premierepro, uxp and os are provided by the host at runtime via require().
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
cpSync("static", "dist", { recursive: true });

// Keep manifest.json and package.json versions in lockstep.
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
if (manifest.version !== pkg.version) {
  console.error(`manifest version ${manifest.version} != package version ${pkg.version}`);
  process.exit(1);
}

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "iife",
  platform: "neutral",
  target: "es2020",
  external: ["premierepro", "uxp", "os", "fs"],
  sourcemap: true,
  logLevel: "info",
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  writeFileSync("dist/BUILD_INFO.txt", `version ${pkg.version}\nbuilt ${new Date().toISOString()}\n`);
}
