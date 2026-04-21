import { describe, expect, it } from "vitest";
import { createIssueWorkProductSchema } from "@paperclipai/shared";

const baseWorkProduct = {
  type: "pull_request",
  provider: "github",
  title: "PR 42",
};

describe("work product URL validation", () => {
  it("accepts http and https URLs", () => {
    expect(createIssueWorkProductSchema.safeParse({
      ...baseWorkProduct,
      url: "https://github.com/paperclipai/paperclip/pull/42",
    }).success).toBe(true);
    expect(createIssueWorkProductSchema.safeParse({
      ...baseWorkProduct,
      url: "http://127.0.0.1:3100/preview",
    }).success).toBe(true);
  });

  it("rejects executable and local-file URL schemes", () => {
    for (const url of ["javascript:alert(document.domain)", "file:///Users/operator/.ssh/id_rsa", "data:text/html,hello"]) {
      const result = createIssueWorkProductSchema.safeParse({
        ...baseWorkProduct,
        url,
      });
      expect(result.success).toBe(false);
    }
  });
});
