let state;
let eventFilter = sessionStorage.getItem("eventFilter") || "all";
const GIFT_FLASH_MS = 1400;
let seenGiftVersions;
const flashingGifts = new Map();
const selectedGiftIds = new Set();
let displayedGiftIds = [];
let lastSelectedGiftId = "";
let bulkRecipientChoice = "__choose__";
let audioContext;
const byId = id => document.getElementById(id);
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
// Fold decorative Unicode display names (math script, fullwidth, etc.) into
// standard letters so they render in the app font instead of exotic fallbacks.
const displayName = value => String(value ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "").trim();

function notice(message, error = false) {
  const element = byId("notice");
  element.textContent = message || "";
  element.classList.toggle("error", error);
}

function describeShow(show) {
  if (!show.streamSessionId) return "A new show starts with each stream session.";
  const segments = Array.isArray(show.segments) ? show.segments.length : 0;
  const started = show.createdAt ? `Started ${new Date(show.createdAt).toLocaleString()}` : "";
  if (segments > 1) return started ? `${segments} segments · ${started}` : `${segments} segments`;
  return started;
}

function listedGifts() {
  return state.show.gifts.filter(event => (event.gift?.totalValue || 0) >= (state.settings?.minVisibleCoins ?? 10));
}

async function playGiftSound(kind = "ding") {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("Audio playback is unavailable on this computer.");
  audioContext ||= new AudioContextClass();
  await audioContext.resume();
  const start = audioContext.currentTime + 0.01;
  const tone = (frequency, delay, duration, wave, volume) => {
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = wave;
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + delay);
    gain.gain.exponentialRampToValueAtTime(volume, start + delay + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + duration);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(start + delay);
    oscillator.stop(start + delay + duration + 0.01);
  };
  if (kind === "chime") {
    tone(659.25, 0, 0.23, "sine", 0.14);
    tone(987.77, 0.14, 0.33, "sine", 0.12);
  } else if (kind === "pop") {
    tone(392, 0, 0.11, "triangle", 0.19);
  } else {
    tone(880, 0, 0.42, "sine", 0.17);
    tone(1320, 0, 0.31, "sine", 0.06);
  }
}

function render(next) {
  const giftVersions = new Map(next.show.gifts.map(event => [event.id, event.receivedAt]));
  if (seenGiftVersions) {
    const now = Date.now();
    for (const [id, version] of giftVersions) {
      if (seenGiftVersions.get(id) !== version) flashingGifts.set(id, now + GIFT_FLASH_MS);
    }
    for (const [id, until] of flashingGifts) {
      if (!giftVersions.has(id) || until <= now) flashingGifts.delete(id);
    }
  }
  seenGiftVersions = giftVersions;
  state = next;
  byId("show-title").textContent = state.show.title;
  byId("show-meta").textContent = describeShow(state.show);
  if (!byId("username").value) byId("username").value = state.show.hostUsername ? `@${state.show.hostUsername}` : "";

  const status = byId("status");
  status.dataset.state = state.connection.state;
  status.querySelector("b").textContent = state.connection.state === "connected" ? "Active" : state.connection.detail;
  status.title = state.connection.detail;

  const connectButton = byId("connect");
  const connected = state.connection.state === "connected";
  const active = connected || state.connection.state === "connecting" || state.connection.state === "reconnecting";
  byId("username").disabled = active;
  connectButton.textContent = active ? "Disconnect" : "Connect";
  connectButton.classList.toggle("success", !active);
  connectButton.classList.toggle("danger", active);
  const alert = byId("connection-alert");
  const connectionAlert = state.connection.state === "reconnecting" || state.connection.state === "error" ||
    (connected && /restored/i.test(state.connection.detail));
  const discoveryAlert = state.discovery?.state === "error";
  const showAlert = connectionAlert || discoveryAlert;
  alert.hidden = !showAlert;
  if (showAlert) {
    alert.dataset.state = connectionAlert ? state.connection.state : "error";
    alert.textContent = connectionAlert ? state.connection.detail : `Guest discovery: ${state.discovery.detail}`;
  }

  const discovery = byId("discovery-status");
  discovery.dataset.state = state.discovery?.state || "idle";
  discovery.textContent = state.discovery?.detail || "Guest discovery idle";
  renderScoreboard();
  const canCopyRanking = state.scores.some(score => score.participant?.role === "guest");
  byId("copy-ranking").disabled = !canCopyRanking;
  byId("reset-scores").disabled = !state.show.gifts.some(event => event.scoreable && (event.scoreEpoch ?? 0) === (state.show.scoreEpoch ?? 0));
  renderLedger();
  if (settingsDialog.open) updateRankingPreview();
}

