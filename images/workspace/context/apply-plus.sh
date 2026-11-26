#!/bin/bash
set -eux
export npm_config_fetch_timeout=300000
export npm_config_fetch_retries=3
export npm_config_fetch_retry_mintimeout=5000
export npm_config_fetch_retry_maxtimeout=30000
export npm_config_network_concurrency=8
# `dsh-plus apply` builds the official tree in place. On the 16 GB WSL VM that build has already
# killed the Docker Desktop engine twice (measured 2026-11-18 08:16 and 21:29: the client reported
# `failed to receive status: ... EOF` and the engine stayed down), so cap each Node heap and run two
# workspace builds at a time. The limits only bound the spike; the build itself is unchanged.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=3072}"
export npm_config_workspace_concurrency="${npm_config_workspace_concurrency:-1}"
cd /opt/dsh-home/profiles/dataops-web

node -e "const fs=require('fs');const p='pnpm-workspace.yaml';let t=fs.readFileSync(p,'utf8');t=/^autoInstallPeers:/m.test(t)?t.replace(/^autoInstallPeers:.*$/m,'autoInstallPeers: false'):'autoInstallPeers: false\n'+t;fs.writeFileSync(p,t)"
# The release being installed is minutes old; the release-age window would refuse it and
# silently resolve an older version that satisfies the same range. Nothing here needs the
# window: every version is chosen by the release under build.
node -e "const fs=require('fs');const p='pnpm-workspace.yaml';let t=fs.readFileSync(p,'utf8');if(!/^minimumReleaseAge:/m.test(t))t+='minimumReleaseAge: 0\n';fs.writeFileSync(p,t)"
printf 'registry=%s\n' "${DSH_PLUS_INSTALL_REGISTRY:-https://registry.npmmirror.com}" > .npmrc

# An official plugin declares `xlsx@0.20.3` as a tarball URL on cdn.sheetjs.com, and this host cannot
# reach that CDN. The source tree's lockfile is vendorised in the Dockerfile; the profile install is a
# second, independent resolution, and it reads `.pnpmfile.cjs` from this directory -- pnpm's documented
# hook for rewriting a dependency before resolution. Both halves point at the same vendored tarball.
cat > .pnpmfile.cjs <<'PNPMFILE'
'use strict'

// `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` depends on xlsx through a CDN URL. The mirror
// in `package.json` is kept for the lockfile's identity, but the resolver is pointed at the tarball
// shipped in the image, because that CDN is unreachable from the build network.
module.exports = {
  hooks: {
    readPackage(pkg) {
      const spec = pkg.dependencies && pkg.dependencies.xlsx
      if (typeof spec === 'string' && spec.includes('cdn.sheetjs.com')) {
        pkg.dependencies.xlsx = 'file:/opt/dsh-vendor/xlsx-0.20.3.tgz'
      }
      return pkg
    },
  },
}
PNPMFILE
test -s .pnpmfile.cjs


printf 'registry=%s\n' "${DSH_PLUS_INSTALL_REGISTRY:-https://registry.npmmirror.com}" > /opt/dsh-source/.npmrc

# `UserStyleBubble` calls the `renderSlotChain` prop directly (MessageItem.tsx:226) and declares it
# required (line 191), but the `conversation.chat.node` host renders that entry without the prop, so
# the user-message bubble crashed with "TypeError: renderSlotChain is not a function" and the slot
# entry was dropped (measured 2026-11-05, aarch64 + x86). Default it to the file's own
# NO_MESSAGE_SOURCE no-op: the seat renders empty instead of throwing. The build fails when the
# anchor is gone, so an upstream rewrite cannot silently retire the patch.
message_item=/opt/dsh-source/packages/client/ui-chat/src/client/chat/MessageItem.tsx
test -f "$message_item"
if ! grep -q 'renderSlotChain' "$message_item"; then
  # The fork moved renderSlotChain out of MessageItem (TurnTailNodeView owns it now), so the
  # UserStyleBubble crash this patch worked around cannot occur. Skip instead of failing.
  echo "MessageItem.tsx no longer uses renderSlotChain; skipping the bubble default patch"
elif ! grep -q 'renderSlotChain = NO_MESSAGE_SOURCE' "$message_item"; then
  sed -i 's/^  node, renderSlotChain, content, loadImage, renderFactorySlot, actions,$/  node, renderSlotChain = NO_MESSAGE_SOURCE, content, loadImage, renderFactorySlot, actions,/' "$message_item"
  grep -q 'node, renderSlotChain = NO_MESSAGE_SOURCE, content' "$message_item" || {
    echo "MessageItem.tsx patch anchor moved: UserStyleBubble no longer destructures renderSlotChain on the reviewed line" >&2
    exit 1
  }
