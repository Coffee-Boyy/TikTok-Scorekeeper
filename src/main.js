import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, session, shell } from "electron";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { TikTokLiveConnection } from "tiktok-live-connector";
import { extractRecipient, jsonSafe, normalizeGift } from "./gifts.js";
import { extractLinkEventRoster, extractPageBootstrap, extractRoomRoster } from "./guests.js";
import { ShowStore } from "./store.js";
import { GiftConnection, configureSigningKey } from "./gift-connection.js";
import { loadEulerApiKey, saveEulerApiKey } from "./euler-key.js";
import { loadSigningCooldown, saveSigningCooldown, signingIdentity } from "./signing-cooldown.js";
import { DEFAULT_SETTINGS, formatRanking, publicSettings, shouldPlayGiftSound, validateEulerApiKeyChange, validateSettingsPatch } from "./settings.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const PORT = 17342;
let window;
let connection;
let store;
let connectionStatus = { state: "disconnected", detail: "Not connected" };
let discoveryWindow;
let discoveryUsername = "";
let discoveryHost = { userId: "", handle: "" };
let discoveryStatus = { state: "idle", detail: "Authenticated guest discovery has not started" };
let discoveryClosingIntentionally = false;
let discoveryAttentionTimer;
let discoveryRetryTimer;
let discoveryAttempt = 0;
let discoveryHadSnapshot = false;
let discoveryHasBootstrap = false;
let discoveryLoginRequested = false;
let discoveryLastError = "";
let discoveryRetryCount = 0;
let rosterRefreshTimer;
let rosterRefreshInProgress = false;
let playbackHandoffTimer;
let loginWatcher;
let settings = { ...DEFAULT_SETTINGS };
let eulerApiKey = "";
let eulerApiKeyError = "";
let signingCooldownUntil = 0;
const missedGiftIds = new Set();
const roomCaptureRequests = new Map();
const overlayClients = new Set();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

function assertTrusted(event) {
  const senderUrl = event.senderFrame?.url || "";
  if (!senderUrl.startsWith("file://")) throw new Error("Untrusted IPC sender");
}

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const eulerApiKeyPath = () => path.join(app.getPath("userData"), "euler-api-key.bin");
const signingCooldownPath = () => path.join(app.getPath("userData"), "signing-cooldown.json");
const activeSigningIdentity = () => signingIdentity(eulerApiKey || process.env.SIGN_API_KEY || "");

function setSigningCooldown(retryAt) {
  signingCooldownUntil = retryAt;
  try {
    saveSigningCooldown(signingCooldownPath(), activeSigningIdentity(), retryAt);
  } catch (error) {
    console.error("Could not persist signing cooldown", error);
    if (retryAt) dialog.showErrorBox("Signing cooldown could not be saved", "Avoid restarting the app until the signing service retry time has passed, or it may consume another signing request.");
  }
}

async function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(await readFile(settingsPath(), "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read settings", error);
  }
}

async function saveSettings(next = settings) {
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), "utf8");
}

async function loadSigningKey() {
  try {
    eulerApiKey = await loadEulerApiKey(eulerApiKeyPath(), safeStorage);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Could not unlock Euler Stream API key", error);
      eulerApiKeyError = "Saved Euler Stream API key could not be unlocked. Enter it again.";
    }
  }
  configureSigningKey(eulerApiKey);
  signingCooldownUntil = loadSigningCooldown(signingCooldownPath(), activeSigningIdentity());
}

