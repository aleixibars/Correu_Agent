// Els identificadors de fil i d'esborrany arriben per la URL o per un formulari
// (context.md §2), així que són text arbitrari fins que es comprova. Postgres
// rebutja un uuid mal format amb un error de sintaxi, i això arribaria a
// l'usuari com un 500 en lloc del "això no existeix" que realment és.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the value has the shape of the uuid every id column stores. */
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);
