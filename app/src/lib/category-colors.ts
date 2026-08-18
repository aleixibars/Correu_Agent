import type { TriageCategory } from "@correu-agent/shared";

// Ink-stamp color per category (design brief), kept separate from
// `category-labels.ts` so the copy and the color system can change
// independently. Values are CSS custom properties defined in `globals.css`.
export const CATEGORY_COLOR_VARS: Record<TriageCategory, string> = {
  urgent: "var(--cat-urgent)",
  comercial: "var(--cat-comercial)",
  suport: "var(--cat-suport)",
  facturacio: "var(--cat-facturacio)",
  newsletter: "var(--cat-newsletter)",
  personal: "var(--cat-personal)",
};
