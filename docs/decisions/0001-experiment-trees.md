# ADR 0001: Isolated experiment trees

## Status

Accepted.

## Context

`/autoresearch` currently stores one version-1 experiment contract and its
hash-chained state under `experiments/<slug>`. Each experiment owns its own
budget, receipts, reviews, snapshots, and report. That model is useful for a
single bounded search, but it does not preserve explicit parent/child
lineage when comparing several candidate directions.

The tree feature must build on that protocol without changing existing
contracts or weakening their approval, receipt, review, or recovery checks.
It must not edit the user's checkout while candidate work is in progress.

## Decision

Add an opt-in tree controller beside the version-1 experiment engine. A tree
has one immutable definition and a hash-chained event journal. Each tree node
is still an ordinary version-1 experiment with its own contract, receipts,
review history, and report. The tree journal binds each node to its parent,
the parent's selected receipt, and the exact code snapshot used to seed it.

Tree metadata and managed Git worktrees live under
`<repo>/experiments/.trees/<tree-slug>/`. The root node starts in a detached
worktree at the repository's captured `HEAD`. A child starts in a separate
detached worktree at that same captured commit, then receives the parent's
verified best scoped-file snapshot and the tree's frozen input files. This
preserves the candidate source without requiring automatic commits. Each node
then runs its own version-1 baseline before trials; baseline executions count
against shared wall time.

Node `HEAD` remains pinned to the captured base commit. Candidate changes stay
uncommitted and are recorded by version-1 source snapshots; tree operations
reject a node whose `HEAD` has moved.

Creating a tree requires the supplied workspace to be the Git repository
root and `git status --porcelain --untracked-files=all` to be empty. Ignored
scratch data is not treated as a dirty checkout, but declared input files are
copied into a tree-owned frozen snapshot and hash-checked in every node.
Version-1 experiments retain their existing behavior, including use in dirty
or non-Git workspaces.

The immutable tree definition records the benchmark protocol, frozen inputs,
base commit, and aggregate limits. The tree state records nodes, parent
lineage, promotion, aggregate trial attempts and elapsed time, and active run
reservations. A tree-wide lock serializes state transitions. Before a node
run starts, the controller reserves one parallel slot and the version-1
`timeoutPerRun` for the complete configuration (all requested seeds); it
refuses runs that could exceed the tree's shared trial or wall-time budget.
The default parallel-run limit is one; users may raise it within the aggregate
budget. Per-node version-1 locks continue to prevent duplicate runs of the
same node.

Forking requires a closed parent with a valid best receipt and passing
required reviews. Siblings are independent worktrees seeded from that same
parent receipt and snapshot. Tree-bound contracts record their tree/node
identity; a version-1 start call without a persisted tree reservation is
rejected. The controller holds the tree lock while validating the reservation
and claiming the node run, so shared budgets cannot be bypassed through the
ordinary experiment tool. Pause and resume operate on node workers and
preserve both tree reservations and per-node version-1 recovery evidence.

Promotion changes only the tree's selected-winner pointer and requires a
closed node with a valid best receipt and passing required reviews. It never
copies files into the user's checkout, merges branches, creates commits, or
rewrites a parent node. Closing the tree requires all nodes to be closed and
settled; it exports a tree report and provenance sidecar containing node
lineage, the promoted winner if any, receipts, and review status.

The existing `/experiments` command remains the management surface, and
`hypatia_experiment` remains the agent interface. Tree actions are additive.
Version-1 calls that do not identify a tree node continue to use the existing
workspace and engine behavior.

## Consequences

- Existing version-1 contracts and receipts remain readable without
  migration.
- Every node has independently reviewable version-1 evidence and a
  comparable baseline; the cost of repeated baselines is explicit in the
  shared wall-time budget.
- Detached worktrees and ignored tree storage isolate candidates from the
  user's checkout. Tree workspaces remain available after closure for
  inspection; automatic pruning is out of scope.
- Promotion records a winner but intentionally leaves applying or merging
  that candidate to a separate, explicit user action.
- Dirty-checkout tree creation is rejected rather than attempting to snapshot
  tracked, untracked, or partially staged workspace state.

## Acceptance criteria

1. A clean Git root can create a tree and an isolated root node; a dirty or
   non-Git workspace is rejected for tree creation while version-1 creation
   remains unchanged.
2. A child can be forked from a settled parent; its source snapshot and frozen
   inputs match the recorded parent receipt and tree definition, and siblings
   do not share a writable worktree.
3. The tree exposes create, inspect/list, fork, run, decision, pause/resume,
   promote, and close/export actions through the existing experiment surfaces.
4. Aggregate trial/time budgets and the parallel-run cap remain enforced
   across nodes and after process recovery.
5. Promotion is refused until evidence and required reviews pass, and never
   changes the user's checkout.
6. Tree and node provenance can be verified from the persisted journals,
   version-1 receipts, reviews, and snapshot hashes.
7. Existing version-1 experiment tests continue to pass.
