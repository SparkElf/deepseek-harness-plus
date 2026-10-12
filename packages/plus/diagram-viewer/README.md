# @sparkelf/dsh-client-ui-diagram-viewer

Renders `.drawio` and `.xmind` files inside the **dsh-better-sidebar** file viewer instead of
showing the raw XML or a download card.

## What it does

Registers two file viewers on the `betterSidebar` registry service:

| Viewer id | Extensions | Source |
|---|---|---|
| `diagram-viewer:drawio` | `drawio`, `dio` | `<mxfile>` XML, parsed into boxes and routed links |
| `diagram-viewer:xmind` | `xmind` | the `content.json` member of the XMind zip |

Both render an inline SVG: one rounded box per topic, straight links between parent and child.

## Install

```sh
dsh plugin --profile dataops-web add @sparkelf/dsh-client-ui-diagram-viewer
```

The bundle patch inserts one entry (`diagram-viewer`) whose `name` resolves this package through
the profile's `node_modules`.

## Why the registration looks the way it does

Three properties are required by `dsh-better-sidebar` and are easy to get wrong:

1. **The entry declares `inject = ["betterSidebar"]`.** The sidebar's client half activates after
   the plugin entries, so reading `ctx.get('betterSidebar')` inside `apply` finds nothing and the
   viewer silently never registers. Cordis waits for the service when the entry injects it.
2. **`detect` is mandatory.** When a file's bytes look binary the sidebar re-runs the matcher
   against the sniffed head instead of trusting the extension, and **skips any viewer without a
   matcher**. XMind is a zip, so without `detect` the tab falls through to the download card.
3. **`load` receives base64 for binary files, text otherwise.** Decoding the base64 inside the
   reader would run the archive bytes through UTF-8 and corrupt them before `readXmind` could
   inflate the member.

## XMind formats

The `content.json` member is a list of sheets. XMind 2021+ wraps the map in `rootTopic`; the
legacy writer serialises the sheet itself as the root topic. Both are handled.

## License

MIT