function renderScoreboard() {
  const scoreById = new Map(state.scores.map(score => [score.participant.id, score]));
  const unassigned = state.scores.find(score => score.participant.id === null);
  const cards = shownParticipants().map((participant, index) => {
    const score = scoreById.get(participant.id) || { points: 0, gifts: 0 };
    const selected = participant.id === state.show.activeDancerId;
    const name = displayName(participant.name);
    const rank = participant.role === "host"
      ? '<span class="rank rank-host">HOST</span>'
      : `<span class="rank">GUEST ${index + 1}</span>`;
    const content = `
      ${rank}
      ${selected ? '<span class="active-dancer-badge" aria-hidden="true">● ACTIVE DANCER · Click to stop</span>' : ""}
      <h3 title="${escapeHtml(name)}">${escapeHtml(name)}</h3>
      <div class="score"><b>${score.points.toLocaleString()}</b><small>${score.gifts.toLocaleString()} gifts</small></div>`;
    if (participant.role === "host") return `<article class="score-card">${content}</article>`;
    return `<button type="button" class="score-card" data-guest-id="${escapeHtml(participant.id)}" aria-pressed="${selected}" aria-label="${selected ? "Stop assigning unassigned gifts to" : "Make active dancer:"} ${escapeHtml(name)}" title="${selected ? "Click again to stop assigning unassigned gifts" : `Make ${escapeHtml(name)} the active dancer for new unassigned gifts`}">${content}</button>`;
  });
  if (unassigned) cards.push(`<article class="score-card">
    <span class="rank rank-review">NEEDS REVIEW</span>
    <h3>Unassigned</h3>
    <p class="card-note">Fix recipients in the ledger</p>
    <div class="score"><b>${unassigned.points.toLocaleString()}</b><small>${unassigned.gifts.toLocaleString()} gifts</small></div>
  </article>`);
  byId("scoreboard").innerHTML = cards.join("") || `<p class="empty">Connect to a live stream to load the host and guest roster.</p>`;
}

function shownParticipants() {
  const participants = state?.show.participants || [];
  return participants.some(participant => participant.role === "guest")
    ? participants.filter(participant => participant.role !== "host") : participants;
}

function isHostRecipient(recipient) {
  const host = state.show.participants.find(participant => participant.role === "host");
  if (!host || !state.show.participants.some(participant => participant.role === "guest")) return false;
  if (recipient?.userId && recipient.userId === host.tiktokUserId) return true;
  const name = recipient?.name?.replace(/^@/, "").toLowerCase();
  return Boolean(name && [host.handle, host.name].some(value => value?.replace(/^@/, "").toLowerCase() === name));
}

