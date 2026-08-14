# Agent Note: OpenAI-compatible model capabilities and image generation

Status: proposed

English | [中文](2026-08-14-openai-compatible-model-capabilities-and-image-generation.zh.md)

## Problem

The Models settings page can create a hand-declared pi-ai provider, but it presents that path as a generic custom provider. Users cannot immediately recognize an OpenAI-compatible gateway, see its default context or output capacity, or declare image input and output on the provider and model that own those facts. Context window and maximum output tokens exist only behind a collapsed model-row control.

The durable attachment design already provides assistant image references and rendering, but no production provider route can generate one. An image-output checkbox without an execution path would promise a result the runtime cannot produce.

## Proposal

### One configuration owner

The <code>llm-pi-ai</code> provider profile remains the only stored owner of provider route, endpoint, credential reference, chat protocol, capacities, input modalities, and output modalities.

- Provider defaults use <code>defaultContextWindow</code>, <code>defaultMaxTokens</code>, <code>defaultInput</code>, and <code>defaultOutput</code>.
- Model entries and overrides use <code>contextWindow</code>, <code>maxTokens</code>, <code>input</code>, and <code>output</code>.
- Input <code>image</code> enables the existing image-understanding prompt path.
- Output <code>image</code> marks a model eligible for the image-generation operation. It does not claim that a normal chat stream emits images.
- A route that declares image output names <code>imageApi: openai-images</code>. This is explicit configuration, never endpoint inference.

The settings UI adds an **OpenAI-compatible provider** entry point and retains an advanced path for other wire protocols. It shows provider defaults for context window, maximum output tokens, image understanding, and image generation. The model-row disclosure provides equivalent per-model overrides.

### Runtime path

<code>dsh-llm</code> gains one provider-routed image-generation operation beside its stream operation. It resolves the same provider, model, and credential route as chat. <code>agent-loop</code> does not change: a scoped image-generation tool calls <code>ctx.llm</code> and returns a normal tool result.

<code>dsh-llm-pi-ai</code> implements the operation only for a model whose resolved output includes <code>image</code> and whose profile names <code>openai-images</code>. It posts one prompt to the configured base URL's <code>/images/generations</code> endpoint and requires <code>b64_json</code>. A provider URL is refused rather than fetched.

The adapter bounds the received response from attachment policy, decodes it, validates and saves the image through the existing attachment service, then returns an <code>ImageAttachmentRef</code>. The tool returns that reference as image content. Existing tool-result persistence and assistant image rendering consume it without a new agent-loop event or a second image store.

### Package ownership

| Category | Owner | Change |
| --- | --- | --- |
| Main capability path | <code>packages/llm/llm</code> | Add output-modality metadata and provider-routed image generation. |
| Provider plugin | <code>packages/llm/llm-pi-ai</code> | Resolve output modalities, validate <code>openai-images</code>, call the Images API, and persist the returned image. |
| Tool plugin | new <code>packages/extensions/tool-image-generation</code> | Expose the operation to an agent and return a durable image reference. |
| Settings UI plugin | <code>packages/client/ui-settings-models</code> | Add OpenAI-compatible entry, provider defaults, and per-model capability controls. |
| Reused modules | <code>packages/attachment/*</code>, <code>packages/client/ui-conversation</code>, tool-result projection | Save, persist, and render the reference unchanged. |
| Explicitly untouched | <code>packages/core/agent-loop</code>, <code>packages/core/session</code>, <code>packages/host/apiproxy</code> | Existing tool lifecycle and durable image content provide execution and history. |

This extends the [durable attachment decision](../../implemented/feature/2026-07-22-web-multimodal-image-input-and-durable-attachments.md). When shipped, its statement that no production provider route supports image output is updated in place.

### User path and failures

1. A user selects **OpenAI-compatible provider**, enters endpoint and key, and chooses the chat protocol.
2. The user sets provider defaults, then adds models that inherit or override context, output tokens, image understanding, and image generation.
3. Image prompts are admitted only for a model that declares image input.
4. An agent calls the image-generation tool with an image-capable model and prompt. The generated image appears as a durable tool-result image.
5. Unsupported models, a missing image API declaration, provider rejection, non-base64 output, oversized response, invalid image, or attachment failure return an actionable error and publish no partial image block.

## Alternatives considered

**Relabel only the existing custom-provider card.** This improves discovery but leaves capability defaults hidden and cannot make image generation real.

**Add an image-output checkbox without a runtime operation.** The existing chat stream carries text, reasoning, and tool calls, not generated image content. This would be a false capability claim.

**Teach <code>agent-loop</code> to call the Images API.** Provider protocol, endpoint, credential, attachment, and output-format handling belong to the LLM adapter. A tool over the LLM capability keeps them out of the loop.

**Create a parallel image-provider settings namespace.** This duplicates endpoint, credential, and model facts. The pi-ai provider profile already owns them.

**Fetch provider image URLs.** A response URL would introduce a remote request controlled by an external response. Requiring <code>b64_json</code> limits the adapter to configured-request bytes.

## Acceptance criteria

- The Models page has a recognizable OpenAI-compatible path and exposes default context, output-token, image-input, and image-output settings.
- Models inherit or override each default without rebuilding unrelated profile fields.
- Image-input models use the existing prompt path; text-only models are refused before attachment persistence.
- An <code>openai-images</code> model generates one durable image through the image-generation tool.
- The image is saved through <code>AttachmentStore</code>, rendered in conversation, and available after reload.
- Malformed results and failures do not publish a partial image block.
- The PR ownership map names the main LLM seam, adapter, tool, UI plugin, reused modules, and untouched agent loop.

## Risks

OpenAI-compatible gateways can support chat while rejecting the Images API. The UI requires explicit image API configuration and does not infer support from a model name. The first version accepts only <code>b64_json</code>; gateways that return temporary URLs remain unsupported until a separately reviewed retrieval policy exists.

Image generation can incur external cost. The tool uses the existing approval policy and does not create a queue, hidden retry, or fallback path.
