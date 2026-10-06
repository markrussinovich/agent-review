import { resolveReference } from "../../core/src/resolver.js";
import colors from "picocolors";

export const StatusBadge = ({ reference }) => {
  const title = resolveReference(reference);
  if (!title) {
    return <span>Missing title</span>;
  }
  return <span>{colors.green(title)}</span>;
};
