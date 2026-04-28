# Artifact Validation Agent Coding Rules

## Mandatory Reference Check

Before writing or changing implementation code, inspect the relevant local reference code first.

Required mapping:

| Area | Read first |
|---|---|
| MCP server / tools / resources / prompts | `reference-repos/github/modelcontextprotocol-typescript-sdk`, `reference-repos/github/modelcontextprotocol-servers`, `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server` |
| TUI / terminal UI | `reference-repos/github/ink` |
| Serial adapter | `reference-repos/github/node-serialport` |
| LLM provider adapters | `reference-repos/github/openai-node`, `reference-repos/github/anthropic-sdk-typescript` |
| Runtime HTTP API / schema validation | `reference-repos/github/fastify` |
| MCP conformance / protocol behavior | `reference-repos/github/modelcontextprotocol-conformance` |
| Error shape / truncation / cancellation patterns | `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server/embedclaw_mcp` |

Implementation changes must mention which reference paths were checked in the final response.

## Boundary Rules

- Keep `Runtime Server` as the only owner of run state, events, evidence index, and target runtime state.
- Keep MCP / CLI / TUI as thin adapters.
- Do not expose `device_exec` or generic shell execution as the main product interface.
- Do not let MCP server hold device connection state.
- Do not let LLM providers enter `runtime-core`; use provider abstraction only.
- Do not copy reference code verbatim unless explicitly requested; translate patterns into this project's contracts.
