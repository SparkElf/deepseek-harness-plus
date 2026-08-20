# Agent Note: Better Sidebar gives mobile users actionable panel controls

Status: implemented

English | [中文](2026-08-20-better-sidebar-mobile-feedback.zh.md)

## Problem

The default Web profile mounts the curated third-party package `dsh-better-sidebar`. On a phone with no selected Session, its panel controls used native disabled buttons. The controls carried a Tooltip that explained the missing Session, but disabled buttons cannot receive focus and phones have no hover, so tapping produced no visible response. With a selected Session, the mobile drawer declared `width: 100vw` while its left border remained outside the content box, making the rendered panel one pixel wider than the viewport.

This behavior belongs to the external plugin. Plus must deliver the verified repair without taking source ownership or waiting indefinitely for an upstream release.

## Decision

Plus pins the npm package at `dsh-better-sidebar@0.14.0` and applies `patches/dsh-better-sidebar@0.14.0.patch` through pnpm's patched dependency mechanism. The no-Session controls use `aria-disabled` instead of native disabled, so they remain unavailable but can receive focus and expose the existing Tooltip to touch and keyboard users. The panel uses border-box sizing so its declared mobile width includes the border.

The curation manifest records upstream PR [#254](https://github.com/omdsh-dev/DSH-better-sidebar/pull/254) and the retirement condition. The patch is removed after an npm release at or above 0.14.1 includes that PR. The external project retains source, release, and security ownership.

## Alternatives considered

- **Wait for upstream merge and publication.** Rejected because the reported default mobile workflow would remain silent for Plus users while review timing is outside Plus control.
- **Depend on the SparkElf fork or copy the plugin source into Plus.** Rejected because a mutable fork pin or vendored copy changes third-party source ownership and creates a second release line.
- **Edit installed node_modules.** Rejected because the change would disappear on install, would not reach Windows or release artifacts, and would leave no reviewed retirement lifecycle.

## Consequences

A phone with no selected Session can tap the subdued control and immediately see the select-Session explanation. After selecting a Session, the same control opens a drawer whose outer width equals the viewport and whose content no longer wraps because of an offscreen or overflowing panel. Desktop behavior and Better Sidebar's registration service do not change.

The local patch is an explicit temporary distribution fact. Curation checks reject patch entries missing the file, upstream URL, or retirement condition.

## Testing

The project Mobile Bridge Playwright command pairs a Pixel 7 through the deployed relay, drives the real first-use flow, verifies the no-Session control's touch Tooltip when that state is present, selects `/root/projects` through the Directory Picker, opens Better Sidebar, waits for its slide transition, and verifies the drawer starts at x=0, equals the viewport width, and keeps its controls onscreen. The same flow continues through Settings, directory actions, two-device pairing, targeted revoke, and browser console and network health checks.
