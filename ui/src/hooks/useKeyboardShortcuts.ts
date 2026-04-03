import { useEffect } from "react";
import {
  isKeyboardShortcutTextInputTarget,
  normalizeKeyboardShortcutKey,
} from "../lib/keyboardShortcuts";

interface ShortcutHandlers {
  enabled?: boolean;
  onNewIssue?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
}

export function useKeyboardShortcuts({
  enabled = true,
  onNewIssue,
  onToggleSidebar,
  onTogglePanel,
}: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const key = normalizeKeyboardShortcutKey(e.key);

      // Don't fire shortcuts when typing in inputs
      if (isKeyboardShortcutTextInputTarget(e.target)) {
        return;
      }

      // C → New Issue
      if (key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewIssue?.();
      }

      // [ → Toggle Sidebar
      if (key === "[" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }

      // ] → Toggle Panel
      if (key === "]" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onTogglePanel?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onNewIssue, onToggleSidebar, onTogglePanel]);
}
