export const DEFAULT_SETTINGS = Object.freeze({
  autoConnect: true,
  autoReconnect: true,
  lastUsername: "",
  minVisibleCoins: 10,
  playGiftSound: false,
  giftSound: "ding",
  guestAliases: {},
  rankingTemplate: "RANK: {rankings}",
  rankingEntryTemplate: "{name} - {score}",
  rankingSeparator: ", "
});

export function publicSettings(settings) {
  const { lastUsername: _lastUsername, ...visible } = settings;
  return visible;
}

export function shouldPlayGiftSound(event, settings, alreadyCompleted = false) {
  return Boolean(settings.playGiftSound && event.scoreable && !alreadyCompleted &&
    (event.gift?.totalValue || 0) >= settings.minVisibleCoins);
}

export function validateEulerApiKeyChange(key, remove) {
  if (remove !== undefined && typeof remove !== "boolean") throw new Error("Invalid API key removal request.");
  if (key !== undefined && typeof key !== "string") throw new Error("Invalid Euler Stream API key.");
  const clean = key?.trim() || "";
  if (clean && (clean.length > 2048 || /\s/.test(clean))) throw new Error("Euler Stream API key must be at most 2,048 characters with no spaces.");
  if (remove && clean) throw new Error("Choose either a new API key or Remove saved key.");
  return remove ? { action: "remove" } : clean ? { action: "save", key: clean } : { action: "keep" };
}

export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Invalid settings update.");
  const allowed = ["autoConnect", "autoReconnect", "minVisibleCoins", "playGiftSound", "giftSound", "guestAliases", "rankingTemplate", "rankingEntryTemplate", "rankingSeparator"];
  for (const key of Object.keys(patch)) {
    if (!allowed.includes(key)) throw new Error(`Unknown setting: ${key}`);
  }
  for (const key of ["autoConnect", "autoReconnect", "playGiftSound"]) {
    if (key in patch && typeof patch[key] !== "boolean") throw new Error(`${key} must be on or off.`);
  }
  if ("minVisibleCoins" in patch && (!Number.isInteger(patch.minVisibleCoins) || patch.minVisibleCoins < 0 || patch.minVisibleCoins > 1_000_000)) {
    throw new Error("Minimum gift value must be a whole number from 0 to 1,000,000.");
  }
  if ("giftSound" in patch && !["ding", "chime", "pop"].includes(patch.giftSound)) throw new Error("Choose a supported gift sound.");
  if ("guestAliases" in patch) {
    if (!patch.guestAliases || typeof patch.guestAliases !== "object" || Array.isArray(patch.guestAliases)) throw new Error("Invalid guest names.");
    if (Object.keys(patch.guestAliases).length > 500) throw new Error("Too many guest names.");
    for (const [key, value] of Object.entries(patch.guestAliases)) {
      if (!/^(id|handle|name):.{1,100}$/.test(key) || typeof value !== "string" || value.length > 60) {
        throw new Error("Guest names must be at most 60 characters.");
      }
    }
  }
  for (const [key, limit] of [["rankingTemplate", 240], ["rankingEntryTemplate", 120], ["rankingSeparator", 30]]) {
    if (key in patch && (typeof patch[key] !== "string" || patch[key].length > limit)) throw new Error(`${key} is too long.`);
  }
  if ("rankingTemplate" in patch && !patch.rankingTemplate.includes("{rankings}")) throw new Error("Comment format must contain {rankings}.");
  if ("rankingEntryTemplate" in patch && (!patch.rankingEntryTemplate.includes("{name}") || !patch.rankingEntryTemplate.includes("{score}"))) {
    throw new Error("Guest format must contain {name} and {score}.");
  }
  return patch;
}

export function guestAliasKey(participant) {
  if (participant.tiktokUserId) return `id:${participant.tiktokUserId}`;
  if (participant.handle) return `handle:${participant.handle.toLowerCase()}`;
  return `name:${participant.name.toLowerCase()}`;
}

export function compactScore(points) {
  const value = Math.max(0, Math.round(Number(points) || 0));
  if (value < 1000) return String(value);
  const unit = value >= 1_000_000 ? 1_000_000 : 1000;
  const suffix = unit === 1_000_000 ? "m" : "k";
  const compact = Math.round(value / unit * 10) / 10;
  return `${Number.isInteger(compact) ? compact : compact.toFixed(1)}${suffix}`;
}

export function formatRanking(scores, settings) {
  const guests = scores
    .map((score, index) => ({ ...score, index }))
    .filter(score => score.participant?.role !== "host" && score.participant?.id)
    .sort((left, right) => right.points - left.points || left.index - right.index);
  const entries = guests.map((score, index) => {
    const alias = settings.guestAliases?.[guestAliasKey(score.participant)]?.trim();
    const name = alias || score.participant.name || score.participant.handle || "Guest";
    return settings.rankingEntryTemplate
      .replaceAll("{name}", name)
      .replaceAll("{score}", compactScore(score.points))
      .replaceAll("{rank}", String(index + 1));
  });
  return settings.rankingTemplate.replaceAll("{rankings}", entries.join(settings.rankingSeparator));
}
