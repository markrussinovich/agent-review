export { resolveReference } from "./resolver.js";

export function describeReference(title: string): string {
  if (!title.trim()) {
    return "Untitled reference";
  }
  return title.trim();
}