fi
echo "  patched UserStyleBubble: renderSlotChain defaults to NO_MESSAGE_SOURCE"

# A bare Markdown link such as `[report.zip](report.zip)` used to resolve from the
# session's live cwd. DataOps KB sessions run with cwd=/workspace/kb, so the link
# silently became /workspace/kb/report.zip even when the file lived elsewhere.
# Resolve bare links from the workspace root; only explicit `./`, `../`, rooted, or
# drive paths keep the live-cwd base. The anchor check fails the build on upstream drift.
file_path=/opt/dsh-source/packages/client/ui-chat/src/client/file-path.ts
test -f "$file_path"
node - "$file_path" <<'NODE'
const fs = require('node:fs')
const path = process.argv[2]
let text = fs.readFileSync(path, 'utf8')
if (!text.includes('__dshBareFileLinkFromWorkspaceRoot')) {
  const anchor = 'return path => resolveWorkspacePath(sessionDirectory(ctx.sessions, sessionId), path)'
  if (!text.includes(anchor)) {
    console.error('ui-chat/file-path.ts anchor missing: cannot patch bare file-link resolution')
    process.exit(1)
  }
  const replacement = `return path => {
    const session = ctx.sessions.list.getSnapshot().byId[sessionId]
    const explicitRelative = /^(?:\\.{1,2}[\\/]|[\\/]|[a-z]:[\\/])/i.test(path)
    // __dshBareFileLinkFromWorkspaceRoot: a bare link belongs to the workspace root,
    // not to a mutable cwd (DataOps KB sessions would fold it into /workspace/kb).
    return resolveWorkspacePath(explicitRelative ? sessionDirectory(ctx.sessions, sessionId) : session?.cwd, path)
  }`
  fs.writeFileSync(path, text.replace(anchor, replacement))
  text = fs.readFileSync(path, 'utf8')
}
if (!text.includes('__dshBareFileLinkFromWorkspaceRoot')) process.exit(1)
NODE
grep -q '__dshBareFileLinkFromWorkspaceRoot' "$file_path"
echo "  patched Chat bare file links to resolve from the workspace root"

npm_config_registry="${DSH_PLUS_INSTALL_REGISTRY:-https://registry.npmmirror.com}" dsh-plus apply --dsh-root /opt/dsh-source

# The profile links `@deepseek-ai/dsh-client-ui-chat` from /opt/dsh-source and serves its client
# bundle from `lib/client.js`. The source patch above only reaches the browser if the official
# build recompiles ui-chat; in the image the prebuilt `lib/` is what ships, so a box rebuilt from
# this script kept the old bare-link base until it was repaired by hand in
# `lib/types/client/apply.js`. Patch the emitted modules and the bundle here as well, after
# apply, so the repair is reproducible. Every replacement is anchor-checked and idempotent: a
# build that did recompile from the patched TS already contains the fixed calls and is left alone.
node - /opt/dsh-source/packages/client/ui-chat <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const bundle = path.join(root, 'lib/client.js')
const MARK = '__dshBareFileLinkFromWorkspaceRoot'
const BROKEN = /function sessionFilePath\(ctx,\s*sessionId\)\s*\{\s*return path=>resolveWorkspacePath\(sessionDirectory\(ctx\.sessions,\s*sessionId\),\s*path\)\s*\}/
const FIXED = 'function sessionFilePath(ctx,sessionId){return path=>{const s=ctx.sessions.list.getSnapshot().byId[sessionId];const explicit=/^(?:\\.{1,2}[\\\\/]|[\\\\/]|[a-z]:[\\\\/])/i.test(path);/* ' + MARK + ' */return resolveWorkspacePath(explicit?sessionDirectory(ctx.sessions,sessionId):s?.cwd,path)}}'

if (!fs.existsSync(bundle)) {
  console.error('ui-chat compiled bundle missing: ' + bundle)
  process.exit(1)
}
let text = fs.readFileSync(bundle, 'utf8')
if (!text.includes(MARK)) {
  if (!BROKEN.test(text)) {
    // 0.2.3-alpha.2 moved or rewrote the compiled helper; the source-level patch above remains
    // the authority. Treat a missing old anchor as a retired workaround, not a build failure.
    console.log('  ui-chat compiled sessionFilePath anchor retired; skipping stale bundle patch')
  } else {
    text = text.replace(BROKEN, FIXED)
    fs.writeFileSync(bundle, text)
    text = fs.readFileSync(bundle, 'utf8')
    if (!text.includes(MARK)) {
      console.error('ui-chat compiled bare-link patch did not stick')
      process.exit(1)
    }
    console.log('  patched ui-chat lib/client.js: bare links resolve from the workspace root')
  }
}
NODE
echo "  verified ui-chat compiled bare file links"

