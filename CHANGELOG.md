# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- Passcode attempts are counted before they are checked, so parallel guesses no longer slip past
  the limit; passcode hashing work is capped.
- Rate limiting uses the client address added by trusted proxies (`server.trustedProxyHops`,
  examples for ALB and Google Cloud) instead of the client-controlled left end of
  `X-Forwarded-For`; IPv6 clients are grouped by /64. `server.trustForwardedFor` is deprecated.
- A full whiteboard can no longer make a room unjoinable: stroke points are quantized and the
  per-room budget keeps the snapshot well below the send buffer cap. A process-wide budget
  (`server.maxStrokePoints`) bounds whiteboard memory across rooms.
- In rooms from the configuration, first-joiner hosts can no longer set a passcode or title, and
  their changes are not saved. Settings saved for an ad-hoc id are ignored once the id is configured.
- Refused joins no longer leave empty rooms in memory; settings changes are throttled; sockets
  that never join are closed after 10 s; unknown WebSocket upgrades are closed.
- "Verified" (✓) is shown only for names that come from the identity provider. Control and bidi
  characters are removed from names, titles and room ids.
- Domain allow lists use the part after the last `@`.
- `trusted-headers` on a non-loopback address is refused on config reload and in the Vite dev
  server, not only at startup.
- An unreadable asset file no longer crashes the server. Every `/room-assets/` response is
  sandboxed with CSP.
- CSP is enforced by default and allows `blob:`/`data:` for embedded glTF data; pages send
  `X-Frame-Options: SAMEORIGIN`. `/metrics` is served only on the health port when one is set.
- Model loading checks redirects and every file a model refers to against the allowed origins, and
  checks declared triangles, compressed sizes and embedded image dimensions before decoding.
- The client no longer honours `?server=` when `/api/config` is unreachable.
- Helm: `oauth2Proxy.emailDomains` no longer defaults to `*`; `emailDomains` or `allowedGroups`
  is required.
- Compose demos publish ports on localhost only; the TURN deny list covers CGNAT, loopback,
  multicast and IPv6 private ranges. `hash-passcode` prompts without echoing.
- Dependabot also tracks the chart's and compose files' images.

### Fixed
- Browser E2E tests close their pages after each test, so CI runners without a GPU no longer time
  out on the XR test.

## [0.2.0] - 2026-10-18

### Added
- Room configuration: YAML/JSON config with schema validation, live reload, JSON Schema export.
- Room templates with inheritance; built-in `standard`, `round-table`, `workshop`, `presentation`.
- Custom glTF/GLB models with size, triangle and texture limits.
- Branded lobby (logo, product name, message, room list), English and Japanese UI.
- Host role, host-only permissions and an in-app Room settings dialog; passcodes (scrypt).
- SSO via trusted proxy headers (oauth2-proxy), per-room allow lists, admins.
- TURN REST credentials issued after joining and refreshed before expiry.
- File persistence of room state; graceful shutdown with state restore.
- Health/readiness on a separate port, Prometheus metrics (incl. CPU, memory, event-loop lag),
  JSON logs, Content-Security-Policy.
- `scripts/loadtest.ts` and measured capacity (800 participants on one process, see
  docs/operations.md); browser E2E tests (Playwright + WebXR emulator); kind end-to-end script.
- Container image, Helm chart (Ingress, Gateway API, GKE BackendConfig, oauth2-proxy native
  sidecar, NetworkPolicy), docker compose quick start with TURN and SSO demos.
- Protocol v3: room config in `welcome`, `config` reconfiguration with epochs, `ice`, error codes.

### Changed
- Layout constants replaced by the room configuration; multiple whiteboards per room.
- ICE servers come from the server at runtime (`VITE_ICE_SERVERS` removed).

### Fixed
- Server crash on malformed URL escapes (`GET /%`).
- Seats no longer wrap around (rooms are full when every seat is taken).

## [0.1.0] - 2026-10-18

- First prototype: shared objects, pens and whiteboards, avatars, 1/2-point calibration,
  WebRTC voice, WebXR emulator support.
