function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getAtPath(object, path) {
  return path.reduce((value, key) => value?.[key], object);
}

export function jsonSafe(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Uint8Array) return `[binary:${item.byteLength}]`;
    if (item && typeof item === "object") {
      if (seen.has(item)) return "[circular]";
      seen.add(item);
    }
    return item;
  }));
}

const RECIPIENT_ID_PATHS = [
  ["receiverUserId"],
  ["recipientUserId"],
  ["toUserId"],
  ["toMemberId"],
  ["anchorUserId"],
  ["guestUserId"],
  ["giftExtra", "toUserId"],
  ["toMemberIdInt"],
  ["receiver", "userId"],
  ["recipient", "userId"],
  ["toUser", "userId"],
  ["toUser", "id"],
  ["toUser", "idStr"],
  ["giftDetails", "receiverUserId"],
  ["giftDetails", "recipientUserId"]
];

const RECIPIENT_NAME_PATHS = [
  ["receiver", "uniqueId"],
  ["receiver", "nickname"],
  ["recipient", "uniqueId"],
  ["recipient", "nickname"],
  ["toUser", "uniqueId"],
  ["toUser", "displayId"],
  ["toUser", "nickname"],
  ["toMemberNickname"],
  ["receiverUniqueId"],
  ["recipientUniqueId"]
];

export function extractRecipient(raw) {
  const userId = RECIPIENT_ID_PATHS
    .map(path => text(getAtPath(raw, path)))
    .find(Boolean) || "";
  const name = RECIPIENT_NAME_PATHS
    .map(path => text(getAtPath(raw, path)))
    .find(Boolean) || "";
  return { userId, name };
}

export function inferParticipantId(raw, participants) {
  const recipient = extractRecipient(raw);
  const ids = recipient.userId ? [recipient.userId] : [];
  const names = recipient.name ? [recipient.name.toLowerCase()] : [];

  for (const participant of participants) {
    if (participant.tiktokUserId && ids.includes(text(participant.tiktokUserId))) {
      return { participantId: participant.id, method: "recipient-id" };
    }

    const handles = [participant.handle, participant.name]
      .map(value => text(value).replace(/^@/, "").toLowerCase())
      .filter(Boolean);

    if (handles.some(handle => names.includes(handle))) {
      return { participantId: participant.id, method: "recipient-name" };
    }
  }

  if (participants.length === 1) {
    return { participantId: participants[0].id, method: "single-participant" };
  }

  return { participantId: null, method: "unassigned" };
}

export function normalizeGift(raw, participants, receivedAt = new Date()) {
  const repeatCount = Math.max(1, number(raw.repeatCount, 1));
  const giftType = number(raw.gift?.type ?? raw.giftDetails?.giftType, 0);
  const repeatEnd = Boolean(raw.repeatEnd);
  const scoreable = giftType !== 1 || repeatEnd;
  const unitValue = number(
    raw.extendedGiftInfo?.diamondCount ??
      raw.gift?.diamondCount ??
      raw.giftDetails?.diamondCount ??
      raw.diamondCount,
    0
  );
  const assignment = inferParticipantId(raw, participants);
  const recipient = extractRecipient(raw);

  return {
    id: crypto.randomUUID(),
    sourceMessageId: text(raw.common?.msgId || raw.msgId),
    receivedAt: receivedAt.toISOString(),
    sender: {
      userId: text(raw.user?.userId || raw.userId),
      handle: text(raw.user?.uniqueId || raw.uniqueId),
      name: text(raw.user?.nickname || raw.nickname || raw.user?.uniqueId || "Unknown viewer")
    },
    gift: {
      id: text(raw.giftId),
      name: text(raw.gift?.name || raw.giftDetails?.giftName || raw.extendedGiftInfo?.name || raw.giftName || "Unknown gift"),
      repeatCount,
      unitValue,
      totalValue: unitValue * repeatCount,
      giftType,
      repeatEnd,
      imageUrl: text(
        raw.gift?.image?.urlList?.[0] ||
        raw.gift?.image?.url?.[0] ||
        raw.extendedGiftInfo?.image?.urlList?.[0] ||
        raw.giftPictureUrl
      )
    },
    scoreable,
    recipient,
    participantId: assignment.participantId,
    assignmentMethod: assignment.method
  };
}

export function calculateScores(show) {
  const scores = new Map(show.participants.map(participant => [participant.id, {
    participant,
    points: 0,
    coins: 0,
    gifts: 0,
    events: 0
  }]));
  const unassigned = {
    participant: { id: null, name: "Unassigned", handle: "" },
    points: 0,
    coins: 0,
    gifts: 0,
    events: 0
  };

  for (const event of show.gifts) {
    if (!event.scoreable) continue;
    const score = scores.get(event.participantId) || unassigned;
    score.points += number(event.gift.totalValue) || number(event.gift.repeatCount, 1);
    score.coins += number(event.gift.totalValue);
    score.gifts += number(event.gift.repeatCount, 1);
    score.events += 1;
  }

  return [...scores.values(), unassigned]
    .filter(score => score.participant.id !== null || score.events > 0)
    .sort((a, b) => b.points - a.points || b.gifts - a.gifts);
}

export function csvForShow(show) {
  const quote = value => `"${text(value).replaceAll('"', '""')}"`;
  const header = [
    "received_at", "sender_handle", "sender_name", "gift_id", "gift_name",
    "repeat_count", "unit_value", "total_value", "scoreable", "participant",
    "participant_handle", "assignment_method"
  ];
  const participants = new Map(show.participants.map(item => [item.id, item]));
  const rows = show.gifts.map(event => {
    const participant = participants.get(event.participantId);
    return [
      event.receivedAt,
      event.sender.handle,
      event.sender.name,
      event.gift.id,
      event.gift.name,
      event.gift.repeatCount,
      event.gift.unitValue,
      event.gift.totalValue,
      event.scoreable,
      participant?.name || "Unassigned",
      participant?.handle || "",
      event.assignmentMethod
    ].map(quote).join(",");
  });
  return [header.map(quote).join(","), ...rows].join("\r\n");
}
