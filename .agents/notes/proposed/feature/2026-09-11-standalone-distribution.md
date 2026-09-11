# Agent Note: Standalone Plus distribution

Status: proposed

English | [中文](2026-09-11-standalone-distribution.zh.md)

## Problem

Installing Plus today requires git, an official source checkout, and a nine-minute official build. A user who wants the product rather than the source has no supported path: the distribution ships source patches, and a patch implies a source tree.

## Decision

Ship @sparkelf/dsh-plus-standalone: a registry package whose dependencies carry the reviewed plugins and whose first start writes the profile the launcher boots. The user installs one package and runs one command; no source, no build, no git.

## Alternatives considered

**Bundle a complete dependency tree** (the official Desktop approach, +300MB). Rejected after measurement: a normal npm install already satisfies every official import, because the service-definition packages arrive as peers. Only the legacy-peer-deps flag produced the gaps that motivated the idea.

**Keep the source-patch path as the only distribution.** Rejected because it cannot serve a user without a toolchain.

## Consequences

The plugins pin their DSH peers exactly, so a runtime bump must be republished before the standalone package can install. Eleven packages currently publish peers that contradict their source; the gate records that drift and fails on new drift.

## Proposal

A new package @sparkelf/dsh-plus-standalone declares every reviewed plugin as a dependency and carries the bundle order the launcher mounts. A dsh-plus command layer owns the lifecycle the launcher leaves to the user: start creates the profile on first run and chooses a free port, stop ends a background server, status reports the URL, and doctor checks the installation.

## Acceptance criteria

- A consumer with no source checkout installs the package and reaches the browser UI.
- start creates the profile with the distribution bundle order and needs no manual manifest edit.
- A taken port moves to the next free one instead of failing with a bind error.
- stop ends a detached server within its grace period.
- doctor reports a distribution resolved outside the consumer tree as a failure.

## Risks

- An exact DSH peer cannot be corrected in place, so a runtime bump that is not republished blocks installation. The plugins repository gates new drift against a recorded baseline.
- Port search can pick a port the user did not expect; the command prints the substitution.

## Verification

The `dsh-plus` CLI resolves its distribution from the consumer tree, creates the profile with the distribution's bundle order, and moves to the next free port when the preferred one is taken; a distribution resolved outside the consumer tree fails `doctor` rather than reporting health. The plugins repository gates new peer drift against a recorded baseline.
