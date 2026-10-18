# Contributing

Thanks for helping! Bug reports, ideas, docs and code are all welcome.

## Development setup

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit + integration tests
npm run typecheck
npm run test:e2e     # browser tests (first run: npx playwright install chromium)
```

Without a headset, add `&emulate=quest3` to the URL to use the WebXR emulator.
Kubernetes changes: `scripts/kind-smoke.sh` (needs Docker, kind, kubectl and Helm).

## Pull requests

1. Open an issue first for larger changes so we can agree on the approach.
2. Keep changes focused; include tests for behaviour changes (`test/`).
3. Run `npm run typecheck && npm test` before pushing. CI also runs the browser and kind tests.
4. If you change the config schema, run `npm run gen` and commit the regenerated
   `schema/config.schema.json`, `deploy/helm/web-colocation/values.schema.json` and
   `docs/configuration-reference.md`.
5. User-facing text goes through `src/i18n/` — add English and Japanese strings.
6. Protocol changes must bump `PROTOCOL_VERSION` and update [docs/protocol.md](docs/protocol.md).

## Developer Certificate of Origin

We use the [DCO](https://developercertificate.org/) instead of a CLA. Sign off every commit to
certify that you wrote it or have the right to submit it under the project's license:

```bash
git commit -s -m "Fix stroke smoothing"
```

This adds `Signed-off-by: Your Name <you@example.com>`.

## Code style

- TypeScript, strict mode; the server runs with Node's type stripping, so only erasable syntax
  (no `enum`, no parameter properties).
- Comments explain *why*; keep them short. English for code and comments.
- Prefer small, pure functions for anything testable (math, validation, permissions).

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
