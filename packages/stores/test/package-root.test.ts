import { describe, it, expect } from "vitest";
import { EventStore, EvidenceStore, RunStore, TargetStore, MemoryStore } from "../src/index.js";

describe("package root imports", () => {
  it("all stores are constructable from package root", () => {
    expect(new EventStore()).toBeInstanceOf(EventStore);
    expect(new EvidenceStore()).toBeInstanceOf(EvidenceStore);
    expect(new RunStore()).toBeInstanceOf(RunStore);
    expect(new TargetStore()).toBeInstanceOf(TargetStore);
    expect(new MemoryStore()).toBeInstanceOf(MemoryStore);
  });
});
