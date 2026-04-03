// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function ShortcutHarness({
  onNewIssue,
}: {
  onNewIssue: () => void;
}) {
  useKeyboardShortcuts({ onNewIssue });
  return null;
}

describe("useKeyboardShortcuts", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("treats uppercase C as the new issue shortcut", () => {
    const root = createRoot(container);
    const onNewIssue = vi.fn();

    act(() => {
      root.render(<ShortcutHarness onNewIssue={onNewIssue} />);
    });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "C" }));
    });

    expect(onNewIssue).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });
});
