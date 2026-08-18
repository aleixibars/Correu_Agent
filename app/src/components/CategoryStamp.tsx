import type { CSSProperties } from "react";
import type { TriageCategory } from "@correu-agent/shared";
import { CATEGORY_COLOR_VARS } from "../lib/category-colors";
import { categoryLabel } from "../lib/category-labels";

/**
 * A category rendered as a small ink stamp (design brief signature element):
 * the label text stays a plain text node so pages that assert on
 * `CATEGORY_LABELS[category]` keep working unchanged.
 */
export const CategoryStamp = ({
  category,
  muted = false,
}: {
  category: TriageCategory;
  /** Flat, unrotated treatment for categories that are never auto-replied to. */
  muted?: boolean;
}) => (
  <span
    className={`stamp${muted ? " stamp--muted" : ""}`}
    style={{ "--stamp-color": CATEGORY_COLOR_VARS[category] } as CSSProperties}
  >
    {categoryLabel(category)}
  </span>
);
