# Branch and worktree workflow

- `integration` is this fork's permanent integration branch. Keep the primary checkout on it, tracking `origin/integration`.
- Do not create versioned `integration/*` branches. Version snapshots belong to the existing release and tag workflow.
- Keep `main` for upstream synchronization. Use focused `feat/*` or `fix/*` branches for development. Branch upstream contributions from `upstream/main` so their pull requests do not include fork-only changes.
- Before starting work, inspect the current branch, `git status`, and `git worktree list`. Reuse an appropriate existing checkout before creating another worktree.
- Create a temporary worktree only when a task needs isolation. Keep that task's edits in one checkout; do not leave uncommitted duplicates in the primary checkout after committing them elsewhere.
- After the task's commits are integrated and validation is complete, remove its temporary worktree once it has no pending changes. Check untracked and ignored files before removal; preserve anything that is not a disposable build or dependency artifact.
- Before deleting a branch, verify that its commits are preserved in `integration` or another intended destination. Retain branches needed by open pull requests and preserve unrelated work.
- At the end of integration or cleanup work, verify the primary checkout is on `integration` and report any remaining changes or worktrees. Do not commit or discard unrelated changes merely to make the checkout clean.
