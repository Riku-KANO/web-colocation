# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Health/readiness on a separate port, Prometheus metrics, JSON logs, Content-Security-Policy.
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
