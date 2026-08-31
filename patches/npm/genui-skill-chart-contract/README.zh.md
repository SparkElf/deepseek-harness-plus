# @sparkelf/dsh-patch-genui-skill-chart-contract

[English](README.md) | 中文

该data-only package修复exact @changfenhuang/dsh-genui 0.9.6的两个gap。Host plugin会在public skill registry可用时注册package内的SKILL.md，permanent prompt携带紧凑chart签名。validate_dsh_ui与render_ui会拒绝已观察到的variant alias、不支持的kind、非string label及非finite value，同时保留unknown extension fields。

payload从public v0.9.6 tag构建且只加入这些改动。它包含npm package的source及built Host artifacts；它与independent streaming-EChart patch组合，不吸收该patch。

released @changfenhuang/dsh-genui version包含同样的bundled-skill registration及chart contract，且真实DataOps chart path在不使用本patch时通过后，retire本package。
