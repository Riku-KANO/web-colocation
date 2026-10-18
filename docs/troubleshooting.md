# Troubleshooting

**"Enter AR / Enter VR" is greyed out.**
The page is not secure (WebXR needs HTTPS or `localhost`), the browser has no WebXR (desktop
Chrome has no immersive modes without a headset — use `&emulate=quest3`), or the device does not
support that mode (Vision Pro: VR only).

**The headset says the certificate is invalid.**
`npm run dev:https` uses a self-signed certificate; accept the warning once. In production use a
real certificate at the load balancer.

**Android XR: nothing appears / permission prompt.**
Chrome on Android XR asks for "3D mapping / camera tracking" per site. Allow it in the site settings.

**People in the same room see the table in different places.**
Everyone must touch the *same* two points in the *same order* with "Same room (2 pts)". Use points
at least 1 m apart. Re-calibrate after the headset lost tracking for a long time.

**Connection drops every 30 or 60 seconds.**
The load balancer closes idle WebSockets. ALB: `idle_timeout.timeout_seconds=3600`. GKE:
`gke.backendConfig.enabled: true`. Gateway API: raise the implementation's request/idle timeouts.

**"connecting…" forever behind SSO.**
The SSO session expired — the app reloads to sign in again. If it loops, check the oauth2-proxy
logs (cookie secret, redirect URL, allowed email domains) and that health checks use `/ping`.

**Voice: people can see each other but not hear.**
Direct connections are blocked; configure TURN ([turn.md](turn.md)). Microphones need HTTPS and
permission; the HUD shows "voice failed" per person when a connection fails.

**A 3D model shows as a red box.**
It failed to load: check the browser console. Common causes: not under `/room-assets/` or an
allowed origin, larger than `assets.maxModelBytes`, too many triangles, textures above 4096 px,
or blocked by the Content-Security-Policy (add the origin to `assets.allowedOrigins`).

**Controller models do not appear (closed network).**
They are loaded from jsDelivr. Self-host them and set `xr.inputProfilesPath`, or set it to `none`.

**CSP violations in the console.**
`server.csp` is `report-only` by default: nothing is blocked yet. Add missing origins (models,
logo) to the config, then switch to `enforce`.

**"The room is full."**
`rules.maxParticipants` or the number of seats in the template limits the room.

**The server does not start: "invalid configuration".**
The message shows the path of the wrong option. `npm run gen:schema` and the
`yaml-language-server` schema comment give you validation in your editor.

**"storage.dir … is not usable".**
Mount a writable volume at `storage.dir` (owned by uid 1000), or use `storage.driver: memory`.
