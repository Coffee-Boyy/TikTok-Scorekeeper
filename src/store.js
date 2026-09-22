import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { calculateScores, csvForShow, extractRecipient, inferParticipantId } from "./gifts.js";

const STREAK_WINDOW_MS = 30_000;

function giftCorrelationKey(event) {
  const sender = event.sender?.userId || event.sender?.handle || event.sender?.name || "unknown";
  const recipient = event.recipient?.userId || event.recipient?.name || event.participantId || "unassigned";
  return `${sender}|${event.gift?.id || event.gift?.name || "unknown"}|${recipient}`.toLowerCase();
}

function isNearbyStreak(left, right) {
  if (left.gift?.giftType !== 1 || right.gift?.giftType !== 1) return false;
  const elapsed = Math.abs(new Date(left.receivedAt).getTime() - new Date(right.receivedAt).getTime());
  return elapsed <= STREAK_WINDOW_MS && giftCorrelationKey(left) === giftCorrelationKey(right);
}

function collapseCompletedStreakUpdates(gifts) {
  const kept = [];
  let removed = 0;
  for (const event of gifts) {
    if (!event.scoreable && kept.some(candidate => candidate.scoreable && isNearbyStreak(candidate, event))) {
      removed++;
      continue;
    }
    kept.push(event);
  }
  return { gifts: kept, removed };
}

