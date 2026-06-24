import { describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("./client", () => ({
  api: mockApi,
}));

import { subscriptionCredentialsApi } from "./subscriptionCredentials";

describe("subscriptionCredentialsApi", () => {
  it("uses company-scoped endpoints and preserves the redacted client contract", async () => {
    mockApi.get.mockResolvedValue([]);
    mockApi.put.mockResolvedValue({
      id: "cred-1",
      provider: "claude",
    });
    mockApi.post.mockResolvedValue({
      id: "cred-1",
      provider: "claude",
    });
    mockApi.delete.mockResolvedValue(undefined);

    await subscriptionCredentialsApi.list("company-1");
    await subscriptionCredentialsApi.get("company-1", "cred-1");
    await subscriptionCredentialsApi.upsert("company-1", {
      provider: "claude",
      credentialKind: "claude_oauth_token",
      material: "secret-token",
      status: "active",
    });
    await subscriptionCredentialsApi.recordTestResult("company-1", "cred-1", {
      testStatus: "ready",
    });
    await subscriptionCredentialsApi.remove("company-1", "cred-1");

    expect(mockApi.get).toHaveBeenNthCalledWith(1, "/companies/company-1/subscription-credentials");
    expect(mockApi.get).toHaveBeenNthCalledWith(2, "/companies/company-1/subscription-credentials/cred-1");
    expect(mockApi.put).toHaveBeenCalledWith("/companies/company-1/subscription-credentials", {
      provider: "claude",
      credentialKind: "claude_oauth_token",
      material: "secret-token",
      status: "active",
    });
    expect(mockApi.post).toHaveBeenCalledWith(
      "/companies/company-1/subscription-credentials/cred-1/test-result",
      {
        testStatus: "ready",
      },
    );
    expect(mockApi.delete).toHaveBeenCalledWith("/companies/company-1/subscription-credentials/cred-1");
  });
});
