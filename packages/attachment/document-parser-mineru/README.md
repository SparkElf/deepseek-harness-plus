# @deepseek-ai/dsh-document-parser-mineru

English | [中文](README.zh.md)

MinerU HTTP implementation for the Harness [`documentParser`](../document-parser/README.md) capability. It registers provider id `mineru` and calls one externally managed MinerU synchronous `/file_parse` endpoint. The Node package does not embed Python, PyTorch, model weights, GPU lifecycle, or MinerU process management.

## Config

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | required | Absolute MinerU synchronous `/file_parse` URL. |
| `timeoutMs` | required | Positive wall-clock timeout for one parse request. |
| `maxResponseBytes` | required | Positive bound applied to the compressed HTTP response and to the aggregate extracted ZIP output. |

```yaml
- id: document-parser-mineru
  name: '@deepseek-ai/dsh-document-parser-mineru'
  config:
    endpoint: 'http://127.0.0.1:8000/file_parse'
    timeoutMs: 120000
    maxResponseBytes: 67108864
```

The [base bundle](../../bundle/base/cordis.patch.yml) installs the `document-parser` and `document-parser-mineru` rows disabled. A deployment enables both rows together in a later patch layer and changes these explicit values as needed; enabling only the Definition intentionally publishes no document picker capability.

The provider sends the original durable document bytes as multipart input and requests Markdown, `content_list`, extracted images, and ZIP output. It explicitly disables `middle.json`, raw model output, and original-file return because Harness already owns the original durable object.

## Output validation

A successful ZIP must contain exactly one Markdown result and exactly one version-one `content_list` JSON result. Extracted images are accepted only when their bytes are one of the attachment subsystem's supported raster formats. Missing or ambiguous final artifacts, malformed ZIP output, response/output overflow, HTTP failures, aborts, and timeouts fail explicitly before the owning user event is appended by the Host.

Temporary ZIP entry paths never enter session state. The Host persists final Markdown, `content_list`, and extracted images through the existing content-addressed attachment store and records only durable references.

## Model Experience

### MinerU parsed document projection

#### What the model sees

MinerU's complete Markdown is the provider-neutral representation sent to text-capable models after durable resolution. `content_list` and extracted images remain durable for document tools but are not automatically injected into model requests.

#### Token effect

The complete rendered Markdown contributes tokens on every request that includes the document message. MinerU does not add parser metadata, `content_list`, extracted images, or HTTP/ZIP details to the request.

#### KV Cache effect

No provider-specific cache behavior is introduced. Once accepted, the complete Markdown behaves as ordinary model-visible text at the document message position; parser HTTP/ZIP details never enter the model prefix.

## Known Limitations and Deferred Work

- **Only synchronous `/file_parse` is used.** MinerU `/tasks` identifiers are not persisted as Harness job state.
- **No DSH-owned parser tuning surface yet.** Backend, OCR, table, formula, and effort choices follow the configured MinerU deployment until product evidence justifies provider-neutral controls.
- **The ZIP parser expects one final Markdown/content-list pair per submitted document.** Multi-document batch semantics are intentionally handled by Host admission as separate parser calls.
- **Extracted images are retained for fidelity, not automatically injected.** Future document tools can use the durable `content_list` mapping to inspect selected pages, tables, charts, or images.
