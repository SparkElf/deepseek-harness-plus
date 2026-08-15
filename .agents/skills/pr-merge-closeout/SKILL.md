---
name: pr-merge-closeout
description: Use after a Plus PR or release merge batch completes. Restore the primary worktree to the current default branch, remove obsolete temporary branches, and classify every remaining open PR before declaring the work finished.
---

# PR Merge Closeout

A successful GitHub merge is not the end of the work. Closeout leaves the primary checkout on the current default branch and makes the remaining branch and PR state explain the project's actual next work.

## Verify the landed result

Fetch the repository's default branch and confirm every selected PR reports `MERGED` with the expected merge commit. Do not infer completion from a successful merge command, a closed browser page, or a release tag.

Confirm that the landed branch contains the accepted changes and that the release tag, when involved, points to the intended commit.

## Restore the primary worktree

Identify the checkout that serves as the repository's primary day-to-day worktree. Require it to be clean, switch it to the repository's default branch, and fast-forward it to the current remote default branch.

Do not leave the primary worktree on an aggregate, review, release, candidate, or feature branch merely because later work happened in separate worktrees. Report the final branch and exact local/remote revision.

If the primary worktree has unrelated user changes, preserve them and stop before switching; do not discard or hide them to complete cleanup.

## Clean local and remote branches

Inventory every local and remote branch created for the completed merge batch. Map remote heads to GitHub PR state instead of relying on branch names. Before deleting a branch, confirm:

- no open PR uses it as a head;
- no open PR uses it as a base;
- no unfinished work is unique to it;
- the accepted result is present on the default branch or intentionally preserved elsewhere.

A merged PR head may not be an ancestor of the default branch after a squash or single-parent merge. In that case, compare the PR head tree with the recorded GitHub merge commit tree, or otherwise prove patch equivalence, before deletion. Do not treat a non-ancestor result alone as either proof of unmerged work or permission to delete it.

Delete confirmed aggregate, review, release, and merged-PR branches from both the remote and local repository in a separate cleanup pass. Prune remote-tracking refs and list the remote heads again after deletion. A branch with continuing or deferred work is not temporary merely because another release has shipped.

## Classify remaining pull requests

List every open PR after the merge batch and assign one status based on current product intent:

- **Continue**: active independent work that remains in scope.
- **Deferred**: independent work intentionally postponed; keep it draft and state what must happen before implementation resumes.
- **Obsolete**: work that was replaced, abandoned, duplicated, or no longer has independent value; close it with a concise reason and point to the replacement when one exists.

Do not close an independent PR only because it was excluded from the latest release. Do not leave an obsolete PR open merely to preserve its discussion. Preserve useful history through the closing comment.

When a PR remains open, its title, draft state, body, or maintainer comment must make its current status understandable without reconstructing the previous merge session.

## Final verification

Before reporting completion, confirm:

- the primary worktree is clean and on the current default branch;
- local default and remote default resolve to the same revision;
- merged PRs are closed as merged;
- local and remote temporary branches have either been deleted or have a stated continuing purpose;
- remote-tracking refs were pruned and the final remote branch list was verified;
- every remaining open PR is classified as Continue or Deferred;
- every Obsolete PR is closed with its reason;
- no cleanup command touched upstream remotes.

Report the final default-branch revision, the branches removed, and the disposition of each remaining PR.
