# @sparkelf/dsh-patch-genui-skill-chart-contract

English | [中文](README.zh.md)

This data-only package fixes two exact @changfenhuang/dsh-genui 0.9.6 gaps. The Host plugin registers its packaged SKILL.md when the public skill registry is available, and its permanent prompt carries the compact chart signature. validate_dsh_ui and render_ui reject the observed variant alias, unsupported kinds, non-string labels, and non-finite values while retaining unknown extension fields.

The payload is built from the public v0.9.6 tag plus only these changes. It contains the npm package's source and built Host artifacts; it composes with the independent streaming-EChart patch without absorbing that patch.

Retire this package when a released @changfenhuang/dsh-genui version contains the same bundled-skill registration and chart contract, and the real DataOps chart path passes without it.
