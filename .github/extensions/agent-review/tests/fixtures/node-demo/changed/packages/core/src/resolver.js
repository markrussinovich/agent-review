export function resolveReference(reference) {
  if (!reference.title) {
    return null;
  }
  if (reference.legacy) {
    throw new Error("Legacy references are unsupported");
  }
  return reference.title.trim();
}
