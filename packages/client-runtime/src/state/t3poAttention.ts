import type { AttentionItem } from "@t3tools/contracts";
export function uniqueAttention(items: readonly AttentionItem[]): readonly AttentionItem[] {
  return [...new Map(items.map((item) => [item.key, item])).values()];
}
