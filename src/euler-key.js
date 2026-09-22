import { readFile, rm, writeFile } from "node:fs/promises";

function requireSecureStorage(storage) {
  if (!storage.isEncryptionAvailable() ||
    (process.platform === "linux" && storage.getSelectedStorageBackend() === "basic_text")) {
    throw new Error("Secure key storage is unavailable on this computer. Configure an OS keychain or use SIGN_API_KEY instead.");
  }
}

export async function loadEulerApiKey(filePath, storage) {
  const encrypted = await readFile(filePath);
  requireSecureStorage(storage);
  return storage.decryptString(encrypted);
}

export async function saveEulerApiKey(filePath, key, storage) {
  if (!key) {
    await rm(filePath, { force: true });
    return;
  }
  requireSecureStorage(storage);
  await writeFile(filePath, storage.encryptString(key), { mode: 0o600 });
}