function broadcastOverlay() {
  const payload = JSON.stringify({ type: "snapshot", ...store.snapshot() });
  for (const client of overlayClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function sendState() {
  const snapshot = store.snapshot();
  const currentGiftIds = new Set(snapshot.show.gifts.map(gift => gift.id));
  for (const id of missedGiftIds) if (!currentGiftIds.has(id)) missedGiftIds.delete(id);
  const payload = {
    ...snapshot,
    connection: connectionStatus,
    discovery: discoveryStatus,
    missedGiftIds: [...missedGiftIds],
    settings: {
      ...publicSettings(settings),
      eulerApiKeySource: eulerApiKey ? "saved" : process.env.SIGN_API_KEY ? "environment" : "none",
      eulerApiKeyError
    },
    overlayUrl: `http://127.0.0.1:${PORT}/overlay`
  };
  window?.webContents.send("state:changed", payload);
  broadcastOverlay();
  return payload;
}

function setDiscoveryStatus(state, detail) {
  discoveryStatus = { state, detail };
  sendState();
}

async function mergeRoster(roster, sourceLabel) {
  if (roster.host?.userId || roster.host?.handle) {
    discoveryHost = {
      userId: roster.host.userId || discoveryHost.userId,
      handle: roster.host.handle || discoveryHost.handle || discoveryUsername
    };
    await store.updateHost({
      userId: roster.host.userId,
      handle: roster.host.handle || discoveryUsername,
      name: roster.host.name,
      source: roster.host.source || sourceLabel
    });
  }
  const result = await store.upsertDiscoveredParticipants(roster.guests || []);
  const count = roster.guests?.length || 0;
  const changes = result.added ? ` · ${result.added} added` : result.updated ? ` · ${result.updated} refreshed` : "";
  setDiscoveryStatus("ready", `${sourceLabel}: ${count} guest${count === 1 ? "" : "s"} found${changes}`);
  return result;
}

async function mergeLinkEvent(raw, eventName) {
  const users = extractLinkEventRoster(jsonSafe(raw), discoveryHost.userId, discoveryHost.handle || discoveryUsername);
  if (!users.length) return;
  const result = await store.upsertDiscoveredParticipants(users);
  setDiscoveryStatus("live", `${eventName}: ${users.length} linked user${users.length === 1 ? "" : "s"} · ${result.added} added`);
}

async function ingestGift(rawGift) {
  const safeRaw = jsonSafe(rawGift);
  const recipient = extractRecipient(safeRaw);
  if ((recipient.userId && recipient.userId !== "0") || recipient.name) {
    await store.upsertDiscoveredParticipants([{
      userId: recipient.userId === "0" ? "" : recipient.userId,
      name: recipient.name,
      source: "gift-recipient"
    }]);
  }
  const normalized = normalizeGift(safeRaw, store.show.participants);
  const alreadyCompleted = normalized.sourceMessageId && store.show.gifts.some(event =>
    event.sourceMessageId === normalized.sourceMessageId && event.scoreable);
  await store.recordGift(normalized, safeRaw);
  if (!window?.isVisible() || !window.isFocused()) missedGiftIds.add(normalized.id);
  if (shouldPlayGiftSound(normalized, settings, alreadyCompleted)) {
    window?.webContents.send("gift:sound", settings.giftSound);
  }
  sendState();
}

const giftListener = new GiftConnection({
  shouldReconnect: () => settings.autoReconnect,
  getCooldownUntil: () => signingCooldownUntil,
  onRateLimit: setSigningCooldown,
  onConnected: () => setSigningCooldown(0),
  onStatus: (state, detail) => setStatus(state, detail),
  onRoom: (roomId, username) => store.beginStreamSession({ roomId, hostUsername: username }),
  onGift: ingestGift,
  onLink: data => mergeLinkEvent(data, "Live guest update"),
  onLinkError: () => setDiscoveryStatus("error", "A live guest update failed. Existing guests remain; use Refresh guests to reconcile the roster."),
  onRecovered: () => refreshGuestRoster(discoveryAttempt),
  onFatal: () => {
    connection = undefined;
    discoveryAttempt++;
    if (!discoveryHadSnapshot) setDiscoveryStatus("error", "Guest discovery stopped. Resolve the gift connection error, then connect again.");
    closeReceiverAfterRoster();
  }
});

function closeReceiverAfterRoster() {
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  clearInterval(rosterRefreshTimer);
  clearInterval(playbackHandoffTimer);
  clearInterval(loginWatcher);
  if (discoveryWindow && !discoveryWindow.isDestroyed()) {
    discoveryClosingIntentionally = true;
    discoveryWindow.close();
  }
}

function parseRoomBody(body) {
  // TikTok emits some 64-bit IDs as bare JSON numbers. Quote them before parsing
  // so JavaScript does not silently round IDs used for gift attribution.
  const safeBody = body.replace(/("(?:[A-Za-z0-9_]*_id|id)"\s*:\s*)(\d{16,})/g, '$1"$2"');
  return JSON.parse(safeBody);
}

async function applyRoomBody(body) {
  if (!body) throw new Error("TikTok returned an empty room response");
  const payload = parseRoomBody(body);
  const room = payload?.data?.data || payload?.data || payload?.room;
  if (!room || typeof room !== "object" || (!room.owner && !room.id && !room.room && !room.group_live_session && !room.groupLiveSession)) {
    throw new Error("TikTok did not return an authenticated LIVE room snapshot");
  }
  const roomId = String(room.id_str || room.id || room.room_id || room.roomId || "");
  await store.beginStreamSession({ roomId, hostUsername: discoveryUsername });
  const roster = extractRoomRoster(payload, discoveryUsername);
  if (roster.guests.length) {
    await mergeRoster(roster, "Authenticated room snapshot");
    discoveryHadSnapshot = true;
    clearTimeout(discoveryAttentionTimer);
    clearTimeout(discoveryRetryTimer);
    closeReceiverAfterRoster();
  }
  discoveryLastError = "";
}

async function refreshGuestRoster(attempt) {
  if (attempt !== discoveryAttempt || !store.show.streamSessionId || rosterRefreshInProgress) return;
  rosterRefreshInProgress = true;
  try {
    const roomId = store.show.streamSessionId;
    const endpoints = [
      ["Room info", `/webcast/room/info/?aid=1988&room_id=${encodeURIComponent(roomId)}`],
      ["Multi-guest roster", `/webcast/linkmic_multi_guest/webapp/audience_room_enter_backup/?aid=1988&app_id=1988&live_id=12&room_id=${encodeURIComponent(roomId)}`]
    ];
    for (const [label, pathname] of endpoints) {
      try {
        const response = await fetch(`https://webcast.us.tiktok.com${pathname}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000)
        });
        if (!response.ok) continue;
        const payload = parseRoomBody(await response.text());
        if (payload.status_code !== 0) continue;
        const roster = extractRoomRoster(payload, discoveryUsername);
        if (attempt !== discoveryAttempt) return;
        if (roster.guests.length) {
          await mergeRoster(roster, label);
          discoveryHadSnapshot = true;
          closeReceiverAfterRoster();
          break;
        }
      } catch (error) {
        discoveryLastError = `${label}: ${error.message}`;
      }
    }
  } finally {
    rosterRefreshInProgress = false;
  }
}

function installRoomCapture() {
  const receiverSession = session.fromPartition("persist:tiktok-scorekeeper-auth");
  const filter = { urls: ["https://webcast.us.tiktok.com/webcast/room/enter/*"] };
  receiverSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    roomCaptureRequests.set(details.id, {
      url: details.url,
      method: details.method,
      body: Buffer.concat((details.uploadData || []).filter(item => item.bytes).map(item => item.bytes)),
      attempt: discoveryAttempt
    });
    callback({});
  });
  receiverSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const request = roomCaptureRequests.get(details.id);
    if (request) request.headers = details.requestHeaders;
    callback({ requestHeaders: details.requestHeaders });
  });
  const finish = details => {
    const request = roomCaptureRequests.get(details.id);
    if (!request) return;
    roomCaptureRequests.delete(details.id);
    if (request.attempt !== discoveryAttempt || details.statusCode !== 200 || details.error && details.error !== "net::OK") return;
    void (async () => {
      const cookies = await receiverSession.cookies.get({ url: request.url });
      const headers = Object.fromEntries(Object.entries(request.headers || {}).filter(([name]) =>
        !/^(host|content-length|cookie|sec-fetch-)/i.test(name)));
      headers.Cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
      const response = await fetch(request.url, {
        method: request.method,
        headers,
        body: request.body,
        signal: AbortSignal.timeout(15_000)
      });
      const body = await response.text();
      if (request.attempt !== discoveryAttempt || !response.ok || !body) return;
      await applyRoomBody(body);
    })().catch(error => { discoveryLastError = error.message; console.error("room capture error", error.message); });
  };
  receiverSession.webRequest.onCompleted(filter, finish);
  receiverSession.webRequest.onErrorOccurred(filter, finish);
}

async function capturePageBootstrap() {
  if (discoveryHadSnapshot || discoveryLoginRequested || !discoveryWindow || discoveryWindow.isDestroyed()) return false;
  let state;
  try {
    state = await discoveryWindow.webContents.executeJavaScript(`(() => {
      try {
        const parsed = JSON.parse(document.getElementById('SIGI_STATE')?.textContent || '{}');
        return parsed.LiveRoom?.liveRoomUserInfo || null;
      } catch { return null; }
    })()`, true);
  } catch {
    return false;
  }
  const bootstrap = extractPageBootstrap(state, discoveryUsername);
  if (!bootstrap || discoveryHadSnapshot || discoveryLoginRequested) return false;
  await store.beginStreamSession({
    roomId: bootstrap.roomId,
    streamId: bootstrap.streamId,
    hostUsername: discoveryUsername
  });
  discoveryHost = { userId: bootstrap.host.userId, handle: bootstrap.host.handle };
  await store.updateHost({
    userId: bootstrap.host.userId,
    handle: bootstrap.host.handle,
    name: bootstrap.host.name,
    source: bootstrap.host.source
  });
  discoveryHasBootstrap = true;
  setDiscoveryStatus("capturing", "LIVE found · waiting for guest roster…");
  discoveryLastError = "";
  showLiveReceiver();
  clearInterval(rosterRefreshTimer);
  void refreshGuestRoster(discoveryAttempt);
  rosterRefreshTimer = setInterval(() => void refreshGuestRoster(discoveryAttempt), 12_000);
  return true;
}

function showLoginPage(detail) {
  if (!discoveryWindow || discoveryWindow.isDestroyed() || discoveryClosingIntentionally) return;
  setDiscoveryStatus("waiting", detail);
  discoveryWindow.setOpacity(1);
  discoveryWindow.setIgnoreMouseEvents(false);
  discoveryWindow.show();
  discoveryWindow.focus();
}

function showLiveReceiver() {
  if (!discoveryWindow || discoveryWindow.isDestroyed()) return;
  discoveryWindow.setOpacity(1);
  discoveryWindow.setIgnoreMouseEvents(false);
  discoveryWindow.show();
}

async function acceptComputerPlayback() {
  if (!discoveryWindow || discoveryWindow.isDestroyed()) return false;
  try {
    return await discoveryWindow.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .find(element => /watch on this computer/i.test(element.textContent?.trim() || ''));
      if (!button) return false;
      button.click();
      return true;
    })()`, true);
  } catch {
    return false;
  }
}

async function navigateTikTok(url) {
  try {
    await discoveryWindow.loadURL(url);
  } catch (error) {
    const currentUrl = discoveryWindow?.webContents.getURL() || "";
    const transient = ["ERR_ABORTED", "ERR_FAILED"].includes(error?.code);
    if (!transient || !currentUrl.startsWith("https://www.tiktok.com/")) throw error;
  }
}

async function pageNeedsLogin() {
  if (!discoveryWindow || discoveryWindow.isDestroyed()) return false;
  const currentUrl = discoveryWindow.webContents.getURL();
  if (/tiktok\.com\/(?:login|signup)/i.test(currentUrl)) return true;
  try {
    return await discoveryWindow.webContents.executeJavaScript(`Boolean(
      document.querySelector('input[name="username"], input[type="password"], [data-e2e="login-modal"]') &&
      /log in|sign in/i.test(document.body?.innerText || '')
    )`, true);
  } catch {
    return false;
  }
}

function watchForLogin(targetUrl, attempt) {
  clearInterval(loginWatcher);
  loginWatcher = setInterval(() => {
    if (attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) {
      clearInterval(loginWatcher);
      return;
    }
    pageNeedsLogin().then(async needsLogin => {
      if (needsLogin || attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) return;
      clearInterval(loginWatcher);
      discoveryLoginRequested = false;
      showLiveReceiver();
      setDiscoveryStatus("capturing", `Signed in. Reading @${discoveryUsername}'s LIVE…`);
      await loadLivePage(targetUrl, attempt, 0);
    }).catch(error => {
      discoveryLastError = error.message;
    });
  }, 1000);
}

async function openLogin(targetUrl, attempt) {
  if (attempt !== discoveryAttempt || discoveryLoginRequested || !discoveryWindow || discoveryWindow.isDestroyed()) return;
  discoveryLoginRequested = true;
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  showLoginPage(`Sign in to TikTok; @${discoveryUsername}'s LIVE will connect automatically`);
  watchForLogin(targetUrl, attempt);
  const loginUrl = `https://www.tiktok.com/login?lang=en&redirectPath=${encodeURIComponent(targetUrl)}`;
  try {
    await navigateTikTok(loginUrl);
  } catch (error) {
    discoveryLastError = error.message;
    clearInterval(loginWatcher);
    setDiscoveryStatus("error", "TikTok's login page could not be loaded. Use Refresh guests to retry.");
    closeReceiverAfterRoster();
  }
}

async function finishLiveAttempt(targetUrl, attempt, retry) {
  if (attempt !== discoveryAttempt || discoveryHadSnapshot || discoveryLoginRequested || !discoveryWindow || discoveryWindow.isDestroyed()) return;
  if (!discoveryHasBootstrap && await pageNeedsLogin()) {
    await openLogin(targetUrl, attempt);
    return;
  }
  if (retry < 1) {
    setDiscoveryStatus("capturing", `Retrying @${discoveryUsername}'s LIVE roster…`);
    discoveryWindow.webContents.reloadIgnoringCache();
    discoveryAttentionTimer = setTimeout(() => {
      void finishLiveAttempt(targetUrl, attempt, retry + 1);
    }, 10_000);
    return;
  }

  discoveryRetryCount++;
  if (discoveryRetryCount >= 5) {
    setDiscoveryStatus("error", "Guest roster unavailable after repeated attempts. Gift tracking continues; use Refresh guests or Sign in to retry.");
    closeReceiverAfterRoster();
    return;
  }

  if (discoveryHasBootstrap) {
    setDiscoveryStatus("live", "LIVE active · room roster unavailable; retrying guest discovery");
    discoveryWindow.hide();
    discoveryRetryTimer = setTimeout(() => {
      if (attempt === discoveryAttempt) void loadLivePage(targetUrl, attempt, 0);
    }, 20_000);
    return;
  }

  let pageText = "";
  try {
    pageText = await discoveryWindow.webContents.executeJavaScript("document.body?.innerText || ''", true);
  } catch {}
  const offline = /live has ended|isn't live|is not live|currently offline/i.test(pageText);
  if (offline) {
    setDiscoveryStatus("error", `@${discoveryUsername} is not currently LIVE`);
    closeReceiverAfterRoster();
    return;
  } else {
    const suffix = discoveryLastError ? ` (${discoveryLastError})` : "";
    setDiscoveryStatus("error", `TikTok did not finish loading the LIVE. Retrying automatically…${suffix}`);
  }
  discoveryWindow.hide();
  discoveryRetryTimer = setTimeout(() => {
    if (attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) return;
    showLiveReceiver();
    void loadLivePage(targetUrl, attempt, 0);
  }, 20_000);
}

async function loadLivePage(targetUrl, attempt, retry) {
  if (attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) return;
  showLiveReceiver();
  try {
    await navigateTikTok(targetUrl);
    clearInterval(playbackHandoffTimer);
    await acceptComputerPlayback();
    playbackHandoffTimer = setInterval(() => void acceptComputerPlayback(), 2_000);
    if (discoveryLoginRequested) return;
    await capturePageBootstrap();
  } catch (error) {
    discoveryLastError = error.message;
  }
  clearTimeout(discoveryAttentionTimer);
  discoveryAttentionTimer = setTimeout(() => {
    void finishLiveAttempt(targetUrl, attempt, retry);
  }, retry ? 10_000 : 8_000);
}

async function discoverGuests(username) {
  const cleanUsername = String(username || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{2,32}$/.test(cleanUsername)) throw new Error("Enter a valid TikTok username.");
  discoveryUsername = cleanUsername;
  discoveryHost.handle = cleanUsername;
  const attempt = ++discoveryAttempt;
  discoveryHadSnapshot = false;
  discoveryHasBootstrap = false;
  discoveryLoginRequested = false;
  discoveryLastError = "";
  discoveryRetryCount = 0;
  roomCaptureRequests.clear();
  clearInterval(rosterRefreshTimer);
  clearInterval(playbackHandoffTimer);
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  clearInterval(loginWatcher);

  if (!discoveryWindow || discoveryWindow.isDestroyed()) {
    discoveryWindow = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1060,
      height: 780,
      minWidth: 760,
      minHeight: 560,
      title: "TikTok sign-in",
      backgroundColor: "#000000",
      webPreferences: {
        partition: "persist:tiktok-scorekeeper-auth",
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    discoveryWindow.removeMenu();
    discoveryWindow.webContents.setAudioMuted(true);
    discoveryWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    discoveryWindow.on("closed", () => {
      const unexpectedClose = !discoveryClosingIntentionally;
      discoveryClosingIntentionally = false;
      clearTimeout(discoveryAttentionTimer);
      clearTimeout(discoveryRetryTimer);
      clearInterval(rosterRefreshTimer);
      clearInterval(playbackHandoffTimer);
      clearInterval(loginWatcher);
      discoveryWindow = undefined;
      if (unexpectedClose && connection) {
        setDiscoveryStatus("error", "Guest discovery window closed. Gift listening continues; use Refresh guests to retry.");
      }
    });
  }

  discoveryClosingIntentionally = false;
  try {
    const targetUrl = `https://www.tiktok.com/@${encodeURIComponent(cleanUsername)}/live`;
    setDiscoveryStatus("capturing", `Reading @${cleanUsername}'s LIVE…`);
    await loadLivePage(targetUrl, attempt, 0);
  } catch (error) {
    discoveryLastError = error.message;
    setDiscoveryStatus("error", `TikTok connection setup failed: ${error.message}`);
  }
  return sendState();
}

function setStatus(state, detail) {
  connectionStatus = { state, detail };
  sendState();
}

async function connect(username) {
  const cleanUsername = String(username || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{2,32}$/.test(cleanUsername)) throw new Error("Enter a valid TikTok username.");

  giftListener.stop();
  setStatus("connecting", `Connecting to @${cleanUsername}…`);
  connection = { username: cleanUsername };
  giftListener.start(cleanUsername);
  settings.lastUsername = cleanUsername;
  await saveSettings();
  await discoverGuests(cleanUsername);
  return sendState();
}

async function startOverlayServer() {
  const overlayHtml = await readFile(path.join(directory, "overlay.html"));
  const server = createServer((request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/overlay") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws://127.0.0.1:${PORT}`
    });
    response.end(overlayHtml);
  });
  const webSockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname !== "/events") return socket.destroy();
    webSockets.handleUpgrade(request, socket, head, client => webSockets.emit("connection", client));
  });
  webSockets.on("connection", client => {
    overlayClients.add(client);
    client.send(JSON.stringify({ type: "snapshot", ...store.snapshot() }));
    client.on("close", () => overlayClients.delete(client));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", resolve);
  });
}

