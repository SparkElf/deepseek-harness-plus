# Agent Note: Session-authorized document preview tabs

Status: implemented

English | [中文](2026-08-31-session-authorized-document-preview.zh.md)

## Problem

Durable Document cards in Chat and Trajectory identify immutable originals and parser artifacts in the attachment store, while Better Sidebar's standard file viewer opens mutable paths in a Session Workspace. Copying every attachment into the Workspace would make Session history depend on files that users, tools, Git operations, or Workspace deletion can modify or remove. Passing the attachment store's host path would expose provider-private layout and bypass the Session reference check. A metadata-only custom tab would retain the attachment address but Better Sidebar 0.17.1 would not reveal a collapsed panel for that content open.

## Decision

The attachment store remains the only durable byte owner. A Document block records the original attachment and its parser artifacts; Chat and Trajectory project only the parsed-Markdown attachment id and display metadata required by the card. The Document plugin opens one hidden Better Sidebar tab whose `id` derives from the preview content address and display name, whose `title` is that display name, and whose `path` is the parsed-Markdown content address. No unused original id or duplicate card object is persisted in the presentation data or `tab.meta`.

Better Sidebar owns tab placement, persistence, deduplication, activation, and panel reveal. Because the open carries `path`, its existing content-open behavior reveals a collapsed panel without a Better Sidebar change. The custom tab interprets that path only within the `document-attachment` tab type; it never calls `openFile` or the Workspace filesystem API.

The Document plugin resolves the content address through the Client Session binding. The Session attachment operation first proves that the active or persisted Session log references the requested original, parser artifact, or extracted image, then delegates to the mounted attachment provider's generic-file or image read. The Client receives verified bytes and the preview renders parser-produced Markdown with localized Markdown controls; an empty parser artifact renders a localized no-text state instead of a blank panel. Physical attachment-store paths never cross the Host/Client interface.

## Alternatives considered

**Copy every accepted Document into the Session Workspace and call `openFile`.** Rejected because the Workspace is mutable, may be shared by multiple Sessions, produces filename and Git-status side effects, and can disappear while the Session history remains valid.

**Add an attachment protocol or `reveal` option to Better Sidebar.** Rejected because a typed custom tab already accepts a persisted content locator and Better Sidebar already reveals opens carrying `path`; expanding the external plugin API would add a second resource vocabulary for one current consumer.

**Pass the attachment store's absolute object path.** Rejected because the path belongs to the local provider, has no stable filename or extension, may be outside the Workspace fence, and cannot survive a provider change.

## Consequences

Chat and Trajectory cards open the same deduplicated preview tab and re-open a collapsed panel without modifying Better Sidebar. Session history remains independent of Workspace mutation, and the preview read preserves the Session authorization and attachment integrity checks. The sidebar intentionally presents semantic Markdown rather than page-faithful PDF or Office rendering. A future explicit "save to Workspace" action may create a derived mutable copy, but such a copy is not a prerequisite or authority for history preview.