function renderLedger() {
  const gifts = listedGifts();
  const missed = new Set(state.missedGiftIds || []);
  const knownIds = new Set(state.show.gifts.map(event => event.id));
  for (const id of selectedGiftIds) if (!knownIds.has(id)) selectedGiftIds.delete(id);
  const hiddenCount = state.show.gifts.length - gifts.length;
  const unassignedCount = gifts.filter(event => !event.participantId).length;
  const missedCount = gifts.filter(event => missed.has(event.id)).length;
  if (eventFilter === "missed" && !missedCount) eventFilter = "all";
  byId("count-all").textContent = gifts.length.toLocaleString();
  byId("count-review").textContent = unassignedCount.toLocaleString();
  byId("count-missed").textContent = missedCount.toLocaleString();
  byId("clear-missed").hidden = !missed.size;
  byId("event-filters").querySelector('[data-filter="missed"]').hidden = !missedCount;
  for (const chip of byId("event-filters").querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === eventFilter));
  }

  const visible = eventFilter === "unassigned" ? gifts.filter(event => !event.participantId)
    : eventFilter === "missed" ? gifts.filter(event => missed.has(event.id)) : gifts;
  displayedGiftIds = visible.slice(0, 300).map(event => event.id);
  byId("events").innerHTML = visible.slice(0, 300).map(event => {
    const detectedRecipient = isHostRecipient(event.recipient) ? "" : event.recipient?.name || (event.recipient?.userId && event.recipient.userId !== "0" ? `TikTok user ${event.recipient.userId}` : "");
    const participantOptions = `<option value="">${detectedRecipient ? `Detected: ${escapeHtml(displayName(detectedRecipient))}` : "Unassigned"}</option>` + shownParticipants().map(participant => `<option value="${participant.id}">${escapeHtml(displayName(participant.name))}</option>`).join("");
    const classes = [flashingGifts.has(event.id) && "gift-arrival", missed.has(event.id) && "gift-missed", selectedGiftIds.has(event.id) && "gift-selected"].filter(Boolean).join(" ");
    return `<tr data-event-id="${escapeHtml(event.id)}" class="${classes}">
      <td class="select-column"><input class="row-check" type="checkbox" data-gift-id="${escapeHtml(event.id)}" aria-label="Select ${escapeHtml(event.gift.name)} from ${escapeHtml(displayName(event.sender.name))}" ${selectedGiftIds.has(event.id) ? "checked" : ""}></td>
      <td>${new Date(event.receivedAt).toLocaleTimeString()}${missed.has(event.id) ? '<span class="missed-tag">MISSED</span>' : ""}</td>
      <td>${escapeHtml(displayName(event.sender.name))}</td>
      <td>${escapeHtml(event.gift.name)}</td>
      <td>×${event.gift.repeatCount}</td>
      <td>${event.gift.totalValue || "—"}</td>
      <td><select data-gift="${event.id}" aria-label="Recipient for gift from ${escapeHtml(event.sender.name)}">${participantOptions}</select></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="empty">${eventFilter === "unassigned" ? "Nothing needs review. Nice." : eventFilter === "missed" ? "No missed gifts." : "No gifts recorded yet. Connect to a LIVE stream to start tracking."}</td></tr>`;
  for (const event of visible.slice(0, 300)) {
    const select = document.querySelector(`select[data-gift="${CSS.escape(event.id)}"]`);
    if (select) select.value = event.participantId || "";
  }
  const hiddenNote = hiddenCount ? ` · ${hiddenCount.toLocaleString()} under ${state.settings?.minVisibleCoins ?? 10} hidden` : "";
  byId("event-count").textContent = (eventFilter === "unassigned"
    ? `${visible.length.toLocaleString()} of ${gifts.length.toLocaleString()} events`
    : eventFilter === "missed" ? `${visible.length.toLocaleString()} missed events`
    : `${gifts.length.toLocaleString()} events`) + hiddenNote;
  updateSelectionUi();
}

function updateSelectionUi() {
  for (const checkbox of byId("events").querySelectorAll(".row-check")) {
    checkbox.checked = selectedGiftIds.has(checkbox.dataset.giftId);
    checkbox.closest("tr").classList.toggle("gift-selected", checkbox.checked);
  }
  const selectedDisplayed = displayedGiftIds.filter(id => selectedGiftIds.has(id)).length;
  const selectAll = byId("select-visible");
  selectAll.checked = displayedGiftIds.length > 0 && selectedDisplayed === displayedGiftIds.length;
  selectAll.indeterminate = selectedDisplayed > 0 && selectedDisplayed < displayedGiftIds.length;
  selectAll.disabled = !displayedGiftIds.length;
  byId("bulk-actions").classList.toggle("is-inactive", !selectedGiftIds.size);
  byId("selected-count").textContent = selectedGiftIds.size ? `${selectedGiftIds.size.toLocaleString()} selected` : "Select gifts to assign";
  const recipient = byId("bulk-recipient");
  recipient.innerHTML = '<option value="__choose__">Choose recipient…</option><option value="">Unassigned</option>' +
    shownParticipants().map(participant => `<option value="${escapeHtml(participant.id)}">${escapeHtml(displayName(participant.name))}</option>`).join("");
  recipient.value = [...recipient.options].some(option => option.value === bulkRecipientChoice) ? bulkRecipientChoice : "__choose__";
  recipient.disabled = !selectedGiftIds.size;
  byId("bulk-clear").disabled = !selectedGiftIds.size;
  byId("bulk-apply").disabled = !selectedGiftIds.size || recipient.value === "__choose__";
}

async function perform(action, successMessage) {
  try {
    notice("");
    const result = await action();
    if (result?.show) render(result);
    if (successMessage) notice(successMessage);
    return result;
  } catch (error) {
    notice(error.message || String(error), true);
  }
}

// Tools menu: replaces the retired SHOW panel's button row.
const toolsButton = byId("tools-menu-button");
const toolsMenu = byId("tools-menu");
const scoreboardButton = byId("scoreboard-menu-button");
const scoreboardMenu = byId("scoreboard-menu");

function setToolsMenu(open) {
  if (!open && !toolsMenu.hidden && toolsMenu.contains(document.activeElement)) toolsButton.focus();
  toolsMenu.hidden = !open;
  toolsButton.setAttribute("aria-expanded", String(open));
}

function setScoreboardMenu(open) {
  if (!open && !scoreboardMenu.hidden && scoreboardMenu.contains(document.activeElement)) scoreboardButton.focus();
  scoreboardMenu.hidden = !open;
  scoreboardButton.setAttribute("aria-expanded", String(open));
}

const toolForShortcut = event => {
  const key = event.key.toLowerCase();
  if (key === "g" && !event.shiftKey) return "discover-guests";
  if (key === "," && !event.shiftKey) return "settings";
  if (key === "o" && event.shiftKey) return "copy-overlay";
  if (key === "e" && !event.shiftKey) return "export";
  return null;
};

toolsButton.addEventListener("click", () => {
  if (toolsMenu.hidden) {
    setScoreboardMenu(false);
    setToolsMenu(true);
    toolsMenu.querySelector(".menu-item")?.focus();
  } else {
    setToolsMenu(false);
  }
});

scoreboardButton.addEventListener("click", () => {
  if (scoreboardMenu.hidden) {
    setToolsMenu(false);
    setScoreboardMenu(true);
    byId("copy-ranking").focus();
  } else {
    setScoreboardMenu(false);
  }
});

byId("copy-ranking").addEventListener("click", () => {
  setScoreboardMenu(false);
  perform(() => window.scorekeeper.copyRanking(), "Formatted ranking comment copied.");
});

byId("reset-scores").addEventListener("click", async () => {
  setScoreboardMenu(false);
  if (!window.confirm("Reset all current scores to zero? Recorded gift events and CSV history will be kept.")) return;
  await perform(() => window.scorekeeper.resetScores(), "Scores reset. Gift history was kept.");
});

toolsMenu.addEventListener("click", event => {
  if (event.target.closest(".menu-item")) setToolsMenu(false);
});

toolsMenu.addEventListener("keydown", event => {
  const items = [...toolsMenu.querySelectorAll(".menu-item")];
  const index = items.indexOf(document.activeElement);
  if (index < 0 && !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const offset = event.key === "ArrowDown" ? 1 : -1;
    items[(index + offset + items.length) % items.length]?.focus();
  } else if (event.key === "Home") {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === "End") {
    event.preventDefault();
    items.at(-1)?.focus();
  }
});

document.addEventListener("click", event => {
  if (!toolsMenu.hidden && !event.target.closest(".menu-anchor")) setToolsMenu(false);
  if (!scoreboardMenu.hidden && !event.target.closest(".scoreboard-menu-anchor")) setScoreboardMenu(false);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (!toolsMenu.hidden) setToolsMenu(false);
    if (!scoreboardMenu.hidden) setScoreboardMenu(false);
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const toolId = toolForShortcut(event);
  if (!toolId) return;
  event.preventDefault();
  setToolsMenu(false);
  byId(toolId).click();
});

byId("connect").addEventListener("click", () => {
  if (["connected", "connecting", "reconnecting"].includes(state?.connection.state)) perform(() => window.scorekeeper.disconnect());
  else perform(() => window.scorekeeper.connect(byId("username").value));
});
byId("discover-guests").addEventListener("click", () => perform(() => window.scorekeeper.discoverGuests(byId("username").value)));
byId("copy-overlay").addEventListener("click", () => perform(() => window.scorekeeper.copyOverlay(), "OBS overlay URL copied."));
byId("export").addEventListener("click", async () => {
  const path = await perform(() => window.scorekeeper.exportCsv());
  if (path) notice(`Exported to ${path}`);
});

byId("scoreboard").addEventListener("click", async event => {
  const card = event.target.closest("button[data-guest-id]");
  if (!card) return;
  const guestId = card.dataset.guestId;
  const active = state.show.activeDancerId === guestId;
  card.disabled = true;
  const name = displayName(state.show.participants.find(item => item.id === guestId)?.name || "Guest");
  const result = await perform(() => window.scorekeeper.setActiveDancer(active ? null : guestId),
    active ? "Active dancer cleared. New unassigned gifts will stay unassigned." : `${name} is now the active dancer for new unassigned gifts.`);
  if (result?.show) byId("scoreboard").querySelector(`[data-guest-id="${CSS.escape(guestId)}"]`)?.focus({ preventScroll: true });
  else card.disabled = false;
});

byId("event-filters").addEventListener("click", event => {
  const chip = event.target.closest(".chip");
  if (chip && chip.dataset.filter !== eventFilter) {
    selectedGiftIds.clear();
    lastSelectedGiftId = "";
    bulkRecipientChoice = "__choose__";
    eventFilter = chip.dataset.filter;
    sessionStorage.setItem("eventFilter", eventFilter);
    renderLedger();
    byId("events").closest(".table-wrap").scrollTop = 0;
  }
});

byId("clear-missed").addEventListener("click", () => perform(() => window.scorekeeper.clearMissedGifts(), "Missed gifts marked as seen."));

byId("select-visible").addEventListener("change", event => {
  for (const id of displayedGiftIds) {
    if (event.target.checked) selectedGiftIds.add(id);
    else selectedGiftIds.delete(id);
  }
  updateSelectionUi();
});

byId("events").addEventListener("click", event => {
  const row = event.target.closest("tr[data-event-id]");
  if (!row || event.target.closest("select")) return;
  const checkbox = row.querySelector(".row-check");
  const checked = event.target === checkbox ? checkbox.checked : !checkbox.checked;
  if (event.shiftKey && lastSelectedGiftId && displayedGiftIds.includes(lastSelectedGiftId)) {
    const first = displayedGiftIds.indexOf(lastSelectedGiftId);
    const last = displayedGiftIds.indexOf(row.dataset.eventId);
    for (const id of displayedGiftIds.slice(Math.min(first, last), Math.max(first, last) + 1)) {
      if (checked) selectedGiftIds.add(id);
      else selectedGiftIds.delete(id);
    }
  } else if (checked) selectedGiftIds.add(row.dataset.eventId);
  else selectedGiftIds.delete(row.dataset.eventId);
  lastSelectedGiftId = row.dataset.eventId;
  updateSelectionUi();
});

byId("bulk-recipient").addEventListener("change", event => {
  bulkRecipientChoice = event.target.value;
  byId("bulk-apply").disabled = !selectedGiftIds.size || bulkRecipientChoice === "__choose__";
});
byId("bulk-clear").addEventListener("click", () => {
  selectedGiftIds.clear();
  lastSelectedGiftId = "";
  updateSelectionUi();
});
byId("bulk-apply").addEventListener("click", async () => {
  if (!selectedGiftIds.size || bulkRecipientChoice === "__choose__") return;
  const count = selectedGiftIds.size;
  const result = await perform(() => window.scorekeeper.assignGifts([...selectedGiftIds], bulkRecipientChoice), `${count} gift event${count === 1 ? "" : "s"} assigned.`);
  if (result?.show) {
    selectedGiftIds.clear();
    lastSelectedGiftId = "";
    updateSelectionUi();
  }
});

byId("events").addEventListener("change", event => {
  const select = event.target.closest("select[data-gift]");
  if (select) perform(() => window.scorekeeper.assignGift(select.dataset.gift, select.value));
});

const settingsDialog = byId("settings-dialog");
const settingsTabs = [...settingsDialog.querySelectorAll('[role="tab"]')];
function activateSettingsTab(tab, focus = false) {
  if (!tab) return;
  for (const candidate of settingsTabs) {
    const active = candidate === tab;
    candidate.setAttribute("aria-selected", String(active));
    candidate.tabIndex = active ? 0 : -1;
    byId(candidate.getAttribute("aria-controls")).hidden = !active;
  }
  if (tab.id !== "settings-tab-routing") closeGiftOptions();
  if (focus) tab.focus();
}
settingsDialog.querySelector(".settings-tabs").addEventListener("click", event => {
  activateSettingsTab(event.target.closest('[role="tab"]'));
});
settingsDialog.querySelector(".settings-tabs").addEventListener("keydown", event => {
  const current = settingsTabs.indexOf(document.activeElement);
  if (current < 0) return;
  let next;
  if (event.key === "ArrowRight") next = settingsTabs[(current + 1) % settingsTabs.length];
  else if (event.key === "ArrowLeft") next = settingsTabs[(current - 1 + settingsTabs.length) % settingsTabs.length];
  else if (event.key === "Home") next = settingsTabs[0];
  else if (event.key === "End") next = settingsTabs.at(-1);
  if (next) {
    event.preventDefault();
    activateSettingsTab(next, true);
  }
});
const giftInput = byId("routing-gift");
const giftList = byId("gift-list");
let giftOptionNames = [];
let comboMatches = [];
let comboActive = -1;

function paintCombo() {
  giftList.innerHTML = comboMatches.slice(0, 300).map((name, index) =>
    `<li role="option" data-index="${index}" aria-selected="${index === comboActive}" class="${index === comboActive ? "active" : ""}">${escapeHtml(name)}</li>`).join("");
  giftList.querySelector(".active")?.scrollIntoView({ block: "nearest" });
}

const isComboOpen = () => giftList.matches(":popover-open");

function positionCombo() {
  const rect = giftInput.getBoundingClientRect();
  giftList.style.left = `${rect.left}px`;
  giftList.style.top = `${rect.bottom + 4}px`;
  giftList.style.width = `${Math.max(rect.width, 240)}px`;
}

function openGiftOptions() {
  const query = giftInput.value.trim().toLowerCase();
  comboMatches = giftOptionNames.filter(name => !query || name.toLowerCase().includes(query));
  comboActive = comboMatches.length ? 0 : -1;
  positionCombo();
  if (!isComboOpen()) giftList.showPopover({ autofocus: false });
  giftInput.setAttribute("aria-expanded", "true");
  paintCombo();
}

function closeGiftOptions() {
  if (isComboOpen()) giftList.hidePopover();
  giftInput.setAttribute("aria-expanded", "false");
  comboActive = -1;
}

function selectGift(name) {
  giftInput.value = name;
  closeGiftOptions();
}

giftInput.addEventListener("focus", openGiftOptions);
giftInput.addEventListener("input", openGiftOptions);
giftInput.addEventListener("blur", () => setTimeout(closeGiftOptions, 120));
window.addEventListener("resize", () => { if (isComboOpen()) positionCombo(); });
giftInput.addEventListener("keydown", event => {
  if (!isComboOpen() && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    openGiftOptions();
    event.preventDefault();
    return;
  }
  if (!isComboOpen()) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    comboActive = Math.min(comboActive + 1, comboMatches.length - 1);
    paintCombo();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    comboActive = Math.max(comboActive - 1, 0);
    paintCombo();
  } else if (event.key === "Enter" && comboActive >= 0) {
    event.preventDefault();
    selectGift(comboMatches[comboActive]);
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeGiftOptions();
  }
});
giftList.addEventListener("mousedown", event => {
  const option = event.target.closest("[data-index]");
  if (!option) return;
  event.preventDefault();
  selectGift(comboMatches[Number(option.dataset.index)]);
});

