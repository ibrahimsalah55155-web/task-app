/**
 * Pairing token in UXP secureStorage (encrypted per user). UXP has no
 * TextDecoder, so bytes are decoded by hand; the token is URL-safe ASCII.
 */
import { logger } from "../core/log.ts";
import type { TokenStore } from "./client.ts";

declare const require: (id: string) => unknown;
const log = logger("token");
const KEY = "mag.engine.token";

interface SecureStorage {
  getItem(key: string): Promise<Uint8Array | ArrayBuffer | string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function bytesToAscii(value: Uint8Array | ArrayBuffer | string | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s || null;
}

export class UxpTokenStore implements TokenStore {
  private cache: string | null | undefined;

  private storage(): SecureStorage | null {
    try {
      const uxp = require("uxp") as { storage?: { secureStorage?: SecureStorage } };
      return uxp.storage?.secureStorage ?? null;
    } catch {
      return null;
    }
  }

  async get(): Promise<string | null> {
    if (this.cache !== undefined) return this.cache;
    const s = this.storage();
    if (!s) return (this.cache = null);
    try {
      this.cache = bytesToAscii(await s.getItem(KEY));
    } catch {
      // getItem rejects when the key does not exist.
      this.cache = null;
    }
    return this.cache;
  }

  async set(token: string): Promise<void> {
    this.cache = token;
    const s = this.storage();
    if (!s) {
      log.warn("secureStorage unavailable: pairing will last until Premiere restarts");
      return;
    }
    try {
      await s.setItem(KEY, token);
    } catch (e) {
      log.warn("Could not save the pairing token; you may need to pair again after restart", e);
    }
  }

  async clear(): Promise<void> {
    this.cache = null;
    try {
      await this.storage()?.removeItem(KEY);
    } catch {
      /* already absent */
    }
  }
}