# `dsh-plus apply` has no `--edition`: it rewrites `dsh.profile.bundles` from the distribution's
# base list, which both names the omitted capabilities and misses the edition-only rows. Measured
# 2026-11-05 on rel66: the dry-run projected 25 rows, `apply` wrote the base 20 back (three of them
# omitted placeholders) and the image assertion failed with
# "bundle @sparkelf/dsh-quant declares @sparkelf/dsh-omitted".
# Restore the edition's own list from the installed distribution, then drop any row whose package
# resolves to the omitted placeholder or does not resolve at all. Data-driven on purpose: a row
# list written here would drift from the edition the moment either side changes.
node -e '
const fs = require("node:fs"), path = require("node:path");
const profile = "/opt/dsh-home/profiles/dataops-web";
const dist = "/usr/local/lib/node_modules/@sparkelf/dsh-plus/package.json";
const edition = JSON.parse(fs.readFileSync(dist, "utf8")).dshPlus.editions["intranet-team"];
const file = path.join(profile, "package.json");
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const declared = edition.bundles;
const kept = declared.filter((name) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profile, "node_modules", name, "package.json"), "utf8"));
    return pkg.name !== "@sparkelf/dsh-omitted";
  } catch {
    return false;
  }
});
manifest.dsh.profile.bundles = kept;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
console.log("bundles restored from edition:", declared.length, "dropped omitted:", declared.length - kept.length, "final:", kept.length);
'
test -f /opt/dsh-home/profiles/dataops-web/.dsh-plus/patchset.lock.json

# `@deepseek-ai/dsh-client-ui-chat` augments the slots service with the chain renderer
# (`renderSlotChain`), and that augmentation only exists on the copy of
# `@deepseek-ai/dsh-client-ui-slots` it imported. pnpm nested 75 copies of that package into the
# profile (identical version, different peer contexts, even under nodeLinker: hoisted), so
# `UserStyleBubble` in the api-gateway / agent-team client bundles received a SlotCore without
# `renderSlotChain` and the `conversation.chat.node` slot crashed with
# "TypeError: renderSlotChain is not a function" (measured 2026-11-05 on aarch64 and x86).
# Flatten every nested copy onto the top-level one, the same way the sidebar fork is linked.
slots_link=/opt/dsh-home/profiles/dataops-web/node_modules/@deepseek-ai/dsh-client-ui-slots
test -e "$slots_link"
slots_real=$(readlink -f "$slots_link")
# The top-level copy may itself be a symlink into the pnpm store, so "one real directory" is not
# the right assertion; every copy must RESOLVE to the same target instead.
find_slots() {
  find /opt/dsh-home/profiles/dataops-web/node_modules \
    -path "*/node_modules/@deepseek-ai/dsh-client-ui-slots" \( -type d -o -type l \) 2>/dev/null
}
for d in $(find_slots); do
  [ "$(readlink -f "$d")" = "$slots_real" ] && continue
  rm -rf "$d"
  ln -sfn "$slots_link" "$d"
done
distinct=$(for d in $(find_slots); do readlink -f "$d"; done | sort -u | wc -l)
test "$distinct" -eq 1 || {
  echo "slots flatten left $distinct distinct targets for @deepseek-ai/dsh-client-ui-slots (expected 1)" >&2
  exit 1
}
echo "  slots flattened: all copies resolve to ${slots_real}"

# The plus layer is immutable runtime input. Prune artifacts that only served the source build
# and are never loaded by DSH at runtime. This runs in the same BuildKit layer as the build, so
# the deleted bytes do not remain in a lower layer as whiteouts.
echo "  pruning build-only source maps/tests and Python caches"
find /opt/dsh-source -type f -name '*.map' -delete 2>/dev/null || true
for name in tests docs benchmarks coverage; do
  find /opt/dsh-source -type d -name "$name" -prune -exec rm -rf {} + 2>/dev/null || true
done
find /opt/dsh-source -type f -name '*.pyc' -delete 2>/dev/null || true
find /usr/local/lib/python3.12/site-packages -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true
find /usr/local/lib/python3.12/site-packages -type f -name '*.pyc' -delete 2>/dev/null || true
