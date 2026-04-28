#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import React from "react";
import { Box, Spacer, Text, render } from "ink";
import type {
  EvidenceIndex,
  GetRunResultResponse,
  RunEvent,
  RunStatusResponse
} from "@artifact-validation/contracts";

export interface RunCockpitData {
  status: RunStatusResponse;
  events: RunEvent[];
  evidence: EvidenceIndex;
  result: GetRunResultResponse;
}

interface RunCockpitProps {
  data: RunCockpitData;
}

export function createRunCockpitFixture(): RunCockpitData {
  const runId = "run-001";
  const evidencePath = ".artifact-agent/runs/run-001";

  return {
    status: {
      run_id: runId,
      status: "running",
      phase: "runtime validation",
      current_step: {
        id: "step-watch-serial",
        capability: "watch_serial",
        started_at: "2026-04-28T01:00:10.000Z",
        timeout_sec: 180
      },
      target: {
        target_id: "board-01",
        state: "booting",
        serial: "connected",
        adb: "offline",
        current_run_id: runId,
        last_heartbeat_at: "2026-04-28T01:00:21.000Z",
        updated_at: "2026-04-28T01:00:22.000Z"
      },
      elapsed_sec: 42,
      last_event_seq: 7,
      evidence_path: evidencePath
    },
    events: [
      {
        seq: 5,
        run_id: runId,
        time: "2026-04-28T01:00:15.000Z",
        elapsed_sec: 35,
        type: "step_started",
        severity: "info",
        source: "orchestrator",
        step_id: "step-watch-serial",
        summary: "Started watch_serial for boot diagnostics"
      },
      {
        seq: 6,
        run_id: runId,
        time: "2026-04-28T01:00:18.000Z",
        elapsed_sec: 38,
        type: "rule_matched",
        severity: "error",
        source: "rule_engine",
        step_id: "step-watch-serial",
        summary: "Matched kernel panic signature on serial output",
        payload: {
          pattern: "kernel panic",
          action: "collect_more"
        },
        evidence_refs: ["serial:last-200-lines"]
      },
      {
        seq: 7,
        run_id: runId,
        time: "2026-04-28T01:00:20.000Z",
        elapsed_sec: 40,
        type: "evidence_collected",
        severity: "info",
        source: "evidence_store",
        step_id: "step-watch-serial",
        summary: "Saved serial window around kernel panic",
        evidence_refs: ["serial:last-200-lines"]
      }
    ],
    evidence: {
      run_id: runId,
      partial: true,
      updated_at: "2026-04-28T01:00:21.000Z",
      root_path: evidencePath,
      refs: [
        {
          ref: "serial:last-200-lines",
          kind: "window",
          path: ".artifact-agent/runs/run-001/evidence/serial-last-200-lines.log",
          available: true,
          bytes: 8192
        },
        {
          ref: "snapshot:panic",
          kind: "snapshot",
          path: ".artifact-agent/runs/run-001/evidence/panic-snapshot.json",
          available: false
        }
      ],
      key_events: [
        {
          seq: 6,
          summary: "kernel panic before adb became ready",
          evidence_refs: ["serial:last-200-lines"]
        }
      ]
    },
    result: {
      run_id: runId,
      status: "running",
      result_available: false
    }
  };
}

export const fixtureRunCockpitData = createRunCockpitFixture();

export function RunCockpit({ data }: RunCockpitProps): React.ReactElement {
  const currentStep = data.status.current_step;
  const targetId = data.status.target.target_id ?? "unknown";
  const resultText = "result_available" in data.result ? "result unavailable" : data.result.status;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Header title="Run Cockpit" right={`seq ${data.status.last_event_seq}`} />

      <Section title="Run">
        <KeyValue label="run" value={data.status.run_id} />
        <KeyValue label="status" value={data.status.status} />
        <KeyValue label="phase" value={data.status.phase ?? "n/a"} />
        <KeyValue label="elapsed" value={`${data.status.elapsed_sec}s`} />
        <KeyValue label="evidence" value={data.status.evidence_path} />
      </Section>

      <Section title="Target">
        <KeyValue label="target" value={targetId} />
        <KeyValue label="state" value={data.status.target.state} />
        <KeyValue label="serial" value={data.status.target.serial ?? "unknown"} />
        <KeyValue label="adb" value={data.status.target.adb ?? "unknown"} />
      </Section>

      <Section title="Current Step">
        {currentStep ? (
          <>
            <KeyValue label="step" value={currentStep.id} />
            <KeyValue label="capability" value={currentStep.capability} />
            <KeyValue label="timeout" value={`${currentStep.timeout_sec}s`} />
          </>
        ) : (
          <Text dimColor>No active step</Text>
        )}
      </Section>

      <Section title="Timeline">
        {data.events.map((event) => (
          <Text key={event.seq}>
            {formatSeq(event.seq)} {event.severity} {event.type}: {event.summary}
            {event.evidence_refs?.length ? ` [${event.evidence_refs.join(", ")}]` : ""}
          </Text>
        ))}
      </Section>

      <Section title="Evidence">
        <KeyValue label="partial" value={String(data.evidence.partial)} />
        {data.evidence.refs.map((ref) => (
          <Text key={ref.ref}>
            {ref.ref} - {ref.kind} - {ref.available ? "available" : "pending"}
          </Text>
        ))}
        {data.evidence.key_events.map((event) => (
          <Text key={event.seq}>key event {event.seq}: {event.summary}</Text>
        ))}
      </Section>

      <Section title="Result">
        <Text>{resultText}</Text>
      </Section>
    </Box>
  );
}

function Header({ title, right }: { title: string; right: string }): React.ReactElement {
  return (
    <Box borderStyle="single" paddingX={1} marginBottom={1}>
      <Text bold>{title}</Text>
      <Spacer />
      <Text dimColor>{right}</Text>
    </Box>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column" paddingLeft={2}>
        {children}
      </Box>
    </Box>
  );
}

function KeyValue({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <Text>
      {label}: {value}
    </Text>
  );
}

function formatSeq(seq: number): string {
  return `#${seq.toString().padStart(3, "0")}`;
}

export function main(): void {
  render(<RunCockpit data={fixtureRunCockpitData} />);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
