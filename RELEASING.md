# Publishing and releasing

## Before the first public release

1. **Create the GitHub repository** and push `main`.
2. **Replace the `OWNER` placeholder** with your GitHub organization or user (lower case for
   container registries is handled by the release workflow):

   ```bash
   grep -rl --exclude-dir={node_modules,.git,.github} 'OWNER/' . | xargs sed -i.bak 's#OWNER/#your-org/#g'
   find . -name '*.bak' -not -path './node_modules/*' -delete
   npm run gen   # regenerates schema/config.schema.json with the new $id
   ```

   The release workflow also rewrites the chart's image repository at packaging time, so the
   chart always points at the image built from the same tag.
3. **Fill in [MAINTAINERS.md](MAINTAINERS.md)** and check the contact line in
   [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
4. **Repository settings**
   - Security → enable *Private vulnerability reporting* and *Dependabot alerts*.
   - Branches → protect `main` (require the CI checks, require signed-off commits via the DCO app).
   - Actions → allow GitHub Actions to create packages.
5. After the first release, make the GHCR packages `web-colocation` and `charts/web-colocation`
   **public** (Packages → Package settings → Change visibility).
6. Optional: add the chart to [Artifact Hub](https://artifacthub.io/) (OCI repository
   `oci://ghcr.io/<owner>/charts/web-colocation`).

## Cutting a release

1. Make sure CI is green on `main`.
2. Update [CHANGELOG.md](CHANGELOG.md): move items from *Unreleased* to a new version section.
3. Bump `version` in `package.json` and `version` / `appVersion` in
   `deploy/helm/web-colocation/Chart.yaml`.
4. Tag and push:

   ```bash
   git tag -s v0.2.0 -m "v0.2.0"
   git push origin v0.2.0
   ```

The [release workflow](.github/workflows/release.yml) then:

- builds the image for `linux/amd64` and `linux/arm64`, pushes
  `ghcr.io/<owner>/web-colocation:<version>` and `:<major>.<minor>` with SBOM and provenance
  attestations, and signs it with cosign (keyless);
- packages the chart and pushes it to `oci://ghcr.io/<owner>/charts`, signed;
- creates a GitHub release with the changelog section.

## Verifying a release

```bash
cosign verify ghcr.io/<owner>/web-colocation:<version> \
  --certificate-identity-regexp 'https://github.com/<owner>/web-colocation/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
helm install colo oci://ghcr.io/<owner>/charts/web-colocation --version <version> --dry-run
```
