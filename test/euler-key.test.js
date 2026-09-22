import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEulerApiKey, saveEulerApiKey } from "../src/euler-key.js";

test("stores Euler Stream API keys encrypted and removes them on request", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-key-test-"));
  const filePath = path.join(directory, "key.bin");
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: value => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: value => Buffer.from(value.toString().slice(10), "base64").toString()
  };
  try {
    await saveEulerApiKey(filePath, "example-private-key", storage);
    const bytes = await readFile(filePath);
    assert.equal(bytes.includes(Buffer.from("example-private-key")), false);
    assert.equal(await loadEulerApiKey(filePath, storage), "example-private-key");
    await saveEulerApiKey(filePath, "", storage);
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
