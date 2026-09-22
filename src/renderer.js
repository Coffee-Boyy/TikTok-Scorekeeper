let state;
let eventFilter = sessionStorage.getItem("eventFilter") || "all";
let showSmall = localStorage.getItem("showSmall") === "1";
const MIN_VISIBLE_COINS = 10;
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
  if (showSmall) return state.show.gifts;
  return state.show.gifts.filter(event => (event.gift?.totalValue || 0) >= MIN_VISIBLE_COINS);
}

function render(next) {
  state = next;
  byId("show-title").textContent = state.show.title;
  byId("show-meta").textContent = describeShow(state.show);
  if (!byId("username").value) byId("username").value = state.show.hostUsername ? `@${state.show.hostUsername}` : "";

  const status = byId("status");
  status.dataset.state = state.connection.state;
  status.querySelector("b").textContent = state.connection.detail;

  const connectButton = byId("connect");
  const connected = state.connection.state === "connected";
  const active = connected || state.connection.state === "connecting" || state.connection.state === "reconnecting";
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
  byId("show-small").setAttribute("aria-checked", String(showSmall));
  byId("auto-connect").setAttribute("aria-checked", String(state.settings?.autoConnect !== false));

  renderScoreboard();
  renderLedger();
}

function renderScoreboard() {
  const scoreById = new Map(state.scores.map(score => [score.participant.id, score]));
  const unassigned = state.scores.find(score => score.participant.id === null);
  const cards = state.show.participants.map((participant, index) => {
    const score = scoreById.get(participant.id) || { points: 0, gifts: 0 };
    const rank = participant.role === "host"
      ? '<span class="rank rank-host">HOST</span>'
      : `<span class="rank">GUEST ${index}</span>`;
    return `<article class="score-card">
      ${rank}
      <h3 title="${escapeHtml(displayName(participant.name))}">${escapeHtml(displayName(participant.name))}</h3>
      <div class="score"><b>${score.points.toLocaleString()}</b><small>${score.gifts.toLocaleString()} gifts</small></div>
    </article>`;
  });
  if (unassigned) cards.push(`<article class="score-card">
    <span class="rank rank-review">NEEDS REVIEW</span>
    <h3>Unassigned</h3>
    <p class="card-note">Fix recipients in the ledger</p>
    <div class="score"><b>${unassigned.points.toLocaleString()}</b><small>${unassigned.gifts.toLocaleString()} gifts</small></div>
  </article>`);
  byId("scoreboard").innerHTML = cards.join("") || `<p class="empty">Connect to a live stream to load the host and guest roster.</p>`;
}

