/** Version strings like "26.5.1", "27.0.0-beta.22" or "26.3". */

export type Version = [number, number, number];

export function parseVersion(v: string | null | undefined): Version | null {
  if (!v) return null;
  const m = /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `version` >= `minimum`. Unknown versions are treated as too old. */
export function atLeast(version: string | null | undefined, minimum: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  return compareVersions(a, b) >= 0;
}
