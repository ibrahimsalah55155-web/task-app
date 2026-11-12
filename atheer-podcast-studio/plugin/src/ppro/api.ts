/**
 * Single access point to the host modules. Tests replace them with fakes;
 * in Premiere they come from UXP's require().
 */
import type { premierepro } from "@adobe/premierepro";

declare const require: (id: string) => unknown;

export interface UxpHostInfo {
  name: string;
  version: string;
  uiLocale: string;
  uxpVersion: string;
  pluginVersion: string;
  os: string;
}

let pproOverride: premierepro | null = null;
let hostOverride: UxpHostInfo | null = null;

export function ppro(): premierepro {
  if (pproOverride) return pproOverride;
  return require("premierepro") as premierepro;
}

export function hostInfo(): UxpHostInfo {
  if (hostOverride) return hostOverride;
  const uxp = require("uxp") as typeof import("uxp");
  const os = require("os") as { platform(): string; release(): string };
  let platform = "unknown";
  try {
    platform = `${os.platform()} ${os.release()}`;
  } catch {
    /* os module optional */
  }
  return {
    name: uxp.host.name,
    version: uxp.host.version,
    uiLocale: uxp.host.uiLocale,
    uxpVersion: uxp.versions.uxp,
    pluginVersion: uxp.versions.plugin,
    os: platform,
  };
}

export function __setHostModulesForTests(p: unknown, host: UxpHostInfo | null): void {
  pproOverride = p as premierepro | null;
  hostOverride = host;
}
