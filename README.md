# .github
This repo is used to store custom GitHub actions and workflows used in the PVDTS organization.

For information on how we manage pipeline environments, see our [Deployment Status Specification](DEPLOYMENT_STATUSES.md).

## Workflow API rate limits

PVDTS Build All run 91 (2026-11-23, run ID 45283454875) exhausted the shared
PAT user's API quota: both Oracle tagging and build dispatches received HTTP 403.
Creating another PAT for the same user does not isolate that quota.

`Run-Workflow` now uses its explicit token input (the previous implementation
used ambient `GH_TOKEN` instead), dispatches directly to the REST endpoint, and
polls every 60 seconds by default. It discovers matching dispatch runs across
pages, then polls only the selected run ID using conditional requests.
This removes workflow-resolution requests from `gh workflow run`/`gh run list`
and halves the default polling frequency. HTTP 403/429 rate-limit responses
honor `Retry-After` and `x-ratelimit-reset`, with exponential secondary-limit
backoff and at most three retries. Ordinary permission errors fail immediately.
Transport errors and server errors are not retried to avoid duplicate dispatches.

`goal: start` means dispatch only. `complete` accepts any completed conclusion;
`success` now **fails the caller when the child fails**, rather than silently
continuing or waiting indefinitely. The total deadline includes backoff
(default 45 minutes, maximum 55). Expiry fails the caller without cancelling the
child; inspect the child before redispatching. Increase `poll_interval_seconds`
for longer builds (minimum 30); split waits longer than 55 minutes into separate
jobs with fresh credentials. Use a unique `wait_name_filter` passed into the
child's run-name, such as `buildall.<run_number>.<run_attempt>`. Concurrent,
indistinguishable runs fail correlation explicitly instead of choosing the latest.

### GitHub App rollout (administrator prerequisite)

No automation App or credentials have been confirmed. This session cannot list
repository Actions secrets/variables or organization App installations: those
metadata endpoints return `Resource not accessible by integration` (HTTP 403).
That is a session-access restriction, not evidence that configuration is absent,
and is distinct from run 91's rate-limit errors.

An administrator must verify or create a GitHub App installed on
`CDCR-OMS-PVDTS`, approve its repository permissions, and include every target
repository. Store its ID as `PVDTS_AUTOMATION_APP_ID` (Actions variable) and
private key as `PVDTS_AUTOMATION_APP_PRIVATE_KEY` (Actions secret), allowing the
**caller repositories** to read them. These are proposed names, not confirmed
existing settings. Do not put a token in a job output or reuse it across jobs.

Required repository permissions depend on the operation:

| Operation | App repository permission |
| --- | --- |
| Dispatch and inspect workflow runs | Actions: write |
| Read refs/commits, authenticated Git checkout | Contents: read |
| Push Oracle tags or publish releases | Contents: write |
| Read deployments/statuses | Deployments: read |
| Create deployments/statuses, Set-Prod-Version | Deployments: write |
| Repository discovery | Metadata: read (automatic); installation must include all enrolled repos |

`Workflows: write` is **not** required just to dispatch a workflow; it is for
editing workflow files. Caller `permissions:` controls `GITHUB_TOKEN`, not the
App token. The built-in token cannot access other private repositories.
Private shared-action access must also be allowed in this repository's Actions
settings; an App input does not authorize downloading the action itself.

After publishing an approved new immutable action version (or using the reviewed
commit SHA), migrate each caller in a separate change:

```yaml
- uses: CDCR-OMS-PVDTS/.github/.github/actions/Run-Workflow@<reviewed-commit-SHA>
  with:
    repo: CDCR-OMS-PVDTS/PVDTS-server-treatment
    workflow: A-MT2-DEV-Build-Deploy-Backend.yml
    ref: rc.319
    goal: success
    app_id: ${{ vars.PVDTS_AUTOMATION_APP_ID }}
    app_private_key: ${{ secrets.PVDTS_AUTOMATION_APP_PRIVATE_KEY }}
    wait_name_filter: buildall.${{ github.run_number }}.${{ github.run_attempt }}
    field1: deploy=false
    field2: additional_tag=buildall.${{ github.run_number }}.${{ github.run_attempt }}
```

The action creates a fresh installation token restricted to the single target
repository and `Actions: write`, then revokes it at job completion. Credentials
are mutually exclusive with `access_token`; minting errors never fall back to
the PAT. Existing PAT callers remain supported only when `access_token` is
explicitly supplied. Installation tokens expire after one hour; the maximum
55-minute deadline leaves a margin but does not refresh a token supplied by a
caller. Mint explicit tokens immediately before using them.

For shared actions that use `gh api`, mint a per-job token with
`actions/create-github-app-token@v2`, explicit `owner`, `repositories` and only
the operation's `permission-*` inputs from the table, then set
`GH_TOKEN: ${{ steps.<token-step>.outputs.token }}` on the consuming step.
Do not grant deployment or contents write access to dispatch-only tokens.
Verify access with read-only calls to the actual target workflow/ref/deployment
before enabling writes. Test App minting, a harmless dispatch and completion,
and cleanup in an administrator-approved test repository; offline tests do not
verify installation settings.

### Remaining callers and API hotspots

Merging this repository alone does **not** update PVDTS's pinned
`RunWorkflow.v.1.2.0` or `SetGitTag.v.1.0` references. Do not move existing tags.
PVDTS Build All, release-candidate, release and hotfix need new action references
and per-job credentials; their repository-discovery and inline API scripts must
also stop using the shared PAT. Repository discovery currently uses
`gh repo list` (GraphQL); restrict discovery to the verified installation scope,
or maintain the enrolled repository list in configuration.

PVDTS PR #38 removes REST calls for its Oracle tagging path via authenticated
Git. The legacy shared `Set-Git-Tag` still makes up to five API requests and
treats lookup errors as absent refs, so avoid that action in the rollout and
adopt PR #38's Git approach. Deployment actions use `gh api` with generic retries,
not polling: `Get-Deployment` fetches one list plus statuses for every returned
deployment (up to 31 requests per invocation). Prefer ID/ref/environment-scoped
lookups; the existing full `Deployments` output requires that fan-out.
`Create-Deployment`, `Set-Deployment-Status`, and `Set-Prod-Version` also share
the ambient credential and must receive an appropriately scoped job token.
Their generic retries are not made rate-aware by this dispatch-action change.
`Resolve-Harbor-Artifact` calls Harbor, not the GitHub API. The existing sandbox
workflow intentionally does nothing and is unchanged.

App tokens isolate automation from the PAT user's quota, **not** from other
jobs using the same App installation. The documented baseline is 5,000 REST
requests/hour per installation (15,000 for Enterprise Cloud; otherwise scaling
is capped at 12,500). This organization's plan and actual quota are unverified.
GraphQL and secondary limits still apply. Monitor actual response headers;
`debug: true` logs quota/reset headers without credentials or input values.
Limit caller matrix concurrency where needed rather than minting more tokens
to try to evade the installation's shared quota.

References: [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[installation token action](https://github.com/actions/create-github-app-token),
[workflow dispatch permissions](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).

Run the credential-free regression tests with:

```sh
node --test .github/actions/Run-Workflow/run-workflow.test.cjs
```