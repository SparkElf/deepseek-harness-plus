# Agent Note: One authorization principal for trusted managed integrations

Status: implemented

English | [中文](2026-09-01-managed-integration-single-authorization-principal.zh.md)

## Problem

A platform-managed DSH deployment and the platform API belong to one explicitly trusted domain. DSH already exercises the platform capabilities granted to the current user, so hiding the platform JWT from DSH does not reduce that authority.

Derived credentials and replicated permission state add signing, renewal, transport, and lifecycle code for the same principal. Those layers create independent expiry and failure owners without establishing a smaller trust domain.

## Decision

- Managed DSH receives the hosting platform's current access JWT as its only identity and session credential.
- The platform validates the JWT and session, then resolves current roles, permissions, and resource authorization at each API or tool operation.
- Gateways, plugins, and sidecars forward the JWT without adding internal path, scope, role, or permission filters.
- A companion may provide process or resource isolation, but it does not hide the platform JWT and never owns Agent task lifetime.
- JWT expiry rejects only a new platform operation. It does not cancel an accepted turn, close its observation stream, or restart or remove its runtime; later requests use the refreshed JWT.
- Standalone DSH or another explicitly separate trust domain may use OAuth 2.0/OIDC and a narrower credential.
- Implementations delete redundant credentials and state machines instead of layering compatibility over them.

## Alternatives considered

**A second browser credential.** Rejected inside the managed trust domain because it duplicates identity, expiry, renewal, and revocation while DSH retains the user's platform authority.

**Indirect identity held outside DSH.** Rejected because indirection obscures the declared authority and couples authentication to sidecar and container lifecycle.

**Delegated OIDC for managed DSH.** Rejected because authorization-code exchange is appropriate between distinct clients or trust domains, not between a platform and its trusted managed runtime.

## Consequences

A managed integration has one platform JWT and one platform-owned permission mechanism. Browser, Gateway, plugin, sidecar, Agent, and container code do not copy authorization policy or bind credential expiry to task and runtime lifecycle. Standalone authentication remains independently configurable.

A compromised managed DSH can exercise the exact authority currently granted by the platform to its JWT principal. This is the declared managed-runtime trust assumption; JWT lifetime, revocation, audit, and least-privilege roles remain platform concerns.
