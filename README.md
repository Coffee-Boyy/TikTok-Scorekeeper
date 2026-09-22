# TikTok LIVE Scorekeeper

A local-first Electron research app that listens for TikTok LIVE gift events, records a raw JSONL ledger, scores completed gifts, attributes gifts to multiple guests when recipient metadata is available, and supplies a local OBS scoreboard overlay.

> TikTok does not provide a public official LIVE gift API. This app observes TikTok's own web receiver and uses the unofficial `tiktok-live-connector` protobuf schema locally, so it may need maintenance when TikTok changes its Webcast protocol.

## Run it

Requires Node.js 20 or newer.

```powershell
npm install
npm start
```

In the app:

1. Enter the host's TikTok username in the title bar and click **Connect** after the host is live. The button switches to **Disconnect** while connected. A new show starts for that stream session, and later segments of the same session stay in the show. A muted TikTok receiver runs hidden; it appears only when TikTok requires sign-in or other attention, then hides again after discovery. Discovery progress appears in the bottom status bar.
2. The app imports cohosts, multi-guests, and battle participants from TikTok's room snapshot and continues merging link-layer updates automatically.
3. Use the **⋯** tools menu in the title bar (or Ctrl+Shift+G) to **Simulate gift** and test scoring without a live stream. The same menu holds guest refresh, the OBS overlay URL, and CSV export.
4. Copy the OBS overlay URL from the tools menu (or Ctrl+Shift+O) and add it as a 1920×1080 Browser Source.

The overlay is served only on the local machine at `http://127.0.0.1:17342/overlay`.

## Multi-guest attribution

TikTok gift payloads are not consistent across standard LIVE, multi-guest, and battle modes. The app checks known recipient fields such as `receiverUserId`, `recipientUserId`, `toUserId`, `toMemberId`, and nested recipient objects.

Initial guest discovery uses TikTok's authenticated `/webcast/room/enter/` response when available and falls back to the current page bootstrap used by newer LIVE pages. The connection flow retries transient navigation and capture failures, distinguishes offline streams from authentication, and displays the login page only when the saved session is missing or rejected. Login cookies stay in the persistent, sandboxed receiver session and are never copied into the scorekeeper database. The app reads cohost and multi-guest `linked_users` arrays, Group LIVE `group_live_members`, and battle participants, then merges later `LinkLayer`, `LinkState`, `LinkMic`, and battle events from the webcast connection.

Gift and link events are read from TikTok's WebSocket inside that hidden session and decoded locally. No EulerStream API key, paid signing endpoint, or remote signature service is used.

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
