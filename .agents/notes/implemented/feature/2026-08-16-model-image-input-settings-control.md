# Agent Note: Model Image-Input Control in Provider Settings

Status: implemented

English | [中文](2026-08-16-model-image-input-settings-control.zh.md)

## Problem

The pi-ai profile already allowed each configured model to declare `input: [text, image]`, but the Models page exposed only id, display name, context window, and output cap. A user configuring models through Add provider, Add custom provider, or Edit provider therefore had no visible way to mark a model as image-capable. The host then reported the model as text-only and rejected image attachment, model selection, and `read_image` before a request could reach a provider that actually accepted images.

Keeping the capability in the settings document did not close the Web workflow. The model row was already the place where the user describes that exact model's capacities, and compatible model-list endpoints do not report input modalities, so neither discovery nor the route id could supply the missing fact.

## Decision

Every provider flow that renders the shared `ModelListEditor` shows **Supports image input** in each model row's Model capabilities disclosure, directly below the context-window and output-cap fields. This covers adopting a provider, declaring a custom provider, and editing either kind of provider through one component and one persistence path.

Enabling the control writes the model's explicit `input: [text, image]`; disabling it writes `input: [text]`. A false state is explicit instead of deleting `input`, because an absent model declaration may inherit an image-capable route default or installed catalog entry. The row patch keeps every field outside the curated editor set, so toggling image capability cannot delete reasoning, compatibility, or future model metadata.

Discovery does not preselect the control. OpenAI-compatible model listings return identities and sometimes capacities, but no modality fact; only the user may declare image input for an adopted model. The route-level `defaultInput` remains a settings-document option for a deployment that intentionally gives every undescribed model the same fallback.

The hand-written DeepSeek adapter's separate model editor remains text-only because that adapter rejects image content by design. Showing a writable image claim there would make the UI promise a capability the runtime cannot dispatch.

## Alternatives considered

- **Keep image capability in the settings document.** Rejected because every normal provider workflow is available in the Web editor and the missing control leaves Web users with an incomplete model definition.
- **Use only a route-level image switch.** Rejected because one gateway can serve text-only and vision models together; the capability belongs to the model row.
- **Infer capability from model names or listings.** Rejected because model ids are deployment-defined and compatible listing responses do not report modalities.
- **Default every model to image-capable.** Rejected because a wrong positive claim admits an image into durable history before the provider rejects it, while a conservative explicit declaration is reversible before send.
- **Expose a generic modality multiselect.** Rejected while pi-ai supports only text and image input: one binary control states the user decision directly and avoids an empty or image-only configuration that cannot serve the normal text workflow.

## Consequences

A model configured through any shared provider-model row can become image-capable without leaving the page. Saving and reopening the provider restores the control from its explicit declaration; switching it off restores text-only admission even under an image-capable route fallback. Existing models remain unchanged until the user edits the control, and endpoint discovery never changes it implicitly.

The setting changes model capability metadata rather than prompt text. Once enabled for a model whose endpoint really accepts images, the existing attachment admission and pi-ai conversion paths carry durable image inputs; no new request serialization or session event is introduced.
