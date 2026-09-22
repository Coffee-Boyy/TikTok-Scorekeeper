import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ShowStore } from "../src/store.js";

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
