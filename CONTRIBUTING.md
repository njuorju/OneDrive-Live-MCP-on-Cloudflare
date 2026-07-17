# Contributing

1. Create a branch.
2. Install dependencies with `npm ci`.
3. Make focused changes.
4. Run `npm run check`.
5. Do not include real Worker URLs, Microsoft IDs, folder names, tokens, cookies, OAuth URLs, or document contents in commits, fixtures, screenshots, or issues.
6. Preserve the read-only tool annotations and allowed-root checks unless the change explicitly redesigns the security model.

Pull requests that modify OAuth, token storage, path checks, or write permissions should include targeted tests and a security rationale.
