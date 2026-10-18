# Authentication and access control

web-colocation never handles passwords. For company use, put an authenticating proxy in front
of it — the Helm chart ships [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) as a
sidecar — and set `auth.mode: trusted-headers`. The app then reads who the user is from headers
the proxy adds.

## Modes

| `auth.mode` | Who can join | Names |
|---|---|---|
| `none` (default) | anyone who can open the page (plus room passcodes) | chosen in the lobby |
| `trusted-headers` | only users the proxy let through | from the SSO identity (✓ shown next to verified names) |

With `trusted-headers`, the app refuses to start unless it listens on a loopback address
(`HOST=127.0.0.1`), so nobody can bypass the proxy and send fake headers. The chart does this
for you. If your network guarantees that only the proxy can reach the app (e.g. a strict
NetworkPolicy), you can set `auth.allowNonLoopback: true`.

Headers read with `auth.preset: oauth2-proxy`: `X-Forwarded-Email`, `X-Forwarded-User`,
`X-Forwarded-Groups`, `X-Forwarded-Preferred-Username`. Other proxies: `preset: custom` and
`auth.headers.{email,user,groups,name}`. (Identity-Aware Proxy and ALB OIDC header verification
are on the [roadmap](roadmap.md).)

## oauth2-proxy with the Helm chart

```yaml
oauth2Proxy:
  enabled: true
  provider: google
  clientId: 1234567890-abc.apps.googleusercontent.com
  existingSecret: colo-oauth2
  emailDomains: [acme.example]
```

```bash
kubectl -n xr create secret generic colo-oauth2 \
  --from-literal=client-secret='<from your IdP>' \
  --from-literal=cookie-secret="$(openssl rand -hex 16)"
```

Register the redirect URI `https://<your host>/oauth2/callback` at your IdP (the chart derives it
from the ingress host; override with `oauth2Proxy.redirectUrl`).

| IdP | `provider` | Notes |
|---|---|---|
| Google Workspace | `google` | OAuth client of type "Web application"; restrict with `emailDomains` |
| Microsoft Entra ID | `entra-id` | `oidcIssuerUrl: https://login.microsoftonline.com/<tenant>/v2.0`; groups by object id via `allowedGroups` |
| Okta, Auth0, Keycloak, dex, … | `oidc` | `oidcIssuerUrl` of your issuer |

More settings: `oauth2Proxy.extraArgs` (any [oauth2-proxy flag](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview)).
Keep the default `--pass-user-headers`; do not add `--skip-auth-route` rules for app paths.

When the SSO session expires, the browser's WebSocket reconnects fail; the app notices (the API
starts redirecting to the login page) and reloads the page so the user can sign in again.

## Roles

Every participant is a **host** or a **member**:

- `auth.admins` (emails) are hosts in every room.
- `rooms.list[].hosts` (emails) are the hosts of that room.
- In rooms without configured hosts (including ad-hoc rooms) the **first person to join** is the
  host; when they leave, the next person who joined becomes host.

Hosts get **Room settings** and, depending on the room's `rules.permissions`, may be the only
ones allowed to clear boards, reset objects or change settings.

## Who may enter a room

```yaml
rooms:
  list:
    - id: leadership
      access:
        allowedDomains: [acme.example]
        allowedGroups: [xr-leads]          # values of X-Forwarded-Groups
        allowedUsers: [ceo@acme.example]
```

Any match lets the person in; no `access` block means everyone who passed the proxy. Rooms a
user cannot enter are hidden from their lobby. Changing access lists takes effect immediately —
people who are no longer allowed are removed from running rooms.

## Passcodes

Independent of SSO, a room can require a passcode (`passcodeHash`, generated with
`npm run hash-passcode`), and hosts can set or remove one in the app unless the config file
fixes it. Wrong attempts are rate limited per user (or per client IP; set
`server.trustForwardedFor: true` when a proxy that overwrites `X-Forwarded-For` sits in front).
Configured hosts and admins skip the passcode.
