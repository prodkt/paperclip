export function safeActionHref(href: string | null | undefined, options: { allowHash?: boolean } = {}) {
  const trimmed = href?.trim();
  if (!trimmed) return null;

  if (options.allowHash && trimmed.startsWith("#")) {
    return trimmed;
  }

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return trimmed;
    }
  } catch {
    return null;
  }

  return null;
}
