# agent-merge

`agent-merge` serializes committed work from parallel Git worktrees onto one shared local `dev` branch. It is designed for workflows where several Codex agents work independently while `main` remains stable for QA.

Each agent runs one blocking command when its work is ready:

```bash
agent-merge submit
```

The waiting process is the queue entry. There is no daemon, database, persisted job, polling loop, or Codex session identifier.

## How submission works

```text
agent-merge submit
        ↓
reject dirty worktree
        ↓
remember HEAD
        ↓
wait for the repository lock
        ↓
recheck HEAD, branch, and worktree
        ↓
rebase onto current dev if needed
        ↓
verify
        ↓
atomically advance dev
```

The lock is an OS advisory file lock at `<git-common-dir>/agent-merge.lock`. Because it uses the common Git directory, every linked worktree contends on the same lock. Waiting happens in the operating system, not in a JavaScript polling loop, and a crashed process automatically releases its lock when its file descriptor closes.

File locks do not guarantee strict FIFO order. With a small number of local agents, acquisition should be roughly arrival-ordered and starvation is unlikely because submissions hold the lock only while rebasing and verifying.

## Requirements and installation

- Node.js 22 or newer
- Git with linked-worktree support
- A local `dev` branch that is not checked out in any worktree

Install globally so every worktree can use the same command:

```bash
pnpm add --global agent-merge
```

Or install it in the repository and invoke it through the package manager:

```bash
pnpm add --save-dev agent-merge
pnpm exec agent-merge submit
```

Create the integration branch once, normally from the QA-stable `main` branch:

```bash
git branch dev main
```

Do not check out `dev`. `agent-merge` updates its ref directly; refusing to update a checked-out `dev` prevents another worktree's index and files from becoming stale.

## Configure verification

Every submission runs `git diff --check` against the commits being added. Add project-specific verification commands to the repository's shared local Git config:

```bash
git config --local --add agent-merge.verify 'pnpm typecheck'
git config --local --add agent-merge.verify 'pnpm test'
```

Commands run in configuration order through the system shell from the submitting worktree's repository root. Because linked worktrees share the repository config, configure them once. Treat repository-local verification configuration as trusted code.

Inspect or clear the commands with:

```bash
git config --local --get-all agent-merge.verify
git config --local --unset-all agent-merge.verify
```

If a command exits nonzero—or changes `HEAD`, starts a Git operation, or leaves the worktree dirty—verification fails and `dev` is not advanced.

## Create agent worktrees

Start each agent branch from the latest `dev` when possible:

```bash
git worktree add -b agent/auth ../project-agent-auth dev
git worktree add -b agent/billing ../project-agent-billing dev
```

It is also safe for an agent to have started from an older `dev` or from `main`; submission rebases its commits onto the current `dev` while holding the integration lock.

Give each agent this protocol in `AGENTS.md`, a skill, or its task prompt:

```text
1. Commit all intended work on your agent branch.
2. Run `agent-merge submit`.
3. Do not modify the worktree while the command waits.
4. On success, your work is in the shared local `dev` branch.
5. On rebase conflicts, resolve them, continue the rebase, and submit again.
6. On verification failure, repair and commit the work, then submit again.
```

No session ID is needed. The command blocks and returns the result directly to the agent that invoked it.

## Conflicts and resubmission

`git rebase` uses Git's configured merge drivers, including [Weave](https://ataraxy-labs.github.io/weave/) after `weave setup`, so either Git or the merge driver can resolve a conflict automatically.

If conflicts remain, `agent-merge` leaves the rebase in progress, releases the repository lock immediately, and exits with status 10. The agent should resolve and continue it normally:

```bash
git status
# edit conflicted files
git add <resolved-files>
GIT_EDITOR=true git rebase --continue
agent-merge submit
```

Another agent may advance `dev` while the conflict is being repaired. Resubmission may therefore perform one more rebase. This is expected and keeps other agents from waiting on an unbounded manual resolution.

When verification fails, the completed rebase remains on the agent branch but `dev` stays unchanged. Fix the problem, commit the repair, and submit again.

## Safety guarantees

- The command rejects tracked or untracked worktree changes before waiting.
- After acquiring the lock, it checks that `HEAD`, the branch, the worktree, and Git operation state did not change while waiting.
- It never checks out or updates `main`.
- It does not hold the lock while an agent resolves conflicts or repairs failed verification.
- It advances `refs/heads/dev` with `git update-ref <new> <old>`, so an unexpected external update fails instead of being overwritten.
- The lock is advisory: other processes can ignore it. The compare-and-swap update still protects the final `dev` ref from an outside writer.

## Exit statuses

| Status | Meaning                                                  | Agent action                                      |
| -----: | -------------------------------------------------------- | ------------------------------------------------- |
|    `0` | Submission verified and `dev` advanced                   | Continue or report completion.                    |
|    `1` | Invalid repository/worktree or another operational error | Correct the reported problem and retry.           |
|   `10` | Rebase conflicts remain                                  | Resolve, continue the rebase, and submit again.   |
|   `11` | Verification failed                                      | Repair and commit the work, then submit again.    |
|   `12` | Worktree changed while waiting                           | Commit or clean the new state, then submit again. |
|   `13` | `dev` changed outside `agent-merge`                      | Nothing was overwritten; submit again.            |

Run `agent-merge --help` or `agent-merge submit --help` for generated command help.
