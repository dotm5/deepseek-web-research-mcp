# Releasing

The npm name is `deepseek-web-research-mcp`. The unrelated `deepseek-search-mcp`
name was already registered when this project was prepared. Check ownership and
version availability immediately before publishing:

```sh
npm whoami
npm view deepseek-web-research-mcp name version maintainers --json
```

An npm 404 means the name was not found at query time; it does not reserve the name.
This directory is prepared for publication but does not imply registry publication.

1. Create the GitHub repository under the intended owner. Set real public metadata
   in package.json; do not publish placeholder repository links:

   ```sh
   npm pkg set repository.type=git repository.url=git+https://github.com/OWNER/REPO.git
   npm pkg set homepage=https://github.com/OWNER/REPO#readme bugs.url=https://github.com/OWNER/REPO/issues
   npm install --package-lock-only --ignore-scripts
   ```

   This project uses `npm-shrinkwrap.json` as its only dependency lock. npm updates
   it in place; do not introduce a second package-lock file.

2. Run the release gates and installation acceptance from a clean checkout:

   ```sh
   npm ci
   npm run release:check
   npm run test:install
   npm publish --dry-run --ignore-scripts
   ```

   The artifact allowlist is exactly CLI, package metadata, shrinkwrap, both READMEs,
   changelog and MIT license. Source/tests belong in GitHub, not in the npm package.
   Check the generated tarball under `.artifacts/`. No credential is needed for
   offline tests. For optional real login validation, pipe a temporary key from a
   secret manager into `node scripts/install-smoke.mjs --live`; it stays on stdin
   and in memory, uses an isolated OS-vault profile, makes two API calls, then logs out.

3. Run GitHub CI on Windows/macOS/Linux. Update CHANGELOG and tag the exact passing
   commit as `v0.4.1` (or update the version and regenerate the lock for a new release).
   Version and package identity come from package.json at build time.

4. For the initial npm release, use an authenticated maintainer account with npm's
   required 2FA and `npm publish --access public`. Do not put an npm token in this
   repository. After first publication, configure the package's Trusted Publisher:
   actual owner/repo, workflow `publish.yml`, environment `npm`. The included manual
   workflow verifies the tag and exact repository URL, re-runs checks and publishes
   with OIDC/provenance. It requires npm >=11.5.1 and a GitHub-hosted runner; the
   workflow installs current npm. Configure GitHub environment protection as desired.

5. After registry publication, use a fresh npm cache and the public package name to
   verify `npx --yes deepseek-web-research-mcp@0.4.1 --version`, `auth login`, `setup`
   and `doctor`. A local tarball install is not proof of registry visibility.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm package contents](https://docs.npmjs.com/cli/configuring-npm/package-json/).

Never commit raw model transcripts, local Agent configs, vault files, npmrc credentials,
machine-specific validation JSON or dependency folders. Sanitized validation summaries
may describe results without personal paths, key suffixes or private endpoint details.
