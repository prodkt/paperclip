import { describe, expect, it } from "vitest";
import { safeActionHref } from "./safeLinks";

describe("safeActionHref", () => {
  it("allows http, https, app-relative paths, and explicit hash links", () => {
    expect(safeActionHref("https://example.com/pr/42")).toBe("https://example.com/pr/42");
    expect(safeActionHref("http://127.0.0.1:3100/preview")).toBe("http://127.0.0.1:3100/preview");
    expect(safeActionHref("/api/attachments/attachment-1/content")).toBe("/api/attachments/attachment-1/content");
    expect(safeActionHref("#document-plan", { allowHash: true })).toBe("#document-plan");
  });

  it("rejects executable, protocol-relative, local-file, and hash links by default", () => {
    expect(safeActionHref("javascript:alert(document.domain)")).toBeNull();
    expect(safeActionHref("//evil.example/path")).toBeNull();
    expect(safeActionHref("file:///Users/operator/.ssh/id_rsa")).toBeNull();
    expect(safeActionHref("#document-plan")).toBeNull();
  });
});
