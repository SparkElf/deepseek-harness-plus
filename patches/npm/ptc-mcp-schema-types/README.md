# @sparkelf/dsh-patch-ptc-mcp-schema-types

English | [中文](README.zh.md)

This data-only package keeps TypeScript PTC declarations precise when MCP tools advertise JSON Schema draft markers, string length or pattern constraints, and array item-count constraints. The projection omits only those validation keywords while retaining object, array, property, required, and scalar types. Unsupported structural keywords still render as `unknown`.

The ToolRuntime enforced Schema subset remains unchanged, and the MCP server continues to validate the complete original Schema. The target is exact official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`.

Retire this package when official DSH projects the same validation-only MCP keywords into PTC declarations without weakening runtime Schema enforcement.
