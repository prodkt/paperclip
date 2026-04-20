import { describe, expect, it } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";

describe("conference room wake prompt", () => {
  it("adds conference mode guidance for conference room issues", () => {
    const prompt = renderPaperclipWakePrompt({
      reason: "issue_commented",
      issue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-99",
        title: "New chat",
        status: "todo",
        priority: "medium",
        originKind: "conference_room",
        originId: "22222222-2222-4222-8222-222222222222",
      },
      comments: [
        {
          id: "33333333-3333-4333-8333-333333333333",
          issueId: "11111111-1111-4111-8111-111111111111",
          body: "What should we work on next?",
          createdAt: "2026-04-18T13:15:52.900Z",
          author: { type: "user", id: "board" },
        },
      ],
      commentWindow: { requestedCount: 1, includedCount: 1, missingCount: 0 },
    });

    expect(prompt).toContain("## Conference Room Mode");
    expect(prompt).toContain("This issue is a board chat with you");
    expect(prompt).toContain("Paperclip will mark the chat issue done until the board sends another message");
    expect(prompt).toContain("If the issue title is still `New chat`");
  });
});
