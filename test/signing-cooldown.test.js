import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadSigningCooldown, saveSigningCooldown, signingIdentity } from "../src/signing-cooldown.js";

test("persists a signing cooldown without exposing the API key", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "signing-cooldown-"));
  const filePath = path.join(directory, "cooldown.json");
  try {
    const retryAt = Date.now() + 600_000;
    const identity = signingIdentity("private-key");
    saveSigningCooldown(filePath, identity, retryAt);
    assert.equal(loadSigningCooldown(filePath, identity), retryAt);
    assert.equal(loadSigningCooldown(filePath, signingIdentity("new-key")), 0);
    assert.ok(!readFileSync(filePath, "utf8").includes("private-key"));
    saveSigningCooldown(filePath, identity, 0);
    assert.equal(loadSigningCooldown(filePath, identity), 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