function registerIpc() {
  ipcMain.handle("app:state", event => { assertTrusted(event); return sendState(); });
  ipcMain.handle("gift:assign", async (event, giftId, participantId) => { assertTrusted(event); await store.assignGift(giftId, participantId); return sendState(); });
  ipcMain.handle("gift:assign-many", async (event, giftIds, participantId) => { assertTrusted(event); await store.assignGifts(giftIds, participantId); return sendState(); });
  ipcMain.handle("gift:clear-missed", event => { assertTrusted(event); missedGiftIds.clear(); return sendState(); });
  ipcMain.handle("show:reset-scores", async event => { assertTrusted(event); await store.resetScores(); missedGiftIds.clear(); return sendState(); });
  ipcMain.handle("help:euler-key", event => { assertTrusted(event); return shell.openExternal("https://www.eulerstream.com/docs/api/quickstart"); });
  ipcMain.handle("help:euler-pricing", event => { assertTrusted(event); return shell.openExternal("https://www.eulerstream.com/pricing"); });
  ipcMain.handle("dancer:set", async (event, participantId) => { assertTrusted(event); await store.setActiveDancer(participantId); return sendState(); });
  ipcMain.handle("rules:set", async (event, giftName, participantId) => {
    assertTrusted(event);
    const participant = store.show.participants.find(item => item.id === participantId);
    await store.setRoutingRule(giftName, participant);
    return sendState();
  });
  ipcMain.handle("rules:delete", async (event, giftName) => {
    assertTrusted(event);
    await store.removeRoutingRule(giftName);
    return sendState();
  });
  ipcMain.handle("stream:connect", async (event, username) => { assertTrusted(event); return connect(username); });
  ipcMain.handle("stream:discover", async (event, username) => { assertTrusted(event); return discoverGuests(username); });
  ipcMain.handle("stream:disconnect", async event => {
    assertTrusted(event);
    connection = undefined;
    giftListener.stop();
    discoveryAttempt++;
    clearTimeout(discoveryAttentionTimer);
    clearTimeout(discoveryRetryTimer);
    clearInterval(rosterRefreshTimer);
    clearInterval(playbackHandoffTimer);
    clearInterval(loginWatcher);
    settings.lastUsername = "";
    await saveSettings();
    if (discoveryWindow && !discoveryWindow.isDestroyed()) {
      discoveryClosingIntentionally = true;
      discoveryWindow.close();
    }
    setStatus("disconnected", "Disconnected");
    return sendState();
  });
  ipcMain.handle("settings:autoconnect", async event => {
    assertTrusted(event);
    settings.autoConnect = !settings.autoConnect;
    await saveSettings();
    return sendState();
  });
  ipcMain.handle("settings:update", async (event, patch) => {
    assertTrusted(event);
    const { eulerApiKey: keyInput, removeEulerApiKey, ...preferences } = patch || {};
    const keyChange = validateEulerApiKeyChange(keyInput, removeEulerApiKey);
    const next = { ...settings, ...validateSettingsPatch(preferences) };
    if (keyChange.action !== "keep") {
      const key = keyChange.action === "save" ? keyChange.key : "";
      await saveEulerApiKey(eulerApiKeyPath(), key, safeStorage);
      eulerApiKey = key;
      eulerApiKeyError = "";
      configureSigningKey(key);
      setSigningCooldown(0);
    }
    await saveSettings(next);
    settings = next;
    if (keyChange.action !== "keep" && connection?.username && ["connecting", "reconnecting"].includes(connectionStatus.state)) {
      giftListener.start(connection.username);
    }
    return sendState();
  });
  ipcMain.handle("settings:preview-ranking", (event, patch) => {
    assertTrusted(event);
    return formatRanking(store.snapshot().scores, { ...settings, ...validateSettingsPatch(patch) });
  });
  ipcMain.handle("ranking:copy", event => {
    assertTrusted(event);
    const scores = store.snapshot().scores;
    if (!scores.some(score => score.participant?.role === "guest")) throw new Error("No guests to include in the ranking yet.");
    const comment = formatRanking(scores, settings);
    clipboard.writeText(comment);
    return comment;
  });
  ipcMain.handle("overlay:copy", event => {
    assertTrusted(event);
    const url = `http://127.0.0.1:${PORT}/overlay`;
    clipboard.writeText(url);
    return url;
  });
  ipcMain.handle("show:export", async event => {
    assertTrusted(event);
    const suggested = `${store.show.title.replace(/[^a-z0-9_-]+/gi, "-") || "show"}-gifts.csv`;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: suggested,
      filters: [{ name: "CSV", extensions: ["csv"] }]
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, store.csv(), "utf8");
    return result.filePath;
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0a0d13",
    titleBarStyle: "hidden",
    // Keep native controls; CSS titlebar-area variables reserve their actual position.
    titleBarOverlay: { color: "#0c1017", symbolColor: "#e8eaf0", height: 53 },
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });
  window.removeMenu();
  window.loadFile(path.join(directory, "index.html"));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", event => event.preventDefault());
  window.on("focus", sendState);
}

if (hasSingleInstanceLock) {
app.whenReady().then(async () => {
  await loadSettings();
  await loadSigningKey();
  store = new ShowStore(path.join(app.getPath("userData"), "shows"));
  await store.initialize();
  await startOverlayServer();
    registerIpc();
    createWindow();
    installRoomCapture();
    if (settings.autoConnect && settings.lastUsername) {
    setTimeout(() => connect(settings.lastUsername).catch(() => {}), 800);
  }
}).catch(error => {
    console.error("Startup failed", error);
    dialog.showErrorBox("TikTok LIVE Scorekeeper could not start", error.message || String(error));
    app.quit();
  });
}

app.on("before-quit", () => {
  discoveryClosingIntentionally = true;
  giftListener.stop();
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  clearInterval(rosterRefreshTimer);
  clearInterval(playbackHandoffTimer);
  clearInterval(loginWatcher);
});
app.on("window-all-closed", () => app.quit());
