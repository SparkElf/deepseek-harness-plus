/**
 * Combined workspace gateway process.
 *
 * The web tunnel and the third-party SDK gateway are independent modules: both only
 * need the workspace owner token, the loopback DSH service, and their own listeners.
 * Importing both here keeps one Node isolate (and one V8 baseline) instead of two,
 * while leaving each module's protocol logic untouched.
 *
 * `DATAOPS_WORKSPACE_GATEWAY_MODE=split` remains available at the entrypoint for a
 * rollback to the old `workspace-platform-sidecars.mjs` supervisor.
 */
process.on('uncaughtException', (error) => {
  console.error('[workspace-gateway] uncaught exception', error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('[workspace-gateway] unhandled rejection', error);
  process.exit(1);
});

const loaded = [];

async function loadComponent(name, relativePath) {
  try {
    const module = await import(new URL(relativePath, import.meta.url).href);
    console.log(`[workspace-gateway] ${name} imported`);
    return module;
  } catch (error) {
    console.error(`[workspace-gateway] ${name} failed to load`, error);
    return undefined;
  }
}

// The web tunnel is the portal's only route into DSH. Load it first and fail fast:
// a half-working gateway that only serves the SDK listener would leave the portal
// broken while the entrypoint believes the sidecar is healthy.
const web = await loadComponent('web', './workspace-web-gateway-agent.mjs');
if (web === undefined) {
  console.error('[workspace-gateway] web tunnel unavailable; exiting for entrypoint restart');
  process.exit(1);
}
loaded.push('web');

const sdk = await loadComponent('sdk', './workspace-sdk-gateway.mjs');
if (sdk?.sdkReady !== undefined) {
  try {
    await sdk.sdkReady;
    loaded.push('sdk');
    console.log('[workspace-gateway] sdk listening');
  } catch (error) {
    // A busy SDK port must not take down the web tunnel. The entrypoint keeps this
    // process alive; the portal remains usable while the SDK listener is unavailable.
    console.error('[workspace-gateway] sdk listener unavailable; continuing with web only', error);
  }
} else if (sdk !== undefined) {
  console.warn('[workspace-gateway] sdk module has no readiness signal; not counting it as running');
}

console.log(`[workspace-gateway] running: ${loaded.join(', ')}`);
