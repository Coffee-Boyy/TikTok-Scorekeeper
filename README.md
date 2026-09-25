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
3. Use the **⋯** tools menu in the title bar for guest refresh, the OBS overlay URL, settings, and CSV export.
4. Copy the OBS overlay URL from the tools menu (or Ctrl+Shift+O) and add it as a 1920×1080 Browser Source.

Open **⋯ → Settings** (or Ctrl+,) to use the Connection, Gifts, Guest names, Ranking, and Routing tabs. Configure auto-connect on launch, reconnect after a dropped gift connection, the minimum gift value shown in the event list, and an optional Ding, Chime, or Pop sound for completed gifts. Preview sounds in the Gifts tab. Gifts below the display threshold stay silent but continue to count toward scores. Gift routing rules save as soon as they are added or removed.

The Connection tab accepts an optional Euler Stream API key for the standalone gift listener. The key is encrypted with the operating system's secure storage and kept outside `settings.json`. Leave the field blank to retain the saved key, or select **Remove saved API key** to return to community signing limits. A changed key takes effect on the next connection attempt; an in-progress retry starts again immediately. The app also saves a signing-service rate-limit cooldown across restarts and waits until the service's retry time before requesting another connection. During development, file changes no longer automatically reload or restart the app, avoiding blank windows and unnecessary signing requests. Restart manually to load code changes.

Settings also let you assign short names to discovered guests and design a ranking comment. The comment template uses `{rankings}`; the guest entry template supports `{name}`, `{score}`, and `{rank}`. The separator joins entries. A live preview shows the current scores, with large scores abbreviated as `k` or `m`. Guest aliases only affect this comment format, not the scoreboard or gift attribution. These settings are saved between launches.

Use **Scoreboard → ⋯ → Copy formatted ranking comment** to copy the current guest ranking with your saved names and comment format.

The overlay is served only on the local machine at `http://127.0.0.1:17342/overlay`.

## Multi-guest attribution

TikTok gift payloads are not consistent across standard LIVE, multi-guest, and battle modes. The app checks known recipient fields such as `receiverUserId`, `recipientUserId`, `toUserId`, `toMemberId`, and nested recipient objects.

Initial guest discovery uses TikTok's `/webcast/room/enter/` response. The app observes the signed request through Electron's session network hooks, then reads its response using the same TikTok session. It also checks `/webcast/room/info/` and TikTok's multi-guest backup endpoint while discovering guests. The receiver retries transient navigation and capture failures and displays sign-in only if TikTok requires it. Login cookies stay in the persistent, sandboxed receiver session and are never copied into the scorekeeper database. The app reads cohost and multi-guest linked users, Group LIVE members, and battle participants, then merges later link-layer and group-change events from the standalone webcast connection. If TikTok provides no guest roster, the browser retries discovery while gift listening continues independently.

Gift and link events use a standalone `tiktok-live-connector` WebSocket in the app's main process. It starts from the host username before guest discovery, resolves the room independently, and reconnects if the WebSocket drops. It does not need the discovery browser to open or remain available. The connector uses EulerStream's default signing service to establish this public, unauthenticated WebSocket; the app does not send TikTok login cookies to that service or require an API key.

If the gift connection drops or a connection attempt times out, the app shows a prominent reconnect notice and retries with bounded exponential backoff (respecting signing-service rate limits). Once restored, it refreshes the guest roster and warns that events during the outage may have been missed. The **Disconnect** button works while connecting or retrying. If the LIVE ends, the username is rejected, or gift data cannot be saved, tracking stops and the app shows an actionable error; use **Connect** to retry. Guest discovery retries transient failures, then closes its receiver and reports when manual refresh or sign-in is needed. Closing the guest discovery window does not stop gift tracking.

- A confident ID or handle match is assigned automatically.
- A Group LIVE gift can auto-add its `toMemberId` / `toMemberNickname` recipient when the room roster is not available yet.
- A show with one participant assigns gifts to that participant.
- In a multi-guest show, the host is omitted from the scoreboard, recipient choices, and overlay; gifts directed to the host remain **Unassigned**.
- Ambiguous gifts in a multi-participant show remain **Unassigned**.
- Use the recipient dropdown in the ledger to correct or assign an event.
- Click a guest's scoreboard card to make them the active dancer. New gifts that would otherwise be unassigned are credited to that guest while their card is selected. The card is highlighted and labeled **Active dancer**; click it again to stop. Gifts with known recipients and gift routing rules retain their usual attribution. Existing gifts are not changed.
- Select rows using their checkboxes, click a row, or Shift-click a range, then choose a recipient in the bulk toolbar to assign up to 300 displayed events at once. The header checkbox selects all displayed rows.
- Gifts that arrive while the app is hidden or unfocused remain highlighted when you return. Use the **Missed** filter to inspect them and **Mark missed as seen** to clear the highlights.

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

The [Windows build workflow](.github/workflows/build-windows.yml) runs on pushes to `main`, pull requests, and manual dispatch. It installs dependencies from `package-lock.json`, runs the tests, packages the x64 portable `.exe`, verifies the output, and uploads it as the `TikTok-Scorekeeper-Windows-x64` artifact. To download it, open the repository's **Actions** tab, select a successful **Build Windows executable** run, and download the artifact at the bottom of the run page. Extract the artifact ZIP and run the `.exe`; installation is not required. The executable is unsigned, so Windows may show a publisher warning.

## Important limitations

- The integration is unofficial and does not provide guaranteed event completeness or uptime.
- Gift coin values depend on extended metadata. If TikTok rejects the metadata request, the app retries the connection in limited-metadata mode and records gifts with zero points until values are available.
- Review the connector's modified AGPL license before distributing this app or turning it into a hosted service.
