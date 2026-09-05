import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MAX_NAME_CODE_LENGTH = 256;

export function normalizeDisplayName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function canonicalizeName(name: string): string {
  return normalizeDisplayName(name).toLowerCase();
}

export function containsUnsafeNameCharacters(name: string): boolean {
  return /[\p{Cc}\p{Cf}]/u.test(name);
}

export function generateNameCode(): string {
  return `nc_${randomBytes(32).toString("base64url")}`;
}

export function nameCodeVerifier(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

export function verifierMatches(code: string, verifier: string): boolean {
  return verifiersEqual(nameCodeVerifier(code), verifier);
}

export function verifiersEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first, "hex");
  const secondBytes = Buffer.from(second, "hex");
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}
