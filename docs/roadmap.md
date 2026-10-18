# Roadmap

Ideas and planned work, roughly in priority order. Discussion and help welcome in issues.

## Next (v0.3)

- **In-app room editor** — hosts move tables, boards and objects in 3D and save the layout as a
  template (the settings/persistence groundwork exists).
- **Whiteboard tools** — undo, eraser, sticky notes, images/PDF pages, export as PNG/PDF.
- **Identity-Aware Proxy / ALB OIDC** — verify the signed JWT headers of GKE IAP and AWS ALB so
  they can be used without oauth2-proxy.
- **Calibration** — restore the previous calibration with Quest persistent anchors; least-squares
  alignment with 3+ points; a visual check of the alignment error.

## Later

- **Multiple replicas** — Redis backplane (room ownership leases + pub/sub) for high availability.
- **Hand avatars** — compressed hand-joint streaming and hand meshes for remote participants.
- **Recording and meeting notes** — snapshots of boards and objects over time.
- **Android XR native client** — Jetpack XR client speaking the same [protocol](protocol.md).
- **Meta "shared" spaces** — use Quest's experimental WebXR shared reference space when available.
- **TURN chart** — optional STUNner/coturn deployment from the Helm chart.

## Not planned

- Video conferencing (use your existing tool next to it).
- Storing passwords or acting as an identity provider.
