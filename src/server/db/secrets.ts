import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "./database.js";

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

/**
 * Resolve the credential encryption key. Production must set SHIPLOG_ENCRYPTION_KEY.
 * Local development falls back to a random key file next to the database (git-ignored).
 */
export function resolveEncryptionKey(env: NodeJS.ProcessEnv, keyFilePath: string): Buffer {
  const configured = env.SHIPLOG_ENCRYPTION_KEY?.trim();
  if (configured) {
    if (configured.length < 24) throw new SecretKeyError("SHIPLOG_ENCRYPTION_KEY 至少需要 24 位。");
    return scryptSync(configured, "shiplog-credentials-v1", 32);
  }
  if (env.NODE_ENV === "production") {
    throw new SecretKeyError("生产环境必须配置 SHIPLOG_ENCRYPTION_KEY 才能保存令牌。");
  }
  if (!existsSync(keyFilePath)) {
    mkdirSync(dirname(keyFilePath), { recursive: true });
    writeFileSync(keyFilePath, randomBytes(32).toString("base64"), { mode: 0o600 });
  }
  chmodSync(keyFilePath, 0o600);
  return scryptSync(readFileSync(keyFilePath, "utf8").trim(), "shiplog-credentials-v1", 32);
}

export function encryptSecret(
  key: Buffer,
  plaintext: string,
): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptSecret(
  key: Buffer,
  sealed: { ciphertext: string; iv: string; tag: string },
): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export class CredentialStore {
  constructor(
    private readonly db: Db,
    private readonly key: () => Buffer,
  ) {}

  set(name: string, value: string): { hint: string } {
    const sealed = encryptSecret(this.key(), value);
    const hint = value.slice(-4);
    this.db
      .prepare(
        `INSERT INTO credentials (name, ciphertext, iv, tag, hint, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag,
           hint = excluded.hint, updated_at = excluded.updated_at`,
      )
      .run(name, sealed.ciphertext, sealed.iv, sealed.tag, hint, new Date().toISOString());
    return { hint };
  }

  get(name: string): string | null {
    const row = this.db
      .prepare("SELECT ciphertext, iv, tag FROM credentials WHERE name = ?")
      .get(name) as { ciphertext: string; iv: string; tag: string } | undefined;
    if (!row) return null;
    return decryptSecret(this.key(), row);
  }

  status(name: string): { configured: boolean; hint: string | null; updatedAt: string | null } {
    const row = this.db
      .prepare("SELECT hint, updated_at FROM credentials WHERE name = ?")
      .get(name) as { hint: string; updated_at: string } | undefined;
    return {
      configured: Boolean(row),
      hint: row?.hint ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  }

  delete(name: string): void {
    this.db.prepare("DELETE FROM credentials WHERE name = ?").run(name);
  }
}
