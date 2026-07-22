---
name: agent-merge
description: Integrate finished, verified, fully committed agent work into dev. Use whenever the user asks to merge; do not use for partial, exploratory, or dirty work.
---

# Integration protocol

Submit only after the task is finished, repository verification passes, all intended work is committed, and the worktree is clean.

Run:

```bash
agent-merge submit
```

The command may block while another agent integrates first. Do not modify the worktree while it runs.

The command rejects dirty worktrees, waits for exclusive access to `dev`, rebases the current work onto the latest `dev`, runs repository verification, and advances `dev` on success. Commits and `HEAD` may change during the rebase.

## Results

### Success

The work is integrated into `dev`. Finish the task.

### Rebase conflicts

The rebase remains in progress. Continue it:

```bash
git status
# resolve conflicts
git add <resolved-files>
git rebase --continue
```

Rerun required repository verification, commit conflict-resolution changes when Git requires it, then run `agent-merge submit` again.

### Verification failure

Fix the failure, rerun verification, commit the repair, and submit again.

### Worktree changed while waiting

Inspect the new state, ensure all intended work is committed and the worktree is clean, then submit again.

### Unexpected `dev` update

Rerun `agent-merge submit` unless the CLI gives more specific instructions.

## Constraints

- Do not update `dev` directly.
- Do not merge `dev` into the agent branch.
- Do not modify the worktree while waiting.
- Do not abort a conflicted rebase unless recovery is necessary.
- Do not declare the task complete until submission succeeds.
- After a rebase, rerun required repository verification.
- Commit conflict-resolution or repair changes before resubmitting when Git requires it.

## Recovery

For an unusual state, inspect it first:

```bash
git status
git rebase --abort
```

Abort only when the rebase cannot safely continue or the CLI reports an internal failure.
