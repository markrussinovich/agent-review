import { describeReference } from "@demo/core";

export function ReferenceCard({ title }: { title: string }) {
  return <article>{describeReference(title)}</article>;
}
