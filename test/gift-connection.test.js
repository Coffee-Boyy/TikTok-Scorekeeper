import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SignConfig, SignatureRateLimitError } from "tiktok-live-connector";
import { GiftConnection, configureSigningKey, connectionFailure } from "../src/gift-connection.js";

function harness({ saveGift = async () => {}, saveRoom = async () => {}, shouldReconnect = () => true, getCooldownUntil = () => 0, onRateLimit = () => {}, onConnected = () => {} } = {}) {
  const clients = [];
  const statuses = [];
  const timers = new Map();
  const gifts = [];
  const linkUpdates = [];
  let recovered = 0;
  let nextTimer = 0;
  const listener = new GiftConnection({
    createClient: () => {
      const client = new EventEmitter();
      client.connect = async () => ({ roomId: "123" });
      client.disconnect = async () => { client.disconnected = true; };
      clients.push(client);
      return client;
    },
    onStatus: (state, detail) => statuses.push({ state, detail }),
    onRoom: saveRoom,
    onGift: async gift => { gifts.push(gift); await saveGift(gift); },
    onLink: async data => { linkUpdates.push(data); },
    onRecovered: async () => { recovered++; },
    shouldReconnect,
    getCooldownUntil,
    onRateLimit,
    onConnected,
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id)
  });
  const fireTimer = delay => {
    const [id, timer] = [...timers].find(([, item]) => item.delay === delay) || [];
    assert.ok(timer, `Expected a ${delay}ms timer`);
    timers.delete(id);
    timer.callback();
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return { listener, clients, statuses, timers, gifts, linkUpdates, get recovered() { return recovered; }, fireTimer, settle };
}

test("reports a dropped socket, reconnects, and ignores the old socket", async () => {
  const h = harness();
  h.listener.start("creator");
  await h.settle();
  assert.equal(h.statuses.at(-1).state, "connected");
  h.clients[0].emit("disconnected", { code: 1006 });
  assert.equal(h.statuses.at(-1).state, "reconnecting");
  assert.match(h.statuses.at(-1).detail, /may be missed/);
  h.fireTimer(2_000);
  await h.settle();
  assert.equal(h.statuses.at(-1).state, "connected");
  assert.match(h.statuses.at(-1).detail, /restored/);
  assert.equal(h.recovered, 1);
  h.clients[0].emit("gift", { id: "stale" });
  h.clients[1].emit("gift", { id: "current" });
  h.clients[1].emit("decodedData", "WebcastLinkMicMessage", { type: "WebcastLinkMicMessage", data: { id: "guest" } });
  await h.settle();
  assert.deepEqual(h.gifts, [{ id: "current" }]);
  assert.deepEqual(h.linkUpdates, [{ id: "guest" }]);
  h.listener.stop();
});

test("cancels a scheduled reconnect when stopped", async () => {
  const h = harness();
  h.listener.start("creator");
  await h.settle();
  h.clients[0].emit("disconnected", { code: 1006 });
  h.listener.stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.clients.length, 1);
});

test("stops with an actionable error when automatic reconnection is disabled", async () => {
  const h = harness({ shouldReconnect: () => false });
  h.listener.start("creator");
  await h.settle();
  h.clients[0].emit("disconnected", { code: 1006 });
  assert.equal(h.statuses.at(-1).state, "error");
  assert.match(h.statuses.at(-1).detail, /Automatic reconnection is off/);
  assert.equal(h.timers.size, 0);
});

test("a stalled connection times out and retries", async () => {
  const h = harness();
  h.listener.createClient = () => {
    const client = new EventEmitter();
    client.connect = () => new Promise(() => {});
    client.disconnect = async () => {};
    h.clients.push(client);
    return client;
  };
  h.listener.start("creator");
  h.fireTimer(25_000);
  assert.equal(h.statuses.at(-1).state, "reconnecting");
  h.fireTimer(2_000);
  assert.equal(h.clients.length, 2);
  h.listener.stop();
});

test("stops and alerts when gifts cannot be saved", async () => {
  const h = harness({ saveGift: async () => { throw new Error("disk full"); } });
  h.listener.start("creator");
  await h.settle();
  h.clients[0].emit("gift", { id: "gift" });
  await h.settle();
  assert.equal(h.statuses.at(-1).state, "error");
  assert.match(h.statuses.at(-1).detail, /Could not save a TikTok gift/);
  assert.equal(h.timers.size, 0);
});

test("stops and alerts when the host ends the stream", async () => {
  const h = harness();
  h.listener.start("creator");
  await h.settle();
  h.clients[0].emit("streamEnd", {});
  assert.equal(h.statuses.at(-1).state, "error");
  assert.match(h.statuses.at(-1).detail, /LIVE ended/);
  assert.equal(h.timers.size, 0);
});

test("respects the signing service retry-after header", () => {
  const error = new SignatureRateLimitError(null, "Rate limited", { headers: { "retry-after": "600" } });
  assert.equal(connectionFailure(error).delayMs, 600_000);
});

test("waits out a saved signing cooldown before creating a client", async () => {
  const retryAt = Date.now() + 600_000;
  const h = harness({ getCooldownUntil: () => retryAt });
  h.listener.start("creator");
  assert.equal(h.clients.length, 0);
  assert.equal(h.statuses.at(-1).state, "reconnecting");
  assert.match(h.statuses.at(-1).detail, /rate limit/);
  assert.equal(h.timers.size, 1);
  h.listener.stop();
});

test("records a signing cooldown when the provider rate limits a connection", async () => {
  let retryAt = 0;
  const h = harness({ onRateLimit: until => { retryAt = until; } });
  h.listener.createClient = () => {
    const client = new EventEmitter();
    client.connect = async () => { throw new SignatureRateLimitError(null, "Rate limited", { headers: { "retry-after": "600" } }); };
    client.disconnect = async () => {};
    h.clients.push(client);
    return client;
  };
  h.listener.start("creator");
  await h.settle();
  assert.ok(retryAt >= Date.now() + 590_000);
  assert.equal(h.statuses.at(-1).state, "reconnecting");
  h.listener.stop();
});

test("a changed API key invalidates the connector's cached signing client", () => {
  const oldKey = SignConfig.apiKey;
  const oldClient = SignConfig.cachedInstance;
  try {
    SignConfig.cachedInstance = { stale: true };
    configureSigningKey("new-key");
    assert.equal(SignConfig.apiKey, "new-key");
    assert.equal(SignConfig.cachedInstance, undefined);
  } finally {
    SignConfig.apiKey = oldKey;
    SignConfig.cachedInstance = oldClient;
  }
});
