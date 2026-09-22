# TikTok LIVE Scorekeeper

A local-first Electron research app that listens for TikTok LIVE gift events, records a raw JSONL ledger, scores completed gifts, attributes gifts to multiple guests when recipient metadata is available, and supplies a local OBS scoreboard overlay.

> TikTok does not provide a public official LIVE gift API. This app uses the unofficial `tiktok-live-connector` for gift events, so it may need maintenance when TikTok changes its Webcast protocol.

## Run it

Requires Node.js 20 or newer.

```powershell
npm install
npm start
```

In the app:

1. Enter the host's TikTok username in the title bar and click **Connect** after the host is live. The button switches to **Disconnect** while connected. A new show starts for that stream session, and later segments of the same session stay in the show. A muted TikTok receiver opens the LIVE in a separate window for guest discovery, handles TikTok's **Watch on this computer** prompt if it appears, and shows sign-in if needed. It closes automatically after capturing the roster. Discovery progress appears in the bottom status bar.
2. The app imports cohosts, multi-guests, and battle participants when TikTok supplies them in a room roster and continues merging link-layer updates automatically.
3. Use the **⋯** tools menu in the title bar (or Ctrl+Shift+G) to **Simulate gift** and test scoring without a live stream. The same menu holds guest refresh, the OBS overlay URL, and CSV export.
4. Copy the OBS overlay URL from the tools menu (or Ctrl+Shift+O) and add it as a 1920×1080 Browser Source.

The overlay is served only on the local machine at `http://127.0.0.1:17342/overlay`.

## Multi-guest attribution

TikTok gift payloads are not consistent across standard LIVE, multi-guest, and battle modes. The app checks known recipient fields such as `receiverUserId`, `recipientUserId`, `toUserId`, `toMemberId`, and nested recipient objects.

Initial guest discovery uses TikTok's `/webcast/room/enter/` response. The app observes the signed request through Electron's session network hooks, then reads its response using the same TikTok session. It also checks `/webcast/room/info/` and TikTok's multi-guest backup endpoint while discovering guests. The receiver retries transient navigation and capture failures and displays sign-in only if TikTok requires it. Login cookies stay in the persistent, sandboxed receiver session and are never copied into the scorekeeper database. The app reads cohost and multi-guest linked users, Group LIVE members, and battle participants, then merges later link-layer and group-change events from the standalone webcast connection. If TikTok provides no guest roster, the browser retries discovery while gift listening continues independently.

Gift and link events use a standalone `tiktok-live-connector` WebSocket in the app's main process. It starts from the host username before guest discovery, resolves the room independently, and reconnects if the WebSocket drops. It does not need the discovery browser to open or remain available. The connector uses EulerStream's default signing service to establish this public, unauthenticated WebSocket; the app does not send TikTok login cookies to that service or require an API key.

If the gift connection drops or a connection attempt times out, the app shows a prominent reconnect notice and retries with bounded exponential backoff (respecting signing-service rate limits). Once restored, it refreshes the guest roster and warns that events during the outage may have been missed. The **Disconnect** button works while connecting or retrying. If the LIVE ends, the username is rejected, or gift data cannot be saved, tracking stops and the app shows an actionable error; use **Connect** to retry. Guest discovery retries transient failures, then closes its receiver and reports when manual refresh or sign-in is needed. Closing the guest discovery window does not stop gift tracking.

- A confident ID or handle match is assigned automatically.
- A Group LIVE gift can auto-add its `toMemberId` / `toMemberNickname` recipient when the room roster is not available yet.
- A show with one participant assigns gifts to that participant.
- Ambiguous gifts in a multi-participant show remain **Unassigned**.
- Use the recipient dropdown in the ledger to correct or assign an event.

This conservative behavior prevents a missing recipient field from silently crediting the wrong guest.

## Records

Application data is stored under Electron's per-user application-data directory:

- `shows/active-show.json` contains the current scored state.
- `shows/<show-id>.jsonl` is the append-only research ledger containing normalized and raw gift payloads.
- **Export CSV** creates a portable scored event table at a location you choose.

Intermediate streak updates remain in JSONL for diagnostics, but the visible ledger coalesces them with the final `repeatEnd` event so one sent gift appears once and is scored once.

## Tests and packaging

```powershell
npm test
npm run dist
```

The configured Windows build target is a portable executable. Code signing is not configured.

## Important limitations

- The integration is unofficial and does not provide guaranteed event completeness or uptime.
- Gift coin values depend on extended metadata. If TikTok rejects the metadata request, the app retries the connection in limited-metadata mode and records gifts with zero points until values are available.
- Review the connector's modified AGPL license before distributing this app or turning it into a hosted service.