function renderRoutingDialog() {
  const observed = (state?.show.gifts || []).map(event => event.gift?.name).filter(Boolean);
  giftOptionNames = [...new Set([...observed, ...(state?.giftNames || []), ...GIFT_CATALOG])].sort((a, b) => a.localeCompare(b));
  byId("routing-guest").innerHTML = shownParticipants()
    .map(participant => `<option value="${participant.id}">${escapeHtml(displayName(participant.name))}</option>`).join("")
    || `<option value="">No guests yet</option>`;
  const rules = Object.entries(state?.routingRules || {});
  byId("routing-list").innerHTML = rules.map(([key, rule]) => `<li>
      <b title="${escapeHtml(rule.giftName)}">${escapeHtml(rule.giftName)}</b>
      <span title="${escapeHtml(displayName(rule.guest.name))}">→ ${escapeHtml(displayName(rule.guest.name))}${rule.guest.handle ? ` (@${escapeHtml(rule.guest.handle)})` : ""}</span>
      <button type="button" class="rule-remove" data-rule="${escapeHtml(key)}" aria-label="Remove rule for ${escapeHtml(rule.giftName)}">×</button>
    </li>`).join("") || `<li class="routing-empty">No rules yet.</li>`;
}

const guestKey = participant => participant.tiktokUserId ? `id:${participant.tiktokUserId}`
  : participant.handle ? `handle:${participant.handle.toLowerCase()}` : `name:${participant.name.toLowerCase()}`;

