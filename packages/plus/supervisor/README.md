---
description: "Standalone Plus runtime supervision and controlled-restart Session recovery."
kind: "package-bundle"
---

# @sparkelf/dsh-plugin-supervisor

English | [中文](README.zh.md)

## Summary

This package joins two process roles under one npm release: a Host Cordis plugin exposes the current running top-level Session set and admits recovery prompts, while a plain Node Supervisor starts, stops, rebuilds, and restarts one explicitly described Plus Web runtime. A controlled restart captures running Sessions immediately before shutdown and queues one recovery message in each after the replacement runtime listens.

## Table of Contents

- [Use This Package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use This Package

The Plus profile mounts the Host entry and materializes the <code>dsh-plus-supervisor</code> executable. The external process reads one manifest:

~~~json
{
  "dshHome": "/root/.dsh",
  "port": 3080,
  "supervisorPort": 3082,
  "socketPath": "/root/.dsh/supervisor/runtime.sock",
  "runtime": {
    "command": "node",
    "args": ["/path/to/apps/cli/lib/bin.js", "--profile", "plus", "--port", "3080", "--no-open"],
    "cwd": "/path/to/materialized-dsh"
  },
  "build": {
    "command": "pnpm",
    "args": ["run", "build:official"],
    "cwd": "/path/to/materialized-dsh"
  }
}
~~~

Start the Supervisor with <code>dsh-plus-supervisor --manifest &lt;path&gt;</code>. The same executable accepts <code>status</code>, <code>start</code>, <code>stop</code>, <code>restart</code>, <code>rebuild-and-restart</code> before <code>--manifest</code>. The progress page listens on the configured <code>supervisorPort</code> and reports process, build, capture, and recovery phases.

A restart performs one ordered operation: optional build, capture the current running top-level Session ids, stop the old process, start the configured command, wait for its Web port, and queue the recovery prompt. Ordinary start, stop, process crash, and network reconnect do not send recovery messages.

<a id="model-experience"></a>
## Model Experience

### Controlled-Restart Recovery

#### What the model sees

Each captured Session receives one ordinary user message stating that Supervisor restarted DSH, directing the model to inspect durable history, current workspace state, and tool results, avoid repeating completed operations, finish remaining work, and answer `已完成` when nothing remains. The Session Controller logs the message through its normal `SessionController.prompt` path.

#### Token effect

A recovered Session adds the fixed recovery instruction to its next request and retains it in later history until compaction shadows it.

#### KV Cache effect

The recovery prompt appends to the existing Session request series. Restarting the process does not preserve process-local cache state.

## Known Limitations and Deferred Work
<a id="known-limitations-and-deferred-work"></a>

- A failed recovery prompt is reported by the Supervisor and is not retried automatically.
- The Supervisor manages one runtime manifest and one Web port per process.

<a id="dev-note"></a>
### Dev Note

The [Supervisor package Agent Note](../../../.agents/notes/proposed/architecture/2026-09-02-plus-supervisor-packages.md) owns the process split and recovery lifecycle.
