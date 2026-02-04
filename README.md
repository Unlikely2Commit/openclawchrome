# OpenClaw Chrome Extension + Relay (MV3)

Monorepo:
- `packages/extension`: Chrome MV3 extension (TypeScript, esbuild)
- `packages/relay`: Minimal Node relay server (Express + ws) suitable for EC2
- `packages/shared`: Shared TypeScript message schema

## Phase status
- Phase 0: repo + buildable extension skeleton ✅
- Phase 1: WS connect + device-code pairing ✅
- Phase 2: attach tab + observe events ✅ (click/input/scroll/navigation)
- Phase 3: actions (click/type/navigate/scroll) + open new tabs ✅
- Phase 4: safety toggles + domain allowlist + audit log ✅
- Phase 5: manual test plan + docs ✅

## Prereqs
- Node 20+ (tested with Node 22)

## Install
From repo root:

```bash
npm install
npm run build
```

## Run relay (local or EC2)

```bash
cd packages/relay
npm run build
PORT=8787 HOST=0.0.0.0 npm start
```

Relay endpoints:
- Pairing request: `POST /pair/request` body `{ "clientId": "..." }`
- Verify (human): `GET /pair/verify` (enter code)
- Poll: `GET /pair/poll?clientId=...&deviceCode=...`
- WebSocket: `ws://<host>:8787/ws?token=...&client=extension|agent&clientId=...`

Agent simulator:
- `POST /agent/send?token=...` body `{ "msg": { ... } }`

## Load extension in Chrome
1. Build it:
   ```bash
   cd packages/extension
   npm run build
   ```
2. Go to `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked**
5. Select: `packages/extension/dist`

## Pair and connect
1. Open the extension popup.
2. Set **Relay HTTP Base URL** to e.g. `http://<ec2-host>:8787`
3. Click **Pair**.
4. Open the verification URL shown and enter the user code.
5. Back in the extension popup: click **Connect WS**.

## Attach a tab and observe
1. Navigate to a page.
2. Click **Attach current tab**.
3. (Optional) Connect an agent client to relay and receive `tab_event` messages.

## Actions safety model
- Default is **observe-only**.
- To run actions, user must:
  1) Enable **Allow Actions** in popup
  2) Add the tab's hostname to **Domain allowlist**

Actions supported:
- click (CSS selector)
- type (CSS selector + text)
- scroll (x/y)
- navigate (url)
- open new tab (url) (requires Allow Actions + allowlist match)

## Manual end-to-end test plan

### A) Relay
- Start relay on port 8787
- Visit `http://localhost:8787/` → should show "OpenClaw Relay running."

### B) Pairing
- Load extension
- Enter relay base url
- Click Pair
- Visit verification page, enter code
- Extension should store token and show "Paired. Click Connect WS."

### C) WebSocket connection
- Click Connect WS
- Badge should show `ON` (or `ON*` if Allow Actions enabled)

### D) Attach tab + observe
- Attach current tab
- Click around / type → events should be sent to agent side

### E) Actions
- Put `example.com` in allowlist (matching your test site hostname)
- Enable Allow Actions
- Use agent simulator to send actions:

```bash
TOKEN=... # from pairing
curl -sS -X POST "http://localhost:8787/agent/send?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"msg":{"t":"action_request","requestId":"r1","tabId":123,"action":"scroll","x":0,"y":800}}'
```

Open tab:
```bash
curl -sS -X POST "http://localhost:8787/agent/send?token=$TOKEN" \
  -H 'content-type: application/json' \
  -d '{"msg":{"t":"open_tab_request","requestId":"r2","url":"https://example.com","attach":true}}'
```

### F) Audit log
- Confirm actions and blocks appear in popup audit log.

## EC2 notes / blockers
- For raw EC2 host, you can run without TLS using `http://` and `ws://`.
- If you later need TLS/WSS (Chrome on some networks, corporate proxies), put Nginx/ALB in front.
- Required inbound security group: TCP 8787 from your IP(s).

