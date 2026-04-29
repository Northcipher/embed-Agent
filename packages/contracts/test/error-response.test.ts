import { describe, it, expect } from "vitest";
import { makeError } from "../src/error-response.js";
import { ERROR_CODES } from "../src/error.js";

describe("ErrorResponse", () => {
  it("should create error with all fields", () => {
    const resp = makeError("target_busy", "Target board-01 is busy");
    expect(resp.status).toBe("error");
    expect(resp.error_code).toBe("target_busy");
    expect(resp.message).toBe("Target board-01 is busy");
  });

  it("should include optional details", () => {
    const resp = makeError("target_not_ready", "Pre-flight failed", {
      failed_checks: ["serial_open", "adb_connect"],
    });
    expect(resp.details).toBeDefined();
  });

  it("all error codes should be usable", () => {
    for (const code of ERROR_CODES) {
      const resp = makeError(code, `Test: ${code}`);
      expect(resp.error_code).toBe(code);
      expect(resp.status).toBe("error");
    }
  });
});
