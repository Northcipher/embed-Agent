# Local Reference Repositories

These repositories are local read-only references for implementation work. They are intentionally ignored by git and should not be treated as vendored dependencies.

## GitHub Repositories

| Local path | Source | Commit |
|---|---|---|
| `reference-repos/github/modelcontextprotocol-typescript-sdk` | `https://github.com/modelcontextprotocol/typescript-sdk.git` | `2a7611d` |
| `reference-repos/github/modelcontextprotocol-servers` | `https://github.com/modelcontextprotocol/servers.git` | `4503e2d` |
| `reference-repos/github/modelcontextprotocol-conformance` | `https://github.com/modelcontextprotocol/conformance.git` | `d944122` |
| `reference-repos/github/ink` | `https://github.com/vadimdemedes/ink.git` | `dc48987` |
| `reference-repos/github/node-serialport` | `https://github.com/serialport/node-serialport.git` | `9fa6881` |
| `reference-repos/github/openai-node` | `https://github.com/openai/openai-node.git` | `35feb53` |
| `reference-repos/github/anthropic-sdk-typescript` | `https://github.com/anthropics/anthropic-sdk-typescript.git` | `74ac150` |
| `reference-repos/github/fastify` | `https://github.com/fastify/fastify.git` | `4965dac` |

## Local Reference

| Local path | Purpose |
|---|---|
| `/Users/luozx/work/embedclaw/EmbedClaw/mcp-server` | Optional local reference on the primary development machine: thin dispatch, handler registry, unified response, truncation, error sanitization, cancellation patterns. |

## Rule

Before coding in this project, inspect the relevant reference path first and mention the inspected reference paths in the final response.

Do not copy reference code verbatim. Use it to guide structure, contracts, tests, and safety boundaries.
