---
description: "Placeholder package an omitted capability is overridden onto, so an installation never receives the real one."
kind: "package-reference"
---

# @sparkelf/dsh-omitted

English | [中文](README.zh.md)

A placeholder a deployment points an `overrides` entry at when it must not install a capability.

## Table of Contents

- [Use this package](#use-this-package)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Summary

npm expresses package substitution through `overrides` and has no removal semantics: an override can only replace a package with another one, never delete it. A deployment that omits a capability therefore points its override at this package, and the substituted name never reaches the installation.

The omission stays auditable for the same reason: a scan of the tree finds the placeholder rather than the capability it replaced.

## Use this package

```json
{
  "overrides": {
    "@deepseek-ai/dsh-computer-use": "npm:@sparkelf/dsh-omitted@0.2.0-rc.17"
  }
}
```

## Dev Note

The package exists for one reason, so it carries no dependency of its own beyond the Cordis peer every plugin in this repository declares.

- No runtime invariant companion is published because the package exports nothing and holds no state; a substitution is observed by the installation tree that npm resolves, not by this module.

## Model Experience

### Omitted capability substitution

#### What the model sees

Nothing. `@sparkelf/dsh-omitted` registers no tool, prompt section, or Session event of its own, and the deployment that installs it omits the capability it stands in for.

#### Token effect

Zero. The package adds no model-request tokens.

#### KV Cache effect

None. It contributes no prompt content, so it cannot shift a cache prefix.

## Known Limitations and Deferred Work

- The module exports nothing. Loading it in place of a real plugin fails at the mount step with a missing-export error, which is intended: a deployment that omitted a capability must not silently mount a stub for it. A deployment must also not mount the substituted name as a bundle.
- This package has no behaviour to configure and no commands.
