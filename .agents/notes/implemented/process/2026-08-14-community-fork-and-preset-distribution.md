# Agent Note: Community Fork and Preset Distribution

Status: implemented

English | [中文](2026-08-14-community-fork-and-preset-distribution.zh.md)

## Problem

Teams need an upstream-aware DeepSeek Harness distribution that accepts community maintenance work and gives operators a clear path to runnable presets and deployment assets.

## Decision

DeepSeek Harness Plus is a public GitHub fork of `deepseek-ai/deepseek-harness`. The repository keeps `origin` on the community fork and `upstream` on the original repository. Community changes are reviewed as focused patches and documented with their operating impact.

The root README names the project as independent from DeepSeek, preserves the upstream MIT license, and publishes source-based startup instructions. The preset charter defines code delivery, community operations, multi-user runtime, and intelligent data Q&A as release tracks. A preset is published only with its configuration, permissions, credentials, installation path, and verification instructions.

GitHub Discussions, Issues, pull requests, community guidelines, security reporting, and `kind/*` plus `area/*` labels provide the public contribution path.

## Alternatives considered

**Maintain only a personal patch branch.** A private or unstructured branch would not provide a discoverable contribution path, preset catalog, or public release point for operators.

**Publish preset claims without runnable configurations.** Listing unverified deployment or data capabilities as available would mislead operators and weaken trust in releases.

**Expose each Harness runtime directly to browsers.** Direct runtime exposure bypasses the required gateway ownership of authentication and routes privileged local APIs into an unsafe deployment model.

## Consequences

The project carries upstream synchronization work and must review each imported change against community patches. Contributors gain a clear route for operational repairs and preset proposals. Intelligent data Q&A and multi-user deployment releases must retain their explicit permission, authentication, and audit requirements.
