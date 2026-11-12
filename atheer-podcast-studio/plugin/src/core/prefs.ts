/** Persistent panel preferences (UXP localStorage). Never throws. */

export interface Prefs {
  companionUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
  lastView: string;
}

const KEY = "atheer.prefs.v1";

export const DEFAULT_PREFS: Prefs = {
  companionUrl: "http://127.0.0.1:47820",
  logLevel: "info",
  lastView: "dashboard",
};

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadPrefs(): Prefs {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* storage full or unavailable: prefs are a convenience */
  }
}
