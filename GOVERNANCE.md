# Plus Contribution Governance

DeepSeek Harness Plus accepts human and AI-authored pull requests. Every pull request follows the same evidence path: product design, architecture planning, implementation, code review, test governance, and verification.

## Committee review

An AI author records evidence for all six skills in the pull request template. The governance workflow rejects a PR that omits a required section or fails the diff and composition verifier. A human code owner reviews the user impact, plugin safety, and release claims before merge. AI evidence informs review; it never grants merge permission.

## Human ownership

The initial human committee owner is `@SparkElf` through `.github/CODEOWNERS`. Add additional GitHub handles there before enabling them as required reviewers in repository branch rules.

## Required records

Core Harness and core-plugin divergences belong in `diffs/core/registry.yaml`. Community plugins, presets, deployment, installer, and governance divergences belong in `diffs/community/registry.yaml`. Plugin and preset claims belong in `presets/compositions/registry.yaml`.

Run `pnpm run verify:plus-governance` before review. The full protocol is in [DIFFS.md](DIFFS.md).
