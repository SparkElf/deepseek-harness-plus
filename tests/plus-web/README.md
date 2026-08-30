# Plus Web Playwright system acceptance

English | [中文](README.zh.md)

This runner verifies the npm/profile/apply distribution through the real Plus Web UI. It does not launch Desktop or the tray, reuse production port 3080, mutate the supplied model seed home, mock browser requests, or use API calls for business setup and assertions. It reads `settings.yaml` as structured data and writes only the provider, model, safe protocol, Responses compatibility, and default-model fields matching `DSH_PLUS_TEST_MODEL_LABEL`; it copies `.credentials.yaml` opaquely. It prints neither file, and teardown deletes both isolated seed files.

## Prerequisites

The standard command builds the candidate first so every local npm tarball contains its published Host and Client artifacts. The runner requires `DSH_PLUS_TEST_MODEL_SEED_HOME`, the visible current GPT name in `DSH_PLUS_TEST_MODEL_LABEL`, `DSH_MINERU_ENDPOINT`, and `DSH_DATAOPS_BASE_URL`. When the real DataOps Web requires account login, `DSH_PLUS_TEST_DATAOPS_USERNAME` and `DSH_PLUS_TEST_DATAOPS_PASSWORD` are consumed only by the visible browser form; their values are not written to runtime metadata or repository files. Playwright tracing is disabled when the password variable is present because action traces retain form-fill arguments; page, console, and network diagnostics remain enforced.

```bash
pnpm run test:plus-web
```

Global setup creates an ignored `.cache/plus-web-system` tree, seeds only the current GPT settings and credentials into its isolated home, checks out exact official revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`, packs the local Plus capability and patch packages, installs them through `dsh plugin --profile plus add`, executes `dsh-plus apply`, builds the patched official source, creates an isolated Workspace directory selected through the official browser picker, and launches the resulting profile at `http://127.0.0.1:3081`. Each browser context enters through the clean root URL without a process token or browser cookie; every UI workflow therefore crosses the Plus-selected disabled policy and the retained Host/Origin trust fence. The runtime owns only its recorded process group and stops it in global teardown. The isolated home, deployment lock, Web log, traces, screenshots, videos, and HTML report remain under that cache for diagnosis and are replaced by the next run.

The DataOps case keeps the current visible GPT model and selects its provider-published **Low** reasoning effort through the browser for the bounded SQL/dsh-genui-chart workflow. The desktop cases cover the Responses gateway setting, Subagent settings persistence, streamed Backup failure recovery and restoration, Document parsing and durable Chat/Trajectory cards, DataOps authorization and the expired-grant shell-modal recovery entry, GPT tool execution and dsh-genui chart rendering, Better Sidebar, dshmarket, and official Turn folding. One mobile case covers the installed Mobile Bridge/layout path at a 390x844 viewport. Every case records page errors with stacks, console errors, failed requests including CORS failures, and HTTP failures; failures retain screenshot/video evidence and, when no form password is supplied, trace evidence for stalls.

Agent Teams is not an inherited release capability or part of the tracked accepted composition at this official revision: its service, tools, Client UI, and Web profile packages are private experimental packages excluded from release families and disabled by shipped profiles. This suite does not claim that surface.
