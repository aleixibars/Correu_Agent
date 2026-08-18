// Un correu sense assumpte arriba com a cadena buida, no com a null: Gmail
// envia la capçalera `Subject:` buida i Graph un `subject` buit. Sense això el
// fil es llistaria com una línia en blanc i semblaria trencat. Compartit entre
// la llista de fils i el digest perquè un fil es digui igual als dos llocs.
export const subjectLabel = (subject: string | null): string =>
  subject !== null && subject.trim() !== "" ? subject : "(Sense assumpte)";
