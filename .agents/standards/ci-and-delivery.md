# OneDriveLive agent delivery standards

These rules are repository policy for automated development and production delivery.

## Required workflow

1. Reconcile the exact current `main` commit and live production lease before changing anything.
2. Develop on a bounded non-`work/**` branch.
3. Run the complete local or isolated-cloud preflight before the first GitHub push whenever the execution environment supports it.
4. Open one pull request after the branch is ready for review.
5. Treat pull-request CI as validation only.
6. Merge only an exact green head.
7. Deploy only through `.github/workflows/deploy-production.yml`, dispatched from `main` with:
   - the bounded request ID;
   - the exact current `main` SHA;
   - the exact opening Worker version ID;
   - the exact opening deployment ID.
8. Stop after the requested live acceptance boundary.

## Prohibitions

- MUST NOT use `.github/workflows/**` as a temporary program, patch transport, bootstrap payload, cleanup hook, or agent scratchpad.
- MUST NOT add request-specific opening leases, request IDs, tags, or executable repair code to `ci.yml`.
- MUST NOT push iterative experimental commits merely to obtain a GitHub-hosted test result when equivalent checks can run in the active development environment.
- MUST NOT deploy from pull-request CI.
- MUST NOT deploy automatically merely because `main` changed.
- MUST NOT weaken exact-main, opening-lease, binding, secret-surface, traffic, or health verification.
- MUST NOT modify application behavior during a CI-only repair.
- MUST NOT expose secrets, tokens, connector references, attachment URLs, prompts, source bytes, or complete provider responses in logs or artifacts.

## Stable CI contract

`ci.yml` may run for pull requests targeting `main` and for the final push to `main`. Superseded runs must be cancelled through workflow concurrency. Feature-branch push triggers are not permitted.

Changes to the validation or deployment workflows must describe a durable delivery-policy change, not a single operational request.
