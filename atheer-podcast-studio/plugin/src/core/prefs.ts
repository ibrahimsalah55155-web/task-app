/** Persistent panel preferences (UXP localStorage). Never throws. */

export interface Prefs {
  lang: "ar" | "en" | null; // null: follow Premiere's UI language
  companionUrl: string;
  logLevel: "debug" | "info" | "warn" | "error";
  lastView: string;
  accent: string;
  logoPath: string | null;
  /** Transcription: names/words to favour, and corrections applied to every episode. */
  glossary: string[];
  rules: [string, string][];
  /** Voice clean-up: cleaned file -> original file, to switch back. */
  cleanMap: Record<string, string>;
  mogrtDir: string | null;
}

const KEY = "mag.prefs.v1";

export const DEFAULT_PREFS: Prefs = {
  lang: null,
  companionUrl: "http://127.0.0.1:47820",
  logLevel: "info",
  lastView: "dashboard",
  accent: "#EC797B",
  logoPath: null,
  glossary: [],
  rules: [],
  cleanMap: {},
  mogrtDir: null,
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
