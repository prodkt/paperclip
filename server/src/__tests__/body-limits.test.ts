import { describe, expect, it } from "vitest";

import {
  PORTABLE_JSON_BODY_LIMIT,
  PORTABLE_JSON_BODY_LIMIT_BYTES,
} from "../http/body-limits.js";

describe("HTTP body limits", () => {
  it("allows PAP-scale portable import JSON payloads", () => {
    expect(PORTABLE_JSON_BODY_LIMIT).toBe("64mb");
    expect(PORTABLE_JSON_BODY_LIMIT_BYTES).toBe(64 * 1024 * 1024);
    expect(PORTABLE_JSON_BODY_LIMIT_BYTES).toBeGreaterThan(10 * 1024 * 1024);
  });
});
