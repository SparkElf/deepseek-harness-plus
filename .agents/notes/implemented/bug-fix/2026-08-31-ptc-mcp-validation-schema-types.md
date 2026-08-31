# Agent Note: PTC projects validation-only MCP Schema keywords

Status: implemented

English | [中文](2026-08-31-ptc-mcp-validation-schema-types.zh.md)

## Problem

MCP `tools/list` commonly includes draft markers and string or array validation constraints around an otherwise ordinary object Schema. The TypeScript PTC generator used the ToolRuntime enforced Schema assertion, so any such keyword widened the complete tool argument declaration to `unknown` even though object properties and required fields were available. Models then had no declared parameter names for MCP bindings.

## Decision

The TypeScript PTC projection has its own assertion over the shared JSON Schema structure. It ignores only `$schema`, `minLength`, `maxLength`, `pattern`, `minItems`, and `maxItems`, because those keywords constrain values without changing their TypeScript categories. It retains object, array, property, required, scalar, enum, const, and `oneOf` declarations. Unsupported structural keywords still produce `unknown`.

`assertSupportedJsonSchema` remains the runtime enforcement assertion and continues to reject every keyword outside its closed subset. MCP servers receive and validate the original Schema without normalization.

## Alternatives considered

**Teach every model-facing prompt the missing parameter names.** Rejected because it duplicates each tool Schema in prose and drifts as MCP tools change.

**Accept the extra keywords in ToolRuntime validation.** Rejected because the runtime validator does not enforce their semantics; accepting them would claim constraints that execution ignores.

**Remove the validation keywords from the MCP server.** Rejected because the server is the ingress owner and must retain its length, pattern, and item-count checks.

## Consequences

PTC models receive usable TypeScript parameter declarations for common MCP draft-07 Schemas while the original server remains the sole owner of the omitted constraints. TypeScript cannot express those runtime limits, so calls may still fail when values violate them. Focused core-tools coverage pins the DataOps `sources` array case, the unchanged runtime rejection, and the continued `unknown` result for structural `allOf`.
