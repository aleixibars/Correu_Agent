// Què es pot ensenyar dins del tauler i què només es pot baixar (issue #78).
//
// La llista és curta a posta i no és només una qüestió d'ergonomia: un adjunt
// el serveix el mateix origen que el tauler, així que servir-ne un d'HTML per a
// veure'l al navegador seria deixar que un remitent qualsevol executés codi amb
// la sessió de qui llegeix el correu. Només els tipus que el navegador pinta
// sense executar-los surten d'aquí com a previsualitzables.

/** Tipus concrets que el navegador pinta sense executar res. */
const PREVIEWABLE_TYPES = new Set(["application/pdf"]);

/**
 * Les imatges es previsualitzen totes menys SVG: un SVG és un document que pot
 * portar `<script>`, i per al navegador no és una imatge inerta com un PNG.
 */
const SCRIPTABLE_IMAGE_TYPE = "image/svg+xml";

/** El tipus sense els paràmetres (`; charset=...`) i en minúscules, o null. */
export const normaliseMimeType = (mimeType: string | null): string | null => {
  const base = mimeType?.split(";")[0]?.trim().toLowerCase();
  return base ? base : null;
};

/** Cert quan l'adjunt es pot obrir dins del tauler en lloc de només baixar-lo. */
export const isPreviewable = (mimeType: string | null): boolean => {
  const type = normaliseMimeType(mimeType);
  if (type === null) return false;
  return (
    PREVIEWABLE_TYPES.has(type) ||
    (type.startsWith("image/") && type !== SCRIPTABLE_IMAGE_TYPE)
  );
};

const SIZE_UNITS = ["B", "kB", "MB", "GB"] as const;

const sizeFormat = new Intl.NumberFormat("ca-ES", { maximumFractionDigits: 1 });

/** La mida d'un adjunt tal com es llegeix a la llista; null quan el proveïdor no en diu cap. */
export const formatAttachmentSize = (sizeBytes: number | null): string | null => {
  if (sizeBytes === null || !Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return null;
  }

  let size = sizeBytes;
  let unit = 0;
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${sizeFormat.format(unit === 0 ? size : Number(size.toFixed(1)))} ${SIZE_UNITS[unit]}`;
};