function settingsDraft() {
  const guestAliases = { ...(state.settings?.guestAliases || {}) };
  for (const input of byId("guest-aliases").querySelectorAll("input[data-guest-key]")) {
    if (input.value.trim()) guestAliases[input.dataset.guestKey] = input.value.trim();
    else delete guestAliases[input.dataset.guestKey];
  }
  return {
    autoConnect: byId("setting-auto-connect").checked,
    autoReconnect: byId("setting-auto-reconnect").checked,
    minVisibleCoins: Number(byId("setting-min-coins").value),
    playGiftSound: byId("setting-gift-sound").checked,
    giftSound: byId("setting-sound-type").value,
    guestAliases,
    rankingTemplate: byId("setting-ranking-template").value,
    rankingEntryTemplate: byId("setting-ranking-entry").value,
    rankingSeparator: byId("setting-ranking-separator").value
  };
}

let previewVersion = 0;
async function updateRankingPreview() {
  if (!settingsDialog.open) return;
  const version = ++previewVersion;
  try {
    const preview = await window.scorekeeper.previewRanking(settingsDraft());
    if (version === previewVersion && settingsDialog.open) {
      byId("ranking-preview").textContent = preview || "No guests yet";
      byId("ranking-preview").classList.remove("error");
    }
  } catch (error) {
    if (version === previewVersion && settingsDialog.open) {
      byId("ranking-preview").textContent = error.message || String(error);
      byId("ranking-preview").classList.add("error");
    }
  }
}

function openSettings() {
  const settings = state.settings;
  byId("setting-auto-connect").checked = settings.autoConnect;
  byId("setting-auto-reconnect").checked = settings.autoReconnect;
  byId("setting-euler-key").value = "";
  byId("setting-euler-key").disabled = false;
  byId("setting-remove-euler-key").checked = false;
  byId("remove-euler-key-label").hidden = settings.eulerApiKeySource !== "saved";
  byId("setting-euler-key").placeholder = settings.eulerApiKeySource === "saved" || settings.eulerApiKeySource === "environment" ? "****" : "Paste an API key";
  byId("euler-key-status").textContent = settings.eulerApiKeyError || ({ saved: "A saved API key is configured.", environment: "Using the SIGN_API_KEY environment variable.", none: "No API key configured; using community signing limits." })[settings.eulerApiKeySource];
  byId("setting-min-coins").value = settings.minVisibleCoins;
  byId("setting-gift-sound").checked = settings.playGiftSound;
  byId("setting-sound-type").value = settings.giftSound || "ding";
  byId("setting-ranking-template").value = settings.rankingTemplate;
  byId("setting-ranking-entry").value = settings.rankingEntryTemplate;
  byId("setting-ranking-separator").value = settings.rankingSeparator;
  const guests = state.show.participants.filter(participant => participant.role !== "host");
  byId("guest-aliases").innerHTML = guests.map(participant => {
    const key = guestKey(participant);
    return `<label class="guest-alias"><span title="${escapeHtml(participant.name)}">${escapeHtml(participant.name)}</span><input data-guest-key="${escapeHtml(key)}" value="${escapeHtml(settings.guestAliases?.[key] || "")}" maxlength="60" placeholder="Short name" aria-label="Short name for ${escapeHtml(participant.name)}"></label>`;
  }).join("") || `<p class="settings-help">Connect and discover guests to set their short names.</p>`;
  renderRoutingDialog();
  byId("settings-error").hidden = true;
  activateSettingsTab(settingsTabs[0]);
  settingsDialog.showModal();
  updateRankingPreview();
}