export class ShowStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.statePath = path.join(dataDirectory, "active-show.json");
    this.routingPath = path.join(dataDirectory, "routing.json");
    this.giftNamesPath = path.join(dataDirectory, "gift-names.json");
    this.show = null;
    this.routingRules = {};
    this.giftNames = [];
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      this.routingRules = JSON.parse(await readFile(this.routingPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.routingRules = {};
    }
    try {
      this.giftNames = JSON.parse(await readFile(this.giftNamesPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.giftNames = [];
    }
    try {
      this.show = JSON.parse(await readFile(this.statePath, "utf8"));
      let migrated = 0;
      try {
        const ledgerPath = path.join(this.dataDirectory, `${this.show.id}.jsonl`);
        const records = (await readFile(ledgerPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map(line => JSON.parse(line));
        const rawByEventId = new Map(records.map(record => [record.normalized?.id, record.raw]));
        for (const event of this.show.gifts || []) {
          if (event.recipient?.userId || event.recipient?.name) continue;
          const raw = rawByEventId.get(event.id);
          if (!raw) continue;
          const recipient = extractRecipient(raw);
          if (recipient.userId || recipient.name) {
            event.recipient = recipient;
            migrated++;
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const collapsed = collapseCompletedStreakUpdates(this.show.gifts || []);
      this.show.gifts = collapsed.gifts;
      const detectedRecipients = this.show.gifts
        .map(event => event.recipient)
        .filter(recipient => recipient && ((recipient.userId && recipient.userId !== "0") || recipient.name))
        .map(recipient => ({
          userId: recipient.userId === "0" ? "" : recipient.userId,
          name: recipient.name,
          source: "gift-recipient"
        }));
      if (detectedRecipients.length) {
        await this.upsertDiscoveredParticipants(detectedRecipients);
      } else if (collapsed.removed || migrated) {
        await this.persist();
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.show = this.createShow({ title: "Untitled show", hostUsername: "" });
      await this.persist();
    }
    let seeded = false;
    for (const event of this.show?.gifts || []) {
      if (this.rememberGiftName(event.gift?.name)) seeded = true;
    }
    if (seeded) await this.persistGiftNames();
    await this.applyRoutingRules();
    return this.snapshot();
  }

  createShow({ title, hostUsername }) {
    const cleanHost = String(hostUsername || "").trim().replace(/^@/, "");
    return {
      id: `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID().slice(0, 8)}`,
      title: String(title || "Untitled show").trim() || "Untitled show",
      hostUsername: cleanHost,
      createdAt: new Date().toISOString(),
      streamSessionId: "",
      segments: [],
      participants: cleanHost ? [{
        id: crypto.randomUUID(),
        name: cleanHost,
        handle: cleanHost,
        tiktokUserId: "",
        role: "host"
      }] : [],
      gifts: []
    };
  }

  sessionTitle(hostUsername, at = new Date()) {
    const host = hostUsername ? `@${hostUsername}` : "Show";
    const when = at.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `${host} · ${when}`;
  }

  bindSessionIdentity(hostUsername) {
    const cleanHost = String(hostUsername || "").trim().replace(/^@/, "");
    if (cleanHost) this.show.hostUsername = cleanHost;
    if (!this.show.title || this.show.title === "Untitled show") {
      this.show.title = this.sessionTitle(cleanHost || this.show.hostUsername);
      this.show.createdAt = new Date().toISOString();
    }
    if (!cleanHost) return;
    const host = this.show.participants.find(participant => participant.role === "host");
    if (!host) {
      this.show.participants.unshift({
        id: crypto.randomUUID(),
        name: cleanHost,
        handle: cleanHost,
        tiktokUserId: "",
        role: "host"
      });
      return;
    }
    if (!host.handle) host.handle = cleanHost;
    if (!host.name) host.name = cleanHost;
  }

  async beginStreamSession({ roomId, streamId, hostUsername }) {
    const sessionId = String(roomId || "").trim();
    if (!sessionId) return this.snapshot();
    const segmentId = String(streamId || "").trim();
    const cleanHost = String(hostUsername || "").trim().replace(/^@/, "");
    if (!Array.isArray(this.show.segments)) this.show.segments = [];

    let changed = false;
    if (this.show.streamSessionId !== sessionId) {
      if (this.show.streamSessionId) {
        this.show = this.createShow({
          title: this.sessionTitle(cleanHost),
          hostUsername: cleanHost
        });
      } else {
        this.bindSessionIdentity(cleanHost);
      }
      this.show.streamSessionId = sessionId;
      this.show.segments = [];
      changed = true;
    }

    if (segmentId && segmentId !== "0" && !this.show.segments.some(segment => segment.id === segmentId)) {
      this.show.segments.push({ id: segmentId, startedAt: new Date().toISOString() });
      changed = true;
    }

    if (changed) await this.persist();
    return this.snapshot();
  }

  async newShow(input) {
    this.show = this.createShow(input);
    await this.persist();
    return this.snapshot();
  }

  resolveRuleGuest(guest) {
    return this.show?.participants.find(item =>
      (guest.handle && item.handle?.toLowerCase() === guest.handle.toLowerCase()) ||
      (guest.name && item.name?.toLowerCase() === guest.name.toLowerCase())
    );
  }

  routeEvents(events) {
    let routed = 0;
    for (const event of events) {
      if (event.assignmentMethod === "manual") continue;
      const rule = this.routingRules[String(event.gift?.name || "").toLowerCase()];
      if (!rule) continue;
      const participant = this.resolveRuleGuest(rule.guest);
      if (!participant) continue;
      if (event.participantId !== participant.id || event.assignmentMethod !== "rule") {
        event.participantId = participant.id;
        event.assignmentMethod = "rule";
        routed++;
      }
    }
    return routed;
  }

  async applyRoutingRules() {
    if (!this.show) return false;
    const routed = this.routeEvents(this.show.gifts);
    if (routed) await this.persist();
    return routed > 0;
  }

  async setRoutingRule(giftName, participant) {
    const cleanGift = String(giftName || "").trim();
    if (!cleanGift) throw new Error("Enter a gift name.");
    if (!participant) throw new Error("Choose a guest to receive this gift.");
    this.routingRules[cleanGift.toLowerCase()] = {
      giftName: cleanGift,
      guest: { name: String(participant.name || ""), handle: String(participant.handle || "") }
    };
    await this.persistRouting();
    await this.applyRoutingRules();
    return this.snapshot();
  }

  async removeRoutingRule(giftName) {
    delete this.routingRules[String(giftName || "").toLowerCase()];
    await this.persistRouting();
    return this.snapshot();
  }

  rememberGiftName(name) {
    const clean = String(name || "").trim();
    if (!clean || this.giftNames.includes(clean)) return false;
    this.giftNames.push(clean);
    return true;
  }

  async persistGiftNames() {
    const temporaryPath = `${this.giftNamesPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify([...this.giftNames].sort(), null, 2), "utf8");
    await rename(temporaryPath, this.giftNamesPath);
  }

  async persistRouting() {
    const temporaryPath = `${this.routingPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.routingRules, null, 2), "utf8");
    await rename(temporaryPath, this.routingPath);
  }

  async addParticipant(input) {
    const participant = {
      id: crypto.randomUUID(),
      name: String(input.name || input.handle || "Guest").trim(),
      handle: String(input.handle || "").trim().replace(/^@/, ""),
      tiktokUserId: String(input.tiktokUserId || "").trim(),
      role: "guest"
    };
    this.show.participants.push(participant);
    await this.persist();
    return this.snapshot();
  }

  async updateHost(input) {
    const host = this.show.participants.find(item => item.role === "host");
    if (!host) return this.snapshot();
    if (input.name) host.name = String(input.name);
    if (input.handle) host.handle = String(input.handle).replace(/^@/, "");
    if (input.userId) host.tiktokUserId = String(input.userId);
    host.discoverySource = input.source || host.discoverySource;
    await this.persist();
    return this.snapshot();
  }

  async upsertDiscoveredParticipants(users) {
    let added = 0;
    let updated = 0;
    for (const input of users) {
      const userId = String(input.userId || "");
      const handle = String(input.handle || "").replace(/^@/, "");
      let participant = this.show.participants.find(item =>
        (userId && item.tiktokUserId === userId) ||
        (handle && item.handle?.toLowerCase() === handle.toLowerCase())
      );
      if (!participant) {
        participant = {
          id: crypto.randomUUID(),
          name: String(input.name || handle || `TikTok guest ${userId.slice(-6)}`),
          handle,
          tiktokUserId: userId,
          linkMicId: String(input.linkMicId || ""),
          role: "guest",
          discoverySource: String(input.source || "automatic")
        };
        this.show.participants.push(participant);
        added++;
      } else {
        if (input.name) participant.name = String(input.name);
        if (handle) participant.handle = handle;
        if (userId) participant.tiktokUserId = userId;
        if (input.linkMicId) participant.linkMicId = String(input.linkMicId);
        participant.discoverySource = String(input.source || participant.discoverySource || "automatic");
        updated++;
      }
    }
    let reassigned = 0;
    for (const event of this.show.gifts) {
      if (event.participantId || (!event.recipient?.userId && !event.recipient?.name)) continue;
      const assignment = inferParticipantId({
        toMemberId: event.recipient.userId,
        toMemberNickname: event.recipient.name
      }, this.show.participants);
      if (assignment.participantId) {
        event.participantId = assignment.participantId;
        event.assignmentMethod = assignment.method;
        reassigned++;
      }
    }
    const routed = this.routeEvents(this.show.gifts);
    if (added || updated || reassigned || routed) await this.persist();
    return { added, updated: updated + routed, reassigned, snapshot: this.snapshot() };
  }

  async removeParticipant(participantId) {
    this.show.participants = this.show.participants.filter(item => item.id !== participantId);
    for (const event of this.show.gifts) {
      if (event.participantId === participantId) {
        event.participantId = null;
        event.assignmentMethod = "participant-removed";
      }
    }
    await this.persist();
    return this.snapshot();
  }

  async recordGift(normalized, raw) {
    const duplicateIndex = normalized.sourceMessageId
      ? this.show.gifts.findIndex(event => event.sourceMessageId === normalized.sourceMessageId)
      : -1;
    const pendingStreakIndex = normalized.gift?.giftType === 1
      ? this.show.gifts.findIndex(event => !event.scoreable && isNearbyStreak(event, normalized))
      : -1;
    const existingIndex = duplicateIndex >= 0 ? duplicateIndex : pendingStreakIndex;
    if (existingIndex >= 0) {
      normalized.id = this.show.gifts[existingIndex].id;
      this.show.gifts.splice(existingIndex, 1);
    }
    const rule = this.routingRules[String(normalized.gift?.name || "").toLowerCase()];
    if (rule) {
      const routedTo = this.resolveRuleGuest(rule.guest);
      if (routedTo) {
        normalized.participantId = routedTo.id;
        normalized.assignmentMethod = "rule";
      }
    }
    this.show.gifts.unshift(normalized);
    const learnedGiftName = this.rememberGiftName(normalized.gift?.name);
    const ledgerPath = path.join(this.dataDirectory, `${this.show.id}.jsonl`);
    const ledgerRecord = JSON.stringify({ normalized, raw }) + "\n";
    this.writeQueue = this.writeQueue.then(async () => {
      await appendFile(ledgerPath, ledgerRecord, "utf8");
      if (learnedGiftName) await this.persistGiftNames();
      await this.persistNow();
    });
    await this.writeQueue;
    return this.snapshot();
  }

  async assignGift(eventId, participantId) {
    const event = this.show.gifts.find(item => item.id === eventId);
    if (!event) throw new Error("Gift event not found");
    if (participantId && !this.show.participants.some(item => item.id === participantId)) {
      throw new Error("Participant not found");
    }
    event.participantId = participantId || null;
    event.assignmentMethod = "manual";
    await this.persist();
    return this.snapshot();
  }

  snapshot() {
    return {
      show: this.show,
      scores: calculateScores(this.show),
      routingRules: this.routingRules,
      giftNames: [...this.giftNames].sort((a, b) => a.localeCompare(b))
    };
  }

  csv() {
    return csvForShow(this.show);
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(() => this.persistNow());
    await this.writeQueue;
  }

  async persistNow() {
    const temporaryPath = `${this.statePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(this.show, null, 2), "utf8");
    await rename(temporaryPath, this.statePath);
  }
}
