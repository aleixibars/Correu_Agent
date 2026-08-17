# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| --------------------------- | --------------------- | ----------------------------------------- |
| `needs-triage`              | `needs-triage`        | Maintainer needs to evaluate this issue   |
| `needs-info`                | `needs-info`          | Waiting on reporter for more information  |
| `ready-for-agent`           | `ready-for-agent`     | Fully specified, ready for an AFK agent   |
| `ready-for-human`           | `ready-for-human`     | Requires human implementation             |
| `wontfix`                   | `wontfix`             | Will not be actioned                      |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Pipeline operative labels

Separate from the five canonical roles above — these drive the autonomous agent pipeline (`.github/workflows/agent-*.yml`), documented in `context.md` §12:

| Label | Meaning |
|---|---|
| `agent:implement` | Triggers the implementer agent on an issue |
| `agent:review` | Triggers the reviewer agent on a PR |
| `agent:update-branch` | Triggers conflict resolution on a PR |
| `agent:in-progress` | An agent run is currently active (issue or PR) |
| `agent:blocked` | The last agent run failed; needs a human look or a re-add of the trigger label |
