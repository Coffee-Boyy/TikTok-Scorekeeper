import { app, BrowserWindow, clipboard, dialog, ipcMain, session } from "electron";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { deserializeWebSocketMessage } from "tiktok-live-connector";
import { extractRecipient, jsonSafe, normalizeGift } from "./gifts.js";
import { extractLinkEventRoster, extractPageBootstrap, extractRoomRoster } from "./guests.js";
import { ShowStore } from "./store.js";

app.commandLine.appendSwitch("remote-debugging-port", "0");

const directory = path.dirname(fileURLToPath(import.meta.url));
const PORT = 17342;
let window;
let connection;
let store;
let connectionStatus = { state: "disconnected", detail: "Not connected" };
let discoveryWindow;
let discoveryUsername = "";
let discoveryHost = { userId: "", handle: "" };
let discoveryStatus = { state: "idle", detail: "Authenticated guest discovery has not started" };
let discoveryDebuggerAttached = false;
let discoveryClosingIntentionally = false;
let discoveryAttentionTimer;
let discoveryRetryTimer;
let discoveryAttempt = 0;
let discoveryHadSnapshot = false;
let discoverySawSocket = false;
let discoveryLastError = "";
let loginWatcher;
let settings = { autoConnect: true, lastUsername: "" };
const pendingRoomResponses = new Set();
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

async function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(await readFile(settingsPath(), "utf8")) };
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read settings", error);
  }
}

async function saveSettings() {
  await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
}

