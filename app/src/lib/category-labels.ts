import type { TriageCategory } from "@correu-agent/shared";

// Catalan display labels for the dashboard UI (context.md §11: dashboard in
// Catalan). Keyed on the internal TriageCategory identifiers from `shared/`.
export const CATEGORY_LABELS: Record<TriageCategory, string> = {
  urgent: "Urgent",
  comercial: "Comercial/Vendes",
  suport: "Suport/Atenció al client",
  facturacio: "Facturació/Administració",
  newsletter: "Newsletter/Spam",
  personal: "Personal/Altres",
};

export const categoryLabel = (category: TriageCategory): string =>
  CATEGORY_LABELS[category];
