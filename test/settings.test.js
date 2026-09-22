import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, formatRanking, publicSettings, shouldPlayGiftSound, validateEulerApiKeyChange, validateSettingsPatch } from "../src/settings.js";

test("ranking comment uses guest aliases, score abbreviations, and templates", () => {
  const scores = [
    { participant: { id: "host", role: "host", name: "Host" }, points: 9999 },
    { participant: { id: "jubii", role: "guest", tiktokUserId: "24", name: "Jubii⊰🎂24/09 ࣪˖໒꒱" }, points: 0 },
    { participant: { id: "cheshire", role: "guest", name: "Cheshire" }, points: 1000 },
    { participant: { id: "odette", role: "guest", name: "Odette" }, points: 500 },
    { participant: { id: "arliz", role: "guest", name: "Arliz" }, points: 30 },
    { participant: { id: null, role: "unassigned", name: "Unassigned" }, points: 400 }
  ];
  assert.equal(formatRanking(scores, { ...DEFAULT_SETTINGS, guestAliases: { "id:24": "Jubii" } }),
    "RANK: Cheshire - 1k, Odette - 500, Arliz - 30, Jubii - 0");
  assert.equal(formatRanking(scores, {
    ...DEFAULT_SETTINGS,
    guestAliases: { "id:24": "Jubii" },
    rankingTemplate: "Scores: {rankings}!",
    rankingEntryTemplate: "#{rank} {name}={score}",
    rankingSeparator: " | "
  }), "Scores: #1 Cheshire=1k | #2 Odette=500 | #3 Arliz=30 | #4 Jubii=0!");
});

test("settings updates reject invalid values and missing ranking placeholders", () => {
  assert.deepEqual(validateSettingsPatch({ minVisibleCoins: 0, playGiftSound: true, giftSound: "ding" }), { minVisibleCoins: 0, playGiftSound: true, giftSound: "ding" });
  assert.throws(() => validateSettingsPatch({ giftSound: "system" }), /supported gift sound/);
  assert.throws(() => validateSettingsPatch({ minVisibleCoins: -1 }), /Minimum gift value/);
  assert.throws(() => validateSettingsPatch({ rankingTemplate: "RANK:" }), /\{rankings\}/);
  assert.throws(() => validateSettingsPatch({ rankingEntryTemplate: "{name}" }), /\{name\} and \{score\}/);
  assert.throws(() => validateSettingsPatch({ lastUsername: "someone" }), /Unknown setting/);
});

test("Euler Stream key changes distinguish keep, replace, and remove", () => {
  assert.deepEqual(validateEulerApiKeyChange(undefined, undefined), { action: "keep" });
  assert.deepEqual(validateEulerApiKeyChange("  test-key  ", false), { action: "save", key: "test-key" });
  assert.deepEqual(validateEulerApiKeyChange(undefined, true), { action: "remove" });
  assert.throws(() => validateEulerApiKeyChange("key with spaces", false), /no spaces/);
  assert.throws(() => validateEulerApiKeyChange("key", true), /either/);
  assert.equal("eulerApiKey" in publicSettings(DEFAULT_SETTINGS), false);
});

test("sounds only for completed gifts visible under the minimum coin setting", () => {
  const settings = { ...DEFAULT_SETTINGS, playGiftSound: true, minVisibleCoins: 10 };
  const event = value => ({ scoreable: true, gift: { totalValue: value } });
  assert.equal(shouldPlayGiftSound(event(9), settings), false);
  assert.equal(shouldPlayGiftSound(event(10), settings), true);
  assert.equal(shouldPlayGiftSound({ ...event(10), scoreable: false }, settings), false);
  assert.equal(shouldPlayGiftSound(event(10), settings, true), false);
  assert.equal(shouldPlayGiftSound(event(10), { ...settings, playGiftSound: false }), false);
});