function broadcastOverlay() {
  const payload = JSON.stringify({ type: "snapshot", ...store.snapshot() });
  for (const client of overlayClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function sendState() {
  const payload = {
    ...store.snapshot(),
    connection: connectionStatus,
    discovery: discoveryStatus,
    settings: { autoConnect: settings.autoConnect },
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
  await store.recordGift(normalized, safeRaw);
  sendState();
}

async function processBrowserWebSocketFrame(params) {
  if (params.response?.opcode !== 2 || !params.response.payloadData) return;
  let decoded;
  try {
    decoded = await deserializeWebSocketMessage(Buffer.from(params.response.payloadData, "base64"));
  } catch {
    return;
  }
  const messages = decoded.protoMessageFetchResult?.messages || [];
  if (messages.length && connectionStatus.state !== "connected") {
    setStatus("connected", "Active");
  }
  for (const message of messages) {
    const decodedData = message.decodedData;
    if (!decodedData?.data) continue;
    if (decodedData.type === "WebcastGiftMessage") {
      await ingestGift(decodedData.data);
    } else if (/Link|Battle/i.test(decodedData.type)) {
      await mergeLinkEvent(decodedData.data, "Live guest update");
    }
  }
}

async function captureRoomResponse(debuggerApi, requestId) {
  const response = await debuggerApi.sendCommand("Network.getResponseBody", { requestId });
  const body = response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body;
  // TikTok emits some 64-bit IDs as bare JSON numbers. Quote them before parsing
  // so JavaScript does not silently round IDs used for gift attribution.
  const safeBody = body.replace(/("(?:[A-Za-z0-9_]*_id|id)"\s*:\s*)(\d{16,})/g, '$1"$2"');
  const payload = JSON.parse(safeBody);
  const room = payload?.data?.data || payload?.data || payload?.room;
  if (!room || typeof room !== "object" || (!room.owner && !room.id && !room.room && !room.group_live_session && !room.groupLiveSession)) {
    throw new Error("TikTok did not return an authenticated LIVE room snapshot");
  }
  const roomId = String(room.id_str || room.id || room.room_id || room.roomId || "");
  await store.beginStreamSession({ roomId, hostUsername: discoveryUsername });
  const roster = extractRoomRoster(payload, discoveryUsername);
  await mergeRoster(roster, "Authenticated room snapshot");
  discoveryHadSnapshot = true;
  discoveryLastError = "";
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  if (discoveryWindow && !discoveryWindow.isDestroyed()) {
    discoveryWindow.setOpacity(0);
    discoveryWindow.setIgnoreMouseEvents(true);
    discoveryWindow.hide();
  }
}

async function capturePageBootstrap() {
  if (!discoveryWindow || discoveryWindow.isDestroyed()) return false;
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
  if (!bootstrap) return false;
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
  setDiscoveryStatus("ready", "Active · guest roster will update automatically");
  discoveryHadSnapshot = true;
  discoveryLastError = "";
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  setStatus("connected", "Active");
  discoveryWindow.setOpacity(0);
  discoveryWindow.setIgnoreMouseEvents(true);
  // Keep Chromium's page lifecycle active long enough for TikTok to create its
  // webcast worker. The window is fully transparent and absent from the taskbar.
  setTimeout(() => {
    if (discoveryWindow && !discoveryWindow.isDestroyed() && discoveryHadSnapshot) discoveryWindow.hide();
  }, 8_000);
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

async function attachDiscoveryDebugger(targetWindow) {
  const debuggerApi = targetWindow.webContents.debugger;
  if (discoveryDebuggerAttached && debuggerApi.isAttached()) return;
  if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
  await debuggerApi.sendCommand("Network.enable");
  discoveryDebuggerAttached = true;
  debuggerApi.on("message", (_event, method, params) => {
    if (method === "Network.webSocketCreated" && /webcast|im\/push/i.test(params.url || "")) {
      discoverySawSocket = true;
      setStatus("connected", "Active");
      return;
    }
    if (method === "Network.webSocketFrameReceived") {
      void processBrowserWebSocketFrame(params).catch(error => {
        setStatus("error", `Could not process TikTok event: ${error.message}`);
      });
      return;
    }
    if (method === "Network.responseReceived" && params.response?.url?.includes("/webcast/room/enter/")) {
      pendingRoomResponses.add(params.requestId);
      setDiscoveryStatus("capturing", `TikTok room response detected for @${discoveryUsername}…`);
      return;
    }
    if (method !== "Network.loadingFinished" || !pendingRoomResponses.delete(params.requestId)) return;
    captureRoomResponse(debuggerApi, params.requestId).catch(error => {
      discoveryLastError = error.message;
    });
  });
  debuggerApi.on("detach", () => {
    discoveryDebuggerAttached = false;
  });
}

async function readDevToolsEndpoint() {
  const portFile = path.join(app.getPath("userData"), "DevToolsActivePort");
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const [port, wsPath] = (await readFile(portFile, "utf8")).split("\n");
      if (port && wsPath) return { port: Number(port), path: wsPath.trim() };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("DevTools endpoint never became available");
}

// TikTok runs its webcast push socket inside a Web Worker, which the page-level
// debugger cannot observe. Connect as a full CDP client over the loopback debug
// port and attach ONLY to worker targets (never pages — Electron's own
// webContents.debugger needs those) so worker WebSocket frames are captured too.
function startWorkerFrameCapture() {
  readDevToolsEndpoint().then(({ port, path: wsPath }) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
    const trackedSessions = new Set();
    let nextId = 1;
    const send = (method, params = {}, sessionId) => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(JSON.stringify({ id: nextId++, method, params, ...(sessionId ? { sessionId } : {}) }));
    };
    const isWorkerTarget = targetInfo => ["worker", "shared_worker", "service_worker"].includes(targetInfo.type);
    const trackTarget = targetInfo => {
      if (!isWorkerTarget(targetInfo)) return;
      send("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
    };
    client.on("open", () => {
      send("Target.setDiscoverTargets", { discover: true });
      send("Target.getTargets");
    });
    client.on("message", raw => {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (message.id === 2 && message.result?.targetInfos) {
        for (const targetInfo of message.result.targetInfos) trackTarget(targetInfo);
        return;
      }
      if (message.method === "Target.targetCreated") {
        trackTarget(message.params.targetInfo);
        return;
      }
      if (message.method === "Target.attachedToTarget") {
        const { sessionId, targetInfo } = message.params;
        if (!isWorkerTarget(targetInfo)) return;
        trackedSessions.add(sessionId);
        send("Network.enable", {}, sessionId);
        return;
      }
      if (message.method === "Target.detachedFromTarget") {
        trackedSessions.delete(message.params.sessionId);
        return;
      }
      if (!message.sessionId || !trackedSessions.has(message.sessionId)) return;
      if (message.method === "Network.webSocketFrameReceived") {
        void processBrowserWebSocketFrame(message.params).catch(error => {
          setStatus("error", `Could not process TikTok event: ${error.message}`);
        });
      } else if (message.method === "Network.webSocketCreated" && /webcast|im\/push/i.test(message.params.url || "")) {
        discoverySawSocket = true;
        setStatus("connected", "Active");
      }
    });
    client.on("error", error => console.error("Worker frame capture disconnected", error.message));
  }).catch(error => console.error("Worker frame capture unavailable", error.message));
}

async function isTikTokLoggedIn() {
  const cookies = await session.fromPartition("persist:tiktok-scorekeeper-auth").cookies.get({ urls: ["https://www.tiktok.com"] });
  return cookies.some(cookie => ["sessionid", "sessionid_ss"].includes(cookie.name) && Boolean(cookie.value));
}

function prepareInvisibleReceiver() {
  if (!discoveryWindow || discoveryWindow.isDestroyed()) return;
  discoveryWindow.setOpacity(0);
  discoveryWindow.setIgnoreMouseEvents(true);
  discoveryWindow.showInactive();
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

async function withTimeout(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function pageNeedsLogin() {
  if (!(await isTikTokLoggedIn())) return true;
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
    isTikTokLoggedIn().then(async loggedIn => {
      if (!loggedIn || attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) return;
      clearInterval(loginWatcher);
      prepareInvisibleReceiver();
      setDiscoveryStatus("capturing", `Signed in. Reading @${discoveryUsername}'s LIVE…`);
      await loadLivePage(targetUrl, attempt, 0);
    }).catch(error => {
      discoveryLastError = error.message;
    });
  }, 1000);
}

async function openLogin(targetUrl, attempt) {
  if (attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) return;
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  showLoginPage(`Sign in to TikTok; @${discoveryUsername}'s LIVE will connect automatically`);
  watchForLogin(targetUrl, attempt);
  const loginUrl = `https://www.tiktok.com/login?lang=en&redirectPath=${encodeURIComponent(targetUrl)}`;
  try {
    await navigateTikTok(loginUrl);
  } catch (error) {
    discoveryLastError = error.message;
    setDiscoveryStatus("error", "TikTok's login page could not be loaded. Use Refresh guests to retry.");
  }
}

async function finishLiveAttempt(targetUrl, attempt, retry) {
  if (attempt !== discoveryAttempt || discoveryHadSnapshot || !discoveryWindow || discoveryWindow.isDestroyed()) return;
  if (await pageNeedsLogin()) {
    await openLogin(targetUrl, attempt);
    return;
  }
  if (retry < 1) {
    setDiscoveryStatus("capturing", `Retrying @${discoveryUsername}'s LIVE roster…`);
    pendingRoomResponses.clear();
    discoveryWindow.webContents.reloadIgnoringCache();
    discoveryAttentionTimer = setTimeout(() => {
      void finishLiveAttempt(targetUrl, attempt, retry + 1);
    }, 10_000);
    return;
  }

  let pageText = "";
  try {
    pageText = await discoveryWindow.webContents.executeJavaScript("document.body?.innerText || ''", true);
  } catch {}
  const offline = /live has ended|isn't live|is not live|currently offline/i.test(pageText);
  if (offline) {
    setDiscoveryStatus("error", `@${discoveryUsername} is not currently LIVE`);
    if (connectionStatus.state !== "connected") setStatus("error", "LIVE unavailable");
  } else if (discoverySawSocket) {
    setDiscoveryStatus("error", "Live events are active, but TikTok did not provide the guest roster. Retrying automatically…");
  } else {
    const suffix = discoveryLastError ? ` (${discoveryLastError})` : "";
    setDiscoveryStatus("error", `TikTok did not finish loading the LIVE. Retrying automatically…${suffix}`);
    if (connectionStatus.state !== "connected") setStatus("connecting", "Retrying TikTok LIVE…");
  }
  discoveryWindow.hide();
  discoveryRetryTimer = setTimeout(() => {
    if (attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) return;
    prepareInvisibleReceiver();
    void loadLivePage(targetUrl, attempt, 0);
  }, 20_000);
}

async function loadLivePage(targetUrl, attempt, retry) {
  if (attempt !== discoveryAttempt || !discoveryWindow || discoveryWindow.isDestroyed()) return;
  prepareInvisibleReceiver();
  try {
    await navigateTikTok(targetUrl);
    if (!discoveryDebuggerAttached && discoveryWindow && !discoveryWindow.isDestroyed()) {
      await withTimeout(
        attachDiscoveryDebugger(discoveryWindow),
        5_000,
        "TikTok event capture did not initialize"
      );
      discoveryWindow.webContents.reloadIgnoringCache();
    }
    if (await capturePageBootstrap()) return;
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
  discoverySawSocket = false;
  discoveryLastError = "";
  pendingRoomResponses.clear();
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
      discoveryDebuggerAttached = false;
      discoveryClosingIntentionally = false;
      clearTimeout(discoveryAttentionTimer);
      clearTimeout(discoveryRetryTimer);
      clearInterval(loginWatcher);
      pendingRoomResponses.clear();
      discoveryWindow = undefined;
      if (unexpectedClose && connection) {
        connection = undefined;
        setStatus("disconnected", connectionStatus.state === "connecting" ? "Sign-in cancelled" : "Disconnected");
      }
    });
  }

  discoveryClosingIntentionally = false;
  try {
    const targetUrl = `https://www.tiktok.com/@${encodeURIComponent(cleanUsername)}/live`;
    if (!(await isTikTokLoggedIn())) {
      await openLogin(targetUrl, attempt);
    } else {
      setDiscoveryStatus("capturing", `Reading @${cleanUsername}'s LIVE…`);
      await loadLivePage(targetUrl, attempt, 0);
    }
  } catch (error) {
    discoveryLastError = error.message;
    setDiscoveryStatus("error", `TikTok connection setup failed: ${error.message}`);
    setStatus("error", "Connection failed");
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

  setStatus("connecting", `Connecting to @${cleanUsername}…`);
  connection = { username: cleanUsername };
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
    discoveryAttempt++;
    clearTimeout(discoveryAttentionTimer);
    clearTimeout(discoveryRetryTimer);
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
  ipcMain.handle("overlay:copy", event => {
    assertTrusted(event);
    const url = `http://127.0.0.1:${PORT}/overlay`;
    clipboard.writeText(url);
    return url;
  });
  ipcMain.handle("gift:simulate", async event => {
    assertTrusted(event);
    const participant = store.show.participants[Math.floor(Math.random() * Math.max(store.show.participants.length, 1))];
    const raw = {
      msgId: `simulation-${crypto.randomUUID()}`,
      user: { userId: "demo-viewer", uniqueId: "demo_viewer", nickname: "Demo Viewer" },
      giftId: "5655",
      giftDetails: { giftName: "Rose", giftType: 0, diamondCount: 1 },
      receiverUserId: participant?.tiktokUserId || undefined,
      receiver: participant ? { uniqueId: participant.handle } : undefined,
      repeatCount: Math.ceil(Math.random() * 5),
      repeatEnd: true
    };
    const normalized = normalizeGift(raw, store.show.participants);
    normalized.assignmentMethod = participant ? "simulation" : normalized.assignmentMethod;
    normalized.participantId = participant?.id || normalized.participantId;
    await store.recordGift(normalized, raw);
    return sendState();
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

function enableHotReload(targetWindow) {
  if (app.isPackaged) return;
  let debounce;
  watch(directory, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      if (/(index\.html|styles\.css|renderer\.js|gift-catalog\.js|overlay\.html)$/.test(filename)) {
        targetWindow.webContents.reload();
      } else if (/\.(js|cjs|mjs)$/.test(filename)) {
        app.relaunch();
        app.exit(0);
      }
    }, 120);
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
    titleBarOverlay: { color: "#0c1017", symbolColor: "#e8eaf0", height: 52 },
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
  enableHotReload(window);
}

if (hasSingleInstanceLock) {
app.whenReady().then(async () => {
  await loadSettings();
  store = new ShowStore(path.join(app.getPath("userData"), "shows"));
  await store.initialize();
  await startOverlayServer();
    registerIpc();
    createWindow();
    startWorkerFrameCapture();
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
  clearTimeout(discoveryAttentionTimer);
  clearTimeout(discoveryRetryTimer);
  clearInterval(loginWatcher);
});
app.on("window-all-closed", () => app.quit());
