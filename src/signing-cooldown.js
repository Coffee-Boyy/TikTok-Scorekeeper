import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

export function signingIdentity(key) {
  return key ? createHash("sha256").update(key).digest("hex") : "community";
}

export function loadSigningCooldown(filePath, identity) {
  try {
    const saved = JSON.parse(readFileSync(filePath, "utf8"));
    return saved.identity === identity && Number.isSafeInteger(saved.retryAt) && saved.retryAt > Date.now()
      ? saved.retryAt : 0;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read signing cooldown", error);
    return 0;
  }
}

export function saveSigningCooldown(filePath, identity, retryAt) {
  if (!retryAt) {
    rmSync(filePath, { force: true });
    return;
  }
  const temporary = `${filePath}.tmp`;
  writeFileSync(temporary, JSON.stringify({ identity, retryAt }), { mode: 0o600 });
  renameSync(temporary, filePath);
}
