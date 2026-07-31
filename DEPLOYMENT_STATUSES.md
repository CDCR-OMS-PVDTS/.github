# CI/CD Standard: GitHub Deployment Status Mapping

This document establishes the semantic definitions, automation behaviors, and integration patterns for GitHub Deployment Statuses across our engineering pipelines. Follow this guide to maintain consistent metrics, dashboards, and automated safety gates.

## Status Dictionary & System Behavior

Note that while this list is from GitHub documentation, these definitions are not officially documented; they are extracted from industry common practices with AI assistance. The section below the list distintuishes a few actual functional differences between them.

| Status String | Team/Operational Meaning | Automated GitHub Behavior & Protection Rules |
| :--- | :--- | :--- |
| `queued` | Pipeline is initiated but waiting for an available CI/CD runner slot or resource. | Displays a gray waiting icon on the GitHub Environment dashboard. Does not affect branch blocks. |
| `pending` | The deployment is temporarily blocked, waiting on a manual review, Slack approval, or timing gate. | **Explicit Management:** Reflects a "waiting" state visually in the UI timeline. Does *not* pause your custom scripts. <br>**Native Actions:** Automatically pauses pipelines and prompts designated reviewers if using GitHub Environment protection rules. |
| `in_progress` | The automated runner or cloud orchestrator is actively executing deployment scripts. | Displays an active loading spinner in the UI. If concurrency limits are set, locks the environment to prevent race conditions. |
| `success` | Infrastructure changes completed successfully and passed immediate health checks. | Turns the PR merge state green. **Lifecycle Behavior:** Automatically sets older active deployments in this environment to `inactive`. |
| `failure` | The pipeline completed its execution framework, but the release application or validation code failed (e.g., exit code 1). | **Branch Protection:** Soft or hard blocks the Pull Request from being merged if the check is marked as required. |
| `error` | The pipeline infrastructure itself crashed, lost cloud credentials, or timed out before completion. | **Branch Protection:** Blocks PR merge. Signals to DevOps that the infrastructure, not the code change, requires triage. |
| `inactive` | The target environment has been torn down, or has been superseded by a newer successful deployment. | **UI Change:** Shows as "destroyed" if the environment is transient (e.g., PR previews). **Automation:** Suppresses subsequent `deployment_status` webhooks. |

## Explicit Custom Pipeline Rules

### 1. State Progressions
Explicitly update statuses sequentially to ensure clear timelines and audit trails:
* **Happy Path:** `queued` ➔ `pending` (wait for human) ➔ `in_progress` ➔ `success`
* **Failure Path:** `queued` ➔ `in_progress` ➔ `failure` / `error`

### 2. The Custom "Pending" Pattern
If you manage deployment workflows via external scripts or orchestrators instead of native GitHub Environment Gates, setting the state to `pending` **will not automatically halt execution**. The API updates the GitHub UI but passes control back to your script immediately.

When implementing custom interactive gates (e.g., Slack confirmation buttons or external control portals):
* **Order of Operations:** Dispatch the `pending` status payload to GitHub *immediately before* executing your script's internal pause or sleep loop.
* **Why This Matters:** This pattern communicates intent clearly to the development team on the Pull Request timeline, ensures deployment duration metrics do not include idle human wait times, and fires downstream `deployment_status` webhooks to notify external auditing tools.

### 3. Ensuring Finality
Never leave a deployment hanging in `in_progress`. Always wrap your deployment pipeline logic in a global `try/catch` or `always()` block. If a pipeline crashes or a human abandons a gate, ensure a terminal status (`success`, `failure`, or `error`) is dispatched to release environment UI locks.

### 4. Transient Environment Cleanup
When an ephemeral preview environment is destroyed (e.g., when a temporary feature branch Pull Request is merged or closed), your pipeline must explicitly send an `inactive` status payload to clean up and remove the environment from the repository dashboard.