function renderLedger() {
  const gifts = listedGifts();
  const hiddenCount = state.show.gifts.length - gifts.length;
  const unassignedCount = gifts.filter(event => !event.participantId).length;
  byId("count-all").textContent = gifts.length.toLocaleString();
  byId("count-review").textContent = unassignedCount.toLocaleString();
  for (const chip of byId("event-filters").querySelectorAll(".chip")) {
    chip.setAttribute("aria-pressed", String(chip.dataset.filter === eventFilter));
  }

  const visible = eventFilter === "unassigned" ? gifts.filter(event => !event.participantId) : gifts;
  byId("events").innerHTML = visible.slice(0, 300).map(event => {
    const detectedRecipient = event.recipient?.name || (event.recipient?.userId && event.recipient.userId !== "0" ? `TikTok user ${event.recipient.userId}` : "");
    const participantOptions = `<option value="">${detectedRecipient ? `Detected: ${escapeHtml(displayName(detectedRecipient))}` : "Unassigned"}</option>` + state.show.participants.map(participant => `<option value="${participant.id}">${escapeHtml(displayName(participant.name))}</option>`).join("");
    return `<tr>
      <td>${new Date(event.receivedAt).toLocaleTimeString()}</td>
      <td>${escapeHtml(displayName(event.sender.name))}</td>
      <td>${escapeHtml(event.gift.name)}</td>
      <td>×${event.gift.repeatCount}</td>
      <td>${event.gift.totalValue || "—"}</td>
      <td><select data-gift="${event.id}" aria-label="Recipient for gift from ${escapeHtml(event.sender.name)}">${participantOptions}</select></td>
    </tr>`;
  }).join("") || `<tr><td colspan="6" class="empty">${eventFilter === "unassigned" ? "Nothing needs review. Nice." : "No gifts recorded yet. Use Simulate gift in the tools menu to test the workflow."}</td></tr>`;
  for (const event of visible.slice(0, 300)) {
    const select = document.querySelector(`select[data-gift="${CSS.escape(event.id)}"]`);
    if (select) select.value = event.participantId || "";
  }
  const hiddenNote = !showSmall && hiddenCount ? ` · ${hiddenCount.toLocaleString()} under ${MIN_VISIBLE_COINS} hidden` : "";
  byId("event-count").textContent = (eventFilter === "unassigned"
    ? `${visible.length.toLocaleString()} of ${gifts.length.toLocaleString()} events`
    : `${gifts.length.toLocaleString()} events`) + hiddenNote;
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

function setToolsMenu(open) {
  if (!open && !toolsMenu.hidden && toolsMenu.contains(document.activeElement)) toolsButton.focus();
  toolsMenu.hidden = !open;
  toolsButton.setAttribute("aria-expanded", String(open));
}

const toolForShortcut = event => {
  const key = event.key.toLowerCase();
  if (key === "g") return event.shiftKey ? "simulate" : "discover-guests";
  if (key === "h" && event.shiftKey) return "show-small";
  if (key === "a" && event.shiftKey) return "auto-connect";
  if (key === "r" && event.shiftKey) return "routing";
  if (key === "o" && event.shiftKey) return "copy-overlay";
  if (key === "e" && !event.shiftKey) return "export";
  return null;
};

toolsButton.addEventListener("click", () => {
  if (toolsMenu.hidden) {
    setToolsMenu(true);
    toolsMenu.querySelector(".menu-item")?.focus();
  } else {
    setToolsMenu(false);
  }
});

toolsMenu.addEventListener("click", event => {
  if (event.target.closest("#show-small, #auto-connect")) return;
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
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    if (!toolsMenu.hidden) setToolsMenu(false);
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
byId("sign-in").addEventListener("click", () => perform(() => window.scorekeeper.signIn(byId("username").value)));
byId("copy-overlay").addEventListener("click", () => perform(() => window.scorekeeper.copyOverlay(), "OBS overlay URL copied."));
byId("simulate").addEventListener("click", () => perform(() => window.scorekeeper.simulateGift(), "Test gift recorded."));
byId("show-small").addEventListener("click", () => {
  showSmall = !showSmall;
  localStorage.setItem("showSmall", showSmall ? "1" : "0");
  byId("show-small").setAttribute("aria-checked", String(showSmall));
  renderScoreboard();
  renderLedger();
});
byId("auto-connect").addEventListener("click", async () => {
  const result = await perform(() => window.scorekeeper.toggleAutoConnect());
  if (result) notice(result.settings?.autoConnect ? "Auto-connect enabled. The app will reconnect to the last stream on launch." : "Auto-connect disabled.");
});
byId("export").addEventListener("click", async () => {
  const path = await perform(() => window.scorekeeper.exportCsv());
  if (path) notice(`Exported to ${path}`);
});

byId("event-filters").addEventListener("click", event => {
  const chip = event.target.closest(".chip");
  if (chip && chip.dataset.filter !== eventFilter) {
    eventFilter = chip.dataset.filter;
    sessionStorage.setItem("eventFilter", eventFilter);
    renderLedger();
  }
});

byId("events").addEventListener("change", event => {
  const select = event.target.closest("select[data-gift]");
  if (select) perform(() => window.scorekeeper.assignGift(select.dataset.gift, select.value));
});

const routingDialog = byId("routing-dialog");
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
  byId("routing-guest").innerHTML = (state?.show.participants || [])
    .map(participant => `<option value="${participant.id}">${escapeHtml(displayName(participant.name))}</option>`).join("")
    || `<option value="">No guests yet</option>`;
  const rules = Object.entries(state?.routingRules || {});
  byId("routing-list").innerHTML = rules.map(([key, rule]) => `<li>
      <b title="${escapeHtml(rule.giftName)}">${escapeHtml(rule.giftName)}</b>
      <span title="${escapeHtml(displayName(rule.guest.name))}">→ ${escapeHtml(displayName(rule.guest.name))}${rule.guest.handle ? ` (@${escapeHtml(rule.guest.handle)})` : ""}</span>
      <button type="button" class="rule-remove" data-rule="${escapeHtml(key)}" aria-label="Remove rule for ${escapeHtml(rule.giftName)}">×</button>
    </li>`).join("") || `<li class="routing-empty">No rules yet.</li>`;
}

byId("routing").addEventListener("click", () => {
  renderRoutingDialog();
  routingDialog.showModal();
});
byId("routing-close").addEventListener("click", () => routingDialog.close());
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
window.scorekeeper.getState().then(render).catch(error => notice(error.message, true));
