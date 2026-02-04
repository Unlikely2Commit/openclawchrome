# Privacy Policy — OpenClaw Chrome Extension

Last updated: 2026-02-04

## Summary
OpenClaw Chrome Extension connects your Chrome browser to an OpenClaw relay so an agent can **observe** activity in tabs you explicitly attach and (only if you enable it) **perform actions** (click/type/navigate/scroll) on allowed domains.

## Data we collect
The extension may collect and transmit the following data **only for tabs you attach**:
- Page URL and title
- Limited interaction events (click/input/scroll/navigation)
- Action audit log (what action was requested and when)

The extension stores locally in your browser:
- A pairing/connection token (to authenticate to your relay)
- Your settings (Allow Actions toggle, domain allowlist)
- The local audit log

## Data we do not intentionally collect
- We do not intentionally collect passwords.
- We do not intentionally collect payment card details.
- We do not read your entire browsing history.

## How data is used
Data is used only to:
- Connect your extension to your relay
- Stream observations to your OpenClaw agent
- Execute actions when you explicitly allow actions and the domain is allowed

## Data sharing
Data is sent to the relay server you configure (your EC2 / server). We do not sell data to third parties.

## Security controls
- Observe-only by default
- “Allow Actions” must be explicitly enabled
- Per-domain allowlist controls where actions can run
- Actions are recorded in an audit log

## Contact
If you have questions, open an issue in the repository:
https://github.com/Unlikely2Commit/openclawchrome
