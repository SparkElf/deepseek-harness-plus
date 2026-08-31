# Agent Note: Plus Office and video preview bundles

Status: implemented

English | [中文](2026-09-01-plus-office-video-preview-bundles.zh.md)

## Problem

Better Sidebar keeps heavyweight Office rendering and video streaming in independent extension bundles. Leaving those bundles as manual post-install commands makes the Plus distribution, local service, and managed workspace expose different preview capabilities.

## Decision

The Plus profile includes `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.1.2` and `dsh-video-preview@0.1.4` immediately after `dsh-better-sidebar@0.17.1`. The distribution installs all three as exact profile dependencies and records both preview packages as runtime bundles in the deployment lock.

Local Plus and DataOps workspace images consume the same materialized profile. Neither deployment performs a separate plugin installation.

## Alternatives considered

**Install each plugin after deployment.** Rejected because three mutable installations can drift from the released profile and from each other.

**Copy the preview implementations into Plus or Better Sidebar patches.** Rejected because both packages already expose complete DSH bundle contracts and remain independently maintained.

## Consequences

Every Plus deployment previews DOCX, XLSX, PPTX, and supported video files through Better Sidebar. The Office bundle adds a 22.4 MB unpacked client artifact plus its rendering dependencies, so profile installation and client loading cost increase. Version upgrades remain explicit distribution changes rather than ambient npm updates.
