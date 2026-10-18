# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) ("Report a vulnerability" on the
Security tab) or contact a maintainer listed in [MAINTAINERS.md](MAINTAINERS.md).

Include what you found, how to reproduce it and the impact you expect. We aim to acknowledge
reports within 5 working days and to publish a fix and advisory as soon as possible.

## Supported versions

Security fixes go into the latest minor release. Container images and Helm charts are signed
with Sigstore (keyless); verify them before deploying:

```bash
cosign verify ghcr.io/OWNER/web-colocation:<version> \
  --certificate-identity-regexp 'https://github.com/OWNER/web-colocation/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## Hardening notes for operators

- Serve the app only over HTTPS and keep the oauth2-proxy sidecar (or another authenticating
  proxy) in front when `auth.mode: trusted-headers` is used; the app refuses to trust identity
  headers unless it listens on a loopback address.
- Switch `server.csp` to `enforce` once your browser console shows no violations.
- Give TURN a shared secret and deny relaying to private networks (see docs/turn.md).
- Keep `/data` on a volume that only the app can access; it contains room drawings and settings.
