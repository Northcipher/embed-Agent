# Artifact Validation Agent

`Artifact Validation Agent` 是一个不改代码的真机产物验证系统。

一句话：

```text
CI 或 Coding Agent 产出 artifact，
Artifact Validation Agent 拿 artifact 上真实设备验证，
运行中主动观察并补采集 evidence，
最后把结果回传给人或后续 Coding Agent。
```

它不做：

- 不读代码
- 不改代码
- 不做通用 coding agent
- 不做更好的串口终端
- 不做完整实验室平台

它只做：

- 找到要验证的产物
- 按请求或触发启动真机 run
- 刷机 / 下发 / 启动观察 / 命令检查
- 主动观察关键事件、超时、断连和长时间无输出
- 保存日志、状态、时间线和 evidence
- 生成 Agent Reply / validation report
- 异常时通知

## 文档入口

- [docs/00-START-HERE.md](docs/00-START-HERE.md)
- [docs/README.md](docs/README.md)

## 当前正式方向

当前正式方向以 `Artifact Validation Agent` 文档为准。

旧的 `Embed Agent / Board Run MCP / Embedded Runtime MCP` 文档保留为探索历史和调研参考，不再作为当前产品主线。
