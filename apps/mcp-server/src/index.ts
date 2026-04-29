// Embed Agent MCP Server — 9 tools with full input schemas
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const s = (p: string) => ({ type: "string", description: p });
const n = (p: string) => ({ type: "number", description: p });
const req = (...keys: string[]) => keys;

export const MCP_TOOLS: McpTool[] = [
  { name: "validate_artifact", description: "Start a validation run",
    inputSchema: { type: "object",
      properties: { artifact_path: s("Artifact path"), target_id: s("Target ID"), expected: s("Expected behavior"),
        concerns: { type: "array", items: s("") } }, required: req("artifact_path","target_id","expected") } },
  { name: "get_run_status", description: "Get run status",
    inputSchema: { type: "object", properties: { run_id: s("Run ID") }, required: req("run_id") } },
  { name: "watch_run", description: "Watch run events",
    inputSchema: { type: "object", properties: { run_id: s("Run ID"), after_seq: n("Cursor") }, required: req("run_id") } },
  { name: "get_run_events", description: "Get historical events",
    inputSchema: { type: "object", properties: { run_id: s("Run ID"), after_seq: n("Cursor"), limit: n("Limit") }, required: req("run_id") } },
  { name: "get_evidence", description: "Get evidence",
    inputSchema: { type: "object", properties: { run_id: s("Run ID"), ref: s("Evidence ref") }, required: req("run_id") } },
  { name: "get_run_result", description: "Get final result",
    inputSchema: { type: "object", properties: { run_id: s("Run ID") }, required: req("run_id") } },
  { name: "intervene_run", description: "Intervene on a run",
    inputSchema: { type: "object", properties: { run_id: s("Run ID"),
      action: { type:"string", enum:["pause","resume","cancel","add_instruction","ignore_rule","override"] },
      instruction: s("Instruction"), rule_id: s("Rule ID"), decision: { type:"string", enum:["continue","stop","cancel"] } }, required: req("run_id","action") } },
  { name: "cancel_run", description: "Cancel a run",
    inputSchema: { type: "object", properties: { run_id: s("Run ID"), reason: s("Reason") }, required: req("run_id") } },
  { name: "get_target_capabilities", description: "Get target capabilities",
    inputSchema: { type: "object", properties: { target: s("Target ID") }, required: req("target") } },
];
