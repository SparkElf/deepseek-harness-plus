# @sparkelf/dsh-patch-ptc-mcp-schema-types

English | [中文](README.zh.md)

This data-only package keeps TypeScript PTC declarations precise when MCP tools advertise JSON Schema draft markers, string length or pattern constraints, and array item-count constraints. The projection omits only those validation keywords while retaining object, array, property, required, and scalar types. Unsupported structural keywords still render as `unknown`.

The ToolRuntime enforced Schema subset remains unchanged, and the MCP server continues to validate the complete original Schema. The target is exact official source revision `b2e3b2a0125854567a4a5fcba75782e42fe84901`.

Retire this package when official DSH projects the same validation-only MCP keywords into PTC declarations without weakening runtime Schema enforcement.
