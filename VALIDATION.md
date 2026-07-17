# Validation

Validated in a clean Linux build environment on 2026-07-17:

- `npm ci` completed from the committed lockfile.
- `npm run type-check` passed.
- `npm test` passed: 24 tests across OAuth-state and CSRF suites.
- `npm audit --audit-level=high` reported zero vulnerabilities.
- `wrangler deploy --dry-run` bundled successfully with placeholder values replaced in a temporary copy.
- The dry-run recognized both Durable Objects, KV, Workers AI, and all tracked environment variables.
- Repository scan found no original account ID, KV namespace ID, Worker hostname, folder name, email address, patch archive, backup directory, `.wrangler` state, or `node_modules` intended for publication.

Not performed because it requires the repository owner’s accounts and interactive consent:

- live Cloudflare deployment;
- Microsoft Entra authorization;
- ChatGPT connector registration;
- live Microsoft Graph search and document read.

Those acceptance steps are documented in `docs/DEPLOYMENT.md`.
