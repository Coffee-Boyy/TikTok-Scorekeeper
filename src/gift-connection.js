import {
  AuthenticatedWebSocketConnectionError,
  InvalidUniqueIdError,
  PremiumFeatureError,
  SignatureRateLimitError,
  TikTokLiveConnection,
  UserOfflineError
} from "tiktok-live-connector";

const CONNECT_TIMEOUT_MS = 25_000;
const MAX_RETRY_MS = 60_000;

export function connectionFailure(error) {
  if (error instanceof UserOfflineError) return { fatal: true, detail: "The host is no longer LIVE. Connect again when the next stream starts." };
  if (error instanceof InvalidUniqueIdError) return { fatal: true, detail: "TikTok rejected this username. Check it and connect again." };
  if (error instanceof PremiumFeatureError || error instanceof AuthenticatedWebSocketConnectionError) {
    return { fatal: true, detail: "The gift connection requires a different signing configuration. Update the app or connection settings." };
  }
  if (error instanceof SignatureRateLimitError) {
    return { fatal: false, delayMs: Math.max(5_000, Number(error.retryAfter) || 0), reason: "Signing service rate limit" };
  }
  return { fatal: false, reason: "Gift connection dropped" };
}

export class GiftConnection {
  constructor({ onStatus, onRoom, onGift, onLink, onLinkError, onFatal, onRecovered, createClient = username => new TikTokLiveConnection(username, {
    processInitialData: false,
    fetchRoomInfoOnConnect: false,
    authenticateWs: false
  }), setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.onStatus = onStatus;
    this.onRoom = onRoom;
    this.onGift = onGift;
    this.onLink = onLink;
    this.onLinkError = onLinkError;
    this.onFatal = onFatal;
    this.onRecovered = onRecovered;
    this.createClient = createClient;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.generation = 0;
    this.attempt = 0;
    this.everConnected = false;
  }

  start(username) {
    this.stop();
    this.username = username;
    this.attempt = 0;
    this.everConnected = false;
    this.onStatus("connecting", `Connecting gift listener to @${username}…`);
    this.connect();
  }

  stop() {
    this.generation++;
    this.username = "";
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.connectTimer);
    this.retryTimer = undefined;
    this.connectTimer = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) void client.disconnect().catch(error => console.error("Gift listener shutdown failed", error));
  }

  isCurrent(client, generation) {
    return this.client === client && this.generation === generation && Boolean(this.username);
  }

  fatal(detail) {
    if (!this.username) return;
    this.stop();
    this.onStatus("error", detail);
    this.onFatal?.(detail);
  }

  retry(error, client, generation) {
    if (!this.isCurrent(client, generation) || this.retryTimer) return;
    const failure = connectionFailure(error);
    if (failure.fatal) return this.fatal(failure.detail);
    this.clearTimer(this.connectTimer);
    this.client = undefined;
    void client.disconnect().catch(() => {});
    const backoff = Math.min(MAX_RETRY_MS, 2_000 * 2 ** Math.min(this.attempt++, 5));
    const delay = Math.min(2_147_483_647, Math.max(backoff, failure.delayMs || 0));
    const reason = failure.reason === "Gift connection dropped" && !this.everConnected ? "Gift connection failed" : failure.reason;
    const detail = `${this.attempt >= 5 ? "Still unable to connect. " : ""}${reason}. Reconnecting in ${Math.ceil(delay / 1000)}s (attempt ${this.attempt}). Gifts during the outage may be missed.`;
    this.onStatus("reconnecting", detail);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  connect() {
    if (!this.username) return;
    const generation = this.generation;
    let client;
    try {
      client = this.createClient(this.username);
    } catch (error) {
      return this.fatal(`Could not initialize gift listener: ${error.message}`);
    }
    this.client = client;
    let ready = false;
    const pendingGifts = [];
    let giftQueue = Promise.resolve();
    const enqueueGift = gift => {
      giftQueue = giftQueue.then(() => this.isCurrent(client, generation) ? this.onGift(gift) : undefined)
        .catch(error => {
          if (!this.isCurrent(client, generation)) return;
          console.error("Could not save TikTok gift", error);
          this.fatal("Could not save a TikTok gift. Check disk space and app data access, then connect again. Gift tracking has stopped.");
        });
    };
    client.on("gift", gift => {
      if (!this.isCurrent(client, generation)) return;
      if (ready) enqueueGift(gift);
      else pendingGifts.push(gift);
    });
    client.on("decodedData", (_event, decoded) => {
      if (!this.isCurrent(client, generation) || !/Link|Battle|Group/i.test(decoded?.type || "")) return;
      void Promise.resolve().then(() => this.onLink(decoded.data)).catch(error => {
        if (!this.isCurrent(client, generation)) return;
        console.error("Could not update LIVE guests", error);
        this.onLinkError?.(error);
      });
    });
    client.on("streamEnd", () => {
      if (this.isCurrent(client, generation)) this.fatal("The host's LIVE ended. Connect again when the next stream starts.");
    });
    client.on("disconnected", ({ code, reason } = {}) => {
      this.retry(new Error(`WebSocket closed (${code || "unknown"}${reason ? `: ${reason}` : ""})`), client, generation);
    });
    client.on("error", ({ info, exception } = {}) => {
      const error = exception || new Error(info || "Unknown TikTok connection error");
      console.error("Gift listener error", info || "", error);
      if (ready) this.retry(error, client, generation);
    });
    this.connectTimer = this.setTimer(() => this.retry(new Error("Gift connection timed out"), client, generation), CONNECT_TIMEOUT_MS);
    void Promise.resolve().then(() => client.connect()).then(async state => {
      if (!this.isCurrent(client, generation)) return void client.disconnect().catch(() => {});
      this.clearTimer(this.connectTimer);
      this.connectTimer = undefined;
      const roomId = String(state.roomId || "");
      if (!roomId) return this.fatal("TikTok connected without a room ID. Gift tracking has stopped; connect again.");
      try {
        await this.onRoom(roomId, this.username);
      } catch (error) {
        console.error("Could not initialize stream session", error);
        return this.fatal("Could not save the stream session. Check disk space and app data access, then connect again.");
      }
      if (!this.isCurrent(client, generation)) return;
      ready = true;
      for (const gift of pendingGifts) enqueueGift(gift);
      pendingGifts.length = 0;
      const recovered = this.everConnected;
      this.everConnected = true;
      this.attempt = 0;
      this.onStatus("connected", recovered ? "Gift connection restored. Events during the outage may have been missed." : "Gift listener active");
      if (recovered) void Promise.resolve().then(() => this.onRecovered?.()).catch(error => console.error("Could not refresh guests after reconnect", error));
    }).catch(error => this.retry(error, client, generation));
  }
}
