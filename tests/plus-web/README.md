# Plus Web Playwright system acceptance

English | [中文](README.zh.md)

This runner verifies the npm/profile/apply distribution through the real Plus Web UI. It does not launch Desktop or the tray, reuse production port 3080, mutate the supplied model seed home, mock browser requests, or use API calls for business setup and assertions. It reads `settings.yaml` as structured data and writes only the provider, model, safe protocol, Responses compatibility, and default-model fields matching `DSH_PLUS_TEST_MODEL_LABEL`; it copies `.credentials.yaml` opaquely. It prints neither file, and teardown deletes both isolated seed files.

## Prerequisites

The standard command builds the candidate first so every local npm tarball contains its published Host and Client artifacts. The runner requires `DSH_PLUS_TEST_MODEL_SEED_HOME`, the visible current GPT name in `DSH_PLUS_TEST_MODEL_LABEL`, `DSH_MINERU_ENDPOINT`, `DSH_DATAOPS_BASE_URL`.

```bash
pnpm run test:plus-web
```

Global setup creates an ignored `.cache/plus-web-system` tree, seeds only the current GPT settings and credentials into its isolated home, checks out exact official revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`, packs the local Plus capability and patch packages, installs them through `dsh plugin --profile plus add`, executes `dsh-plus apply`, builds the patched official source, creates an isolated Workspace directory selected through the official browser picker, and launches the resulting profile at `http://127.0.0.1:3081`. Each browser context enters through the official process-token root exchange and follows its redirect to the clean root; the ephemeral token is not written to runtime metadata. The runtime owns only its recorded process group and stops it in global teardown. The isolated home, deployment lock, Web log, traces, screenshots, videos, and HTML report remain under that cache for diagnosis and are replaced by the next run.

The desktop cases cover the Responses gateway setting, Subagent settings persistence, streamed Backup failure recovery and restoration, Document parsing and durable Chat/Trajectory cards, DataOps authorization and chart rendering, Better Sidebar, dshmarket, and official Turn folding. One mobile case covers the installed Mobile Bridge/layout path at a 390x844 viewport. Every case records page errors with stacks, console errors, failed requests including CORS failures, and HTTP failures; test timeouts retain trace/video evidence for stalls.

Agent Teams is not an inherited release capability or part of the tracked accepted composition at this official revision: its service, tools, Client UI, and Web profile packages are private experimental packages excluded from release families and disabled by shipped profiles. This suite does not claim that surface.
