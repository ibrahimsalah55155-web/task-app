// Bundles src/main.ts into dist/index.js and copies static files.
// premierepro, uxp and os are provided by the host at runtime via require().
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
// --hybrid: Windows package with the built-in engine (UXP Hybrid addon, manifest v6).
const hybrid = process.argv.includes("--hybrid");
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
if (hybrid) {
  manifest.manifestVersion = 6;
  manifest.addon = { name: "mag_engine.uxpaddon" };
  manifest.requiredPermissions.enableAddon = true;
  writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
}

const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/index.js",
  format: "iife",
  platform: "neutral",
  target: "es2020",
  external: ["premierepro", "uxp", "os", "fs", "mag_engine.uxpaddon"],
  sourcemap: true,
  logLevel: "info",
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version), __HYBRID__: JSON.stringify(hybrid) },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
  writeFileSync("dist/BUILD_INFO.txt", `version ${pkg.version}\nhybrid ${hybrid}\nbuilt ${new Date().toISOString()}\n`);
}
