import { describeReference } from "@demo/core";
import uniq from "lodash/uniq.js";

export function ReferenceCard({ title }: { title: string }) {
  const labels = uniq([describeReference(title), "Reviewed"]);
  return <article aria-label="Reference">{labels.join(" · ")}</article>;
}