byId("settings").addEventListener("click", openSettings);
byId("euler-key-help").addEventListener("click", () => perform(() => window.scorekeeper.openEulerKeyHelp()));
byId("euler-pricing-help").addEventListener("click", () => perform(() => window.scorekeeper.openEulerPricingHelp()));
byId("settings-cancel").addEventListener("click", () => settingsDialog.close());
byId("settings-save").addEventListener("click", async () => {
  for (const [inputId, tabId] of [["setting-min-coins", "settings-tab-gifts"], ["setting-ranking-template", "settings-tab-ranking"], ["setting-ranking-entry", "settings-tab-ranking"]]) {
    const input = byId(inputId);
    if (!input.checkValidity()) {
      activateSettingsTab(byId(tabId));
      input.reportValidity();
      return;
    }
  }
  try {
    const newKey = byId("setting-euler-key").value.trim();
    const removeKey = byId("setting-remove-euler-key").checked;
    const result = await window.scorekeeper.updateSettings({
      ...settingsDraft(),
      ...(newKey ? { eulerApiKey: newKey } : {}),
      ...(removeKey ? { removeEulerApiKey: true } : {})
    });
    byId("setting-euler-key").value = "";
    render(result);
    notice("Settings saved.");
    settingsDialog.close();
  } catch (error) {
    const message = error.message || String(error);
    byId("settings-error").textContent = message;
    byId("settings-error").hidden = false;
    if (/format|template/i.test(message)) activateSettingsTab(byId("settings-tab-ranking"));
  }
});
settingsDialog.addEventListener("input", event => {
  if (event.target.closest("#guest-aliases, #setting-ranking-template, #setting-ranking-entry, #setting-ranking-separator")) updateRankingPreview();
});
settingsDialog.addEventListener("close", closeGiftOptions);
settingsDialog.addEventListener("close", () => { byId("setting-euler-key").value = ""; });
byId("setting-remove-euler-key").addEventListener("change", event => {
  byId("setting-euler-key").disabled = event.target.checked;
  if (event.target.checked) byId("setting-euler-key").value = "";
});
byId("test-gift-sound").addEventListener("click", () => perform(() => playGiftSound(byId("setting-sound-type").value)));
byId("routing-form").addEventListener("submit", async event => {
  event.preventDefault();
  const giftName = byId("routing-gift").value.trim();
  const participantId = byId("routing-guest").value;
  if (!giftName || !participantId) return;
  await perform(() => window.scorekeeper.setRoutingRule(giftName, participantId), `${giftName} now always counts for the selected guest.`);
  byId("routing-gift").value = "";
  renderRoutingDialog();
});
byId("routing-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-rule]");
  if (!button) return;
  await perform(() => window.scorekeeper.removeRoutingRule(button.dataset.rule));
  renderRoutingDialog();
});

window.scorekeeper.onStateChanged(render);
window.scorekeeper.onGiftSound(sound => { void playGiftSound(sound).catch(error => console.error("Could not play gift sound", error)); });
window.scorekeeper.getState().then(render).catch(error => notice(error.message, true));
