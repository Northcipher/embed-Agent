# 文档归档

这里保存已经退出当前主线、但仍有历史参考价值的文档。

归档规则：

```text
归档文档不是当前实现依据。
当前实现以 docs/README.md 和 docs/00-START-HERE.md 列出的主线文档为准。
如果归档内容和主线文档冲突，以主线文档为准。
```

## 目录

| 目录 | 内容 | 归档原因 |
|---|---|---|
| `2026-04-embed-agent-exploration/` | 早期 Embed Agent 产品、角色、功能、场景、可用性探索。 | 方向已从“更智能的 Embed Agent / runtime”收敛为 Artifact Validation Agent。 |
| `2026-04-embedded-runtime-research/` | Embedded Runtime / GitHub / 痛点调研。 | 作为背景研究保留，不再作为当前产品主线。 |
| `2026-04-tooling-research/` | Terminal tools research。 | 作为工具调研保留，当前系统不做“更好的终端工具”。 |
| `2026-04-architecture-drafts/` | Runtime-first 架构比对稿。 | 已合并进主架构文档。 |

## 读取建议

正常实现不需要读这里。

只有在需要理解历史决策时再看：

```text
为什么不继续做 Embed Agent？
为什么不做通用设备 runtime？
为什么不做 terminal / serial / adb wrapper？
为什么主架构改成 Runtime-first？
```
