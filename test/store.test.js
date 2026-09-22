import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ShowStore } from "../src/store.js";
import { normalizeGift } from "../src/gifts.js";

test("persists a show, appends its research ledger, and exports CSV", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.newShow({ title: "Test show", hostUsername: "host" });
    const participantId = store.show.participants[0].id;
    const event = {
      id: "event-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
      sender: { userId: "1", handle: "viewer", name: "Viewer" },
      gift: { id: "2", name: "Rose", repeatCount: 3, unitValue: 1, totalValue: 3 },
      scoreable: true,
      participantId,
      assignmentMethod: "recipient-id"
    };
    await store.recordGift(event, { raw: true });

    const state = JSON.parse(await readFile(path.join(directory, "active-show.json"), "utf8"));
    const ledger = await readFile(path.join(directory, `${state.id}.jsonl`), "utf8");
    assert.equal(state.gifts.length, 1);
    assert.match(ledger, /"raw":\{"raw":true\}/);
    assert.match(store.csv(), /"Rose"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("assigns multiple gifts together and rejects an invalid batch without partial changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-bulk-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.addParticipant({ name: "Guest", handle: "guest" });
    const guestId = store.show.participants[0].id;
    const gift = id => ({
      id, receivedAt: "2026-01-01T00:00:00.000Z", sender: { name: "Viewer" },
      gift: { id: "rose", name: "Rose", repeatCount: 1, totalValue: 1 },
      scoreable: true, participantId: null, assignmentMethod: "unassigned"
    });
    await store.recordGift(gift("one"), {});
    await store.recordGift(gift("two"), {});
    await assert.rejects(store.assignGifts(["one", "missing"], guestId), /not found/);
    assert.equal(store.show.gifts.find(event => event.id === "one").participantId, null);
    await store.assignGifts(["one", "two"], guestId);
    assert.equal(store.show.gifts.filter(event => event.participantId === guestId).length, 2);
    const saved = JSON.parse(await readFile(path.join(directory, "active-show.json"), "utf8"));
    assert.equal(saved.gifts.filter(event => event.participantId === guestId).length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active dancer receives only new gifts that would otherwise be unassigned", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-dancer-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.newShow({ title: "Multi-guest show", hostUsername: "host" });
    await store.updateHost({ userId: "host-id", name: "Host", handle: "host" });
    await store.addParticipant({ name: "Arliz", handle: "arliz" });
    await store.addParticipant({ name: "Odette", handle: "odette" });
    const arliz = store.show.participants.find(item => item.handle === "arliz");
    const odette = store.show.participants.find(item => item.handle === "odette");
    const gift = (id, name = "Rose", participantId = null) => ({
      id, receivedAt: "2026-01-01T00:00:00.000Z", sender: { name: "Viewer" },
      gift: { id: name, name, repeatCount: 1, totalValue: 1 }, scoreable: true,
      participantId, assignmentMethod: participantId ? "recipient-id" : "unassigned"
    });
    await assert.rejects(store.setActiveDancer("missing"), /Choose a guest/);
    await assert.rejects(store.setActiveDancer(store.show.participants.find(item => item.role === "host").id), /Choose a guest/);
    await store.setActiveDancer(arliz.id);
    await store.recordGift(gift("unassigned-1"), {});
    await store.recordGift(normalizeGift({
      msgId: "host-directed", receiverUserId: "host-id", giftDetails: { giftName: "Rose", diamondCount: 1 }
    }, store.show.participants), {});
    await store.recordGift(gift("direct", "Direct", odette.id), {});
    await store.setRoutingRule("Fireworks", odette);
    await store.recordGift(gift("routed", "Fireworks"), {});
    await store.setActiveDancer(null);
    await store.recordGift(gift("unassigned-2"), {});
    assert.equal(store.show.gifts.find(item => item.id === "unassigned-1").participantId, arliz.id);
    assert.equal(store.show.gifts.find(item => item.id === "unassigned-1").assignmentMethod, "active-dancer");
    assert.equal(store.show.gifts.find(item => item.sourceMessageId === "host-directed").participantId, arliz.id);
    assert.equal(store.show.gifts.find(item => item.id === "direct").participantId, odette.id);
    assert.equal(store.show.gifts.find(item => item.id === "routed").participantId, odette.id);
    assert.equal(store.show.gifts.find(item => item.id === "unassigned-2").participantId, null);
    await store.setActiveDancer(odette.id);
    const reopened = new ShowStore(directory);
    await reopened.initialize();
    assert.equal(reopened.show.activeDancerId, odette.id);
    assert.equal(reopened.show.gifts.find(item => item.id === "unassigned-1").participantId, arliz.id);
    await reopened.removeParticipant(odette.id);
    assert.equal(reopened.show.activeDancerId, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed streak keeps the dancer active when the streak began", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-dancer-streak-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.addParticipant({ name: "First", handle: "first" });
    await store.addParticipant({ name: "Second", handle: "second" });
    const [first, second] = store.show.participants;
    const gift = (id, receivedAt, scoreable) => ({
      id, receivedAt, sender: { userId: "viewer" },
      gift: { id: "rose", name: "Rose", giftType: 1, repeatCount: 1, totalValue: 1 },
      scoreable, participantId: null, assignmentMethod: "unassigned"
    });
    await store.setActiveDancer(first.id);
    await store.recordGift(gift("pending", "2026-01-01T00:00:00.000Z", false), {});
    await store.setActiveDancer(second.id);
    await store.recordGift(gift("complete", "2026-01-01T00:00:01.000Z", true), {});
    assert.equal(store.show.gifts.length, 1);
    assert.equal(store.show.gifts[0].id, "pending");
    assert.equal(store.show.gifts[0].participantId, first.id);
    assert.equal(store.show.gifts[0].scoreable, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("coalesces a streak update and completion into one visible gift", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-streak-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    const base = {
      receivedAt: "2026-01-01T00:00:00.000Z",
      sender: { userId: "viewer-1", handle: "viewer", name: "Viewer" },
      recipient: { userId: "guest-1", name: "Guest" },
      participantId: null,
      assignmentMethod: "unassigned"
    };
    await store.recordGift({
      ...base,
      id: "pending",
      sourceMessageId: "message-1",
      gift: { id: "rose", name: "Rose", repeatCount: 1, giftType: 1, repeatEnd: false },
      scoreable: false
    }, { repeatEnd: 0 });
    await store.recordGift({
      ...base,
      id: "complete",
      sourceMessageId: "message-2",
      receivedAt: "2026-01-01T00:00:03.000Z",
      gift: { id: "rose", name: "Rose", repeatCount: 1, giftType: 1, repeatEnd: true },
      scoreable: true
    }, { repeatEnd: 1 });

    assert.equal(store.show.gifts.length, 1);
    assert.equal(store.show.gifts[0].id, "pending");
    assert.equal(store.show.gifts[0].scoreable, true);
    const ledger = await readFile(path.join(directory, `${store.show.id}.jsonl`), "utf8");
    assert.equal(ledger.trim().split("\n").length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("starts a show per stream session and keeps later segments together", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-session-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.addParticipant({ name: "Guest", handle: "guest" });
    const guestId = store.show.participants[0].id;

    await store.beginStreamSession({ roomId: "room-1", streamId: "segment-1", hostUsername: "host" });
    const showId = store.show.id;
    assert.equal(store.show.streamSessionId, "room-1");
    assert.equal(store.show.segments.length, 1);
    assert.equal(store.show.participants.some(participant => participant.id === guestId), true);
    assert.match(store.show.title, /@host/);

    await store.recordGift({
      id: "gift-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
      sender: { userId: "viewer" },
      gift: { id: "rose", giftType: 0, repeatCount: 1, totalValue: 1 },
      scoreable: true,
      participantId: guestId,
      assignmentMethod: "manual"
    }, { raw: true });

    await store.beginStreamSession({ roomId: "room-1", streamId: "segment-2", hostUsername: "host" });
    assert.equal(store.show.id, showId);
    assert.equal(store.show.gifts.length, 1);
    assert.deepEqual(store.show.segments.map(segment => segment.id), ["segment-1", "segment-2"]);

    await store.beginStreamSession({ roomId: "room-1", streamId: "segment-2", hostUsername: "host" });
    assert.equal(store.show.segments.length, 2);

    await store.beginStreamSession({ roomId: "room-2", streamId: "segment-3", hostUsername: "host" });
    assert.notEqual(store.show.id, showId);
    assert.equal(store.show.streamSessionId, "room-2");
    assert.equal(store.show.gifts.length, 0);
    assert.deepEqual(store.show.segments.map(segment => segment.id), ["segment-3"]);
    assert.equal(store.show.participants[0].handle, "host");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reassigns an earlier recipient once a guest is discovered", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-recipient-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    store.show.gifts = [{
      id: "gift",
      receivedAt: "2026-01-01T00:00:00.000Z",
      sender: { userId: "viewer" },
      recipient: { userId: "guest-123", name: "Guest" },
      gift: { id: "rose", giftType: 0, repeatCount: 1, totalValue: 1 },
      scoreable: true,
      participantId: null,
      assignmentMethod: "unassigned"
    }];

    const result = await store.upsertDiscoveredParticipants([{
      userId: "guest-123",
      handle: "guest_handle",
      name: "Guest"
    }]);
    assert.equal(result.reassigned, 1);
    assert.equal(store.show.gifts[0].participantId, store.show.participants[0].id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes a configured gift to the chosen guest regardless of recipient", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-routing-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.addParticipant({ name: "Alexa", handle: "alexa" });
    await store.addParticipant({ name: "Bella", handle: "bella" });
    const alexa = store.show.participants.find(participant => participant.handle === "alexa");
    await store.setRoutingRule("Drip Brewing", alexa);

    await store.recordGift({
      id: "gift-1",
      receivedAt: "2026-01-01T00:00:00.000Z",
      sender: { userId: "viewer", handle: "viewer", name: "Viewer" },
      recipient: { userId: "bella-id", name: "Bella" },
      gift: { id: "9", name: "Drip Brewing", repeatCount: 1, unitValue: 50, totalValue: 50 },
      scoreable: true,
      participantId: null,
      assignmentMethod: "unassigned"
    }, { raw: true });

    assert.equal(store.show.gifts[0].participantId, alexa.id);
    assert.equal(store.show.gifts[0].assignmentMethod, "rule");

    const reopened = new ShowStore(directory);
    await reopened.initialize();
    assert.deepEqual(Object.keys(reopened.routingRules), ["drip brewing"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("moves earlier host gifts to unassigned when guests join", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-host-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.newShow({ title: "Multi-guest show", hostUsername: "host" });
    await store.updateHost({ userId: "host-id", name: "Host", handle: "host" });
    const hostId = store.show.participants[0].id;
    await store.recordGift(normalizeGift({
      msgId: "host-before", receiverUserId: "host-id", giftDetails: { giftName: "Rose", diamondCount: 1 }
    }, store.show.participants), {});
    assert.equal(store.show.gifts[0].participantId, hostId);

    await store.upsertDiscoveredParticipants([{ userId: "guest-id", name: "Guest", handle: "guest" }]);
    assert.equal(store.show.gifts[0].participantId, null);
    assert.equal(store.snapshot().scores.some(score => score.participant.id === hostId), false);
    assert.equal(store.snapshot().scores.find(score => score.participant.id === null).points, 1);
    assert.match(store.csv(), /"Unassigned"/);

    await store.recordGift(normalizeGift({
      msgId: "host-after", receiverUserId: "host-id", giftDetails: { giftName: "Rose", diamondCount: 1 }
    }, store.show.participants), {});
    assert.equal(store.show.gifts[0].participantId, null);
    await assert.rejects(store.assignGift(store.show.gifts[0].id, hostId), /Host gifts stay unassigned/);
    await assert.rejects(store.setRoutingRule("Rose", store.show.participants[0]), /host cannot receive routed gifts/);

    const reopened = new ShowStore(directory);
    await reopened.initialize();
    assert.equal(reopened.show.gifts.every(event => event.participantId === null), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("removes a host mistakenly discovered from a gift before the roster arrives", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "scorekeeper-host-duplicate-test-"));
  try {
    const store = new ShowStore(directory);
    await store.initialize();
    await store.newShow({ title: "Test show", hostUsername: "host" });
    await store.upsertDiscoveredParticipants([{ userId: "host-id", name: "Host display name" }]);
    const duplicate = store.show.participants.find(item => item.role === "guest");
    assert.ok(duplicate);
    await store.recordGift(normalizeGift({
      msgId: "before-roster", receiverUserId: "host-id", giftDetails: { giftName: "Rose", diamondCount: 1 }
    }, store.show.participants), {});
    assert.equal(store.show.gifts[0].participantId, duplicate.id);

    await store.updateHost({ userId: "host-id", name: "Host display name", handle: "host" });
    await store.upsertDiscoveredParticipants([{ userId: "real-guest", name: "Real guest" }]);
    assert.equal(store.show.participants.some(item => item.id === duplicate.id), false);
    assert.equal(store.show.gifts[0].participantId, null);
    assert.equal(store.snapshot().scores.find(score => score.participant.id === null).points, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
