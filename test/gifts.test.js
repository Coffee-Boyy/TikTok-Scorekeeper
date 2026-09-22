import test from "node:test";
import assert from "node:assert/strict";
import { calculateScores, extractRecipient, inferParticipantId, normalizeGift } from "../src/gifts.js";

const participants = [
  { id: "host", name: "Host", handle: "host_name", tiktokUserId: "100" },
  { id: "guest", name: "Guest", handle: "guest_name", tiktokUserId: "200" }
];

test("attributes a gift using a receiver user ID", () => {
  assert.deepEqual(inferParticipantId({ receiverUserId: "200" }, participants), {
    participantId: "guest",
    method: "recipient-id"
  });
});

test("attributes current connector payloads using toMemberId", () => {
  assert.deepEqual(inferParticipantId({ toMemberId: "200" }, participants), {
    participantId: "guest",
    method: "recipient-id"
  });
});

test("retains a Group LIVE recipient even before guests are discovered", () => {
  const raw = { toMemberId: "7504871949681181703", toMemberNickname: "Guest name" };
  assert.deepEqual(extractRecipient(raw), {
    userId: "7504871949681181703",
    name: "Guest name"
  });
  assert.deepEqual(normalizeGift(raw, []).recipient, extractRecipient(raw));
});

test("reads gift metadata from the current v3 gift object", () => {
  const event = normalizeGift({
    giftId: "88",
    gift: { name: "Galaxy", type: 0, diamondCount: 1000 },
    toMemberId: "200",
    repeatCount: 2,
    repeatEnd: 1
  }, participants);
  assert.equal(event.gift.name, "Galaxy");
  assert.equal(event.gift.totalValue, 2000);
  assert.equal(event.participantId, "guest");
});

test("leaves ambiguous multi-guest events unassigned", () => {
  assert.equal(inferParticipantId({}, participants).participantId, null);
});

test("does not score an in-progress streak update", () => {
  const event = normalizeGift({
    giftId: "1",
    giftDetails: { giftName: "Rose", giftType: 1, diamondCount: 1 },
    repeatCount: 4,
    repeatEnd: false
  }, [participants[0]], new Date("2026-01-01T00:00:00Z"));
  assert.equal(event.scoreable, false);
  assert.equal(event.gift.totalValue, 4);
});

test("scores only completed gifts", () => {
  const show = {
    participants,
    gifts: [
      { participantId: "guest", scoreable: false, gift: { totalValue: 2, repeatCount: 2 } },
      { participantId: "guest", scoreable: true, gift: { totalValue: 5, repeatCount: 5 } }
    ]
  };
  const guest = calculateScores(show).find(score => score.participant.id === "guest");
  assert.equal(guest.points, 5);
  assert.equal(guest.coins, 5);
  assert.equal(guest.gifts, 5);
  assert.equal(guest.events, 1);
});
