# Recreating author-blocked pull requests with a GitHub App

English | [中文](recreating-author-blocked-prs-with-a-github-app.zh.md)

Use this procedure when an open pull request was created by the administrator who must approve it. GitHub does not allow a pull request author to approve their own pull request.

## Preconditions

- The administrator is the relevant CODEOWNER.
- The GitHub App is installed only on the target repository.
- The App has Contents read/write, Pull requests read/write, and Metadata read-only permissions.
- The private key is outside the repository with file mode 600.
- The working tree is clean and the procedure will not merge the target branch.

Never put a private key, JWT, Installation Token, or PAT in chat, shell history, repository files, or PR text.

## Create the App token

Set GH_APP_ID and GH_APP_KEY locally. Generate a short-lived JWT with the App private key, then exchange it at the GitHub App installations access-token endpoint. Keep both values in shell variables and never print them.

Use a harmless repository read with GH_TOKEN to verify the installation:

    GH_TOKEN="$GH_APP_TOKEN" gh api repos/<owner>/<repo> --jq '{full_name,default_branch}'

## Migrate one PR

Capture the source PR title, body, headRefOid, and baseRefName before changing it.

Create a unique bot branch at the exact source head commit through the Git references REST endpoint:

    bot/migrate/pr-<old-number> -> <headRefOid>

Create the replacement PR with the original base branch, title, and body. Use the bot branch as head. Confirm the replacement exists before closing the source PR.

Close the source PR with a comment naming the replacement. Then switch to the administrator's normal gh login and approve the replacement:

    gh pr review <new-number> --repo <owner>/<repo> --approve

Do not use administrator bypass for this workflow. Approval and merge are separate actions; this procedure never merges master.

## Migrate a stack

Inventory all open PRs before changing any of them. Process a stack from its lowest layer upward. Preserve every original base branch, including bases that are other branches in the stack. Use one unique bot branch per source PR.

Create and verify each replacement before closing its source PR. If a network operation times out, inspect GitHub state before retrying; do not blindly create a duplicate.

## Verify

The source PRs must be CLOSED and replacements must have the App author and administrator approval. For every pair compare the head SHA, base branch, title, body, replacement author, and approval state.

Merged and already closed historical PRs are immutable records and are not migrated. Deleting a source branch does not delete its PR record. The final check must confirm that no migration command merged master.
