import { resolveReference } from "../../core/src/resolver.js";

export const StatusBadge = ({ reference }) => <span>{resolveReference(reference)}</span>;
