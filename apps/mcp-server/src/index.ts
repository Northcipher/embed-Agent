// Embed Agent MCP Server — tool definitions
export const MCP_TOOLS = [
  { name: "validate_artifact", description: "Start a validation run" },
  { name: "get_run_status", description: "Get current run status" },
  { name: "watch_run", description: "Watch run events" },
  { name: "get_run_events", description: "Get historical run events" },
  { name: "get_evidence", description: "Get evidence index or content" },
  { name: "get_run_result", description: "Get final run result" },
  { name: "intervene_run", description: "Intervene on a running run" },
  { name: "cancel_run", description: "Cancel a running run" },
  { name: "get_target_capabilities", description: "Get target capabilities" },
] as const;
