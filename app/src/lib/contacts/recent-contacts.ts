// Els contactes recents del tenant, per autocompletar els camps Per a / Cc / Cco
// en aprovar un esborrany (context.md §2). No hi ha taula de contactes ni cal:
// `messages` ja acumula totes les adreces vistes, així que les úniques ordenades
// per missatge més recent són la llibreta d'adreces del tenant.

import { and, eq, ilike, ne, sql } from "drizzle-orm";
import type { TablesRelationalConfig } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { messages } from "@correu-agent/shared/db/schema";

/** Prou per a un desplegable sota el camp, i prou poc per llegir-lo d'un cop. */
export const DEFAULT_RECENT_CONTACT_LIMIT = 8;

export interface ListRecentContactsOptions {
  tenantId: string;
  /** El que el revisor ha escrit al camp; buit demana els contactes més recents. */
  query?: string;
  limit?: number;
}

/**
 * `ilike` tracta `%` i `_` com a comodins, i el text ve d'un camp del navegador:
 * sense escapar-los, escriure `%` retornaria tota la llibreta.
 */
const contains = (query: string): string =>
  `%${query.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/**
 * Les adreces del tenant que contenen el que s'ha escrit, de la vista més
 * recentment a la més antiga. Una sola consulta: `unnest` desplega el
 * destinatari i les còpies de cada missatge al costat del remitent, i
 * l'agrupació per adreça és la que en treu les repeticions.
 */
export const listRecentContacts = async <
  TResult extends PgQueryResultHKT,
  TFullSchema extends Record<string, unknown>,
  TSchema extends TablesRelationalConfig,
>(
  db: PgDatabase<TResult, TFullSchema, TSchema>,
  {
    tenantId,
    query = "",
    limit = DEFAULT_RECENT_CONTACT_LIMIT,
  }: ListRecentContactsOptions,
): Promise<string[]> => {
  const contacts = db
    .select({
      address: sql<string>`unnest(array_prepend(${messages.fromAddress}, ${messages.toAddresses} || ${messages.ccAddresses}))`.as(
        "address",
      ),
      sentAt: messages.sentAt,
    })
    .from(messages)
    // Del tenant de la sessió i de cap altre: les adreces que ha vist una
    // empresa no són de ningú més (context.md §7).
    .where(eq(messages.tenantId, tenantId))
    .as("contacts");

  const rows = await db
    .select({ address: contacts.address })
    .from(contacts)
    // Graph deixa el remitent buit quan el missatge no en porta; una adreça
    // buida no és cap contacte.
    .where(and(ne(contacts.address, ""), ilike(contacts.address, contains(query))))
    .groupBy(contacts.address)
    .orderBy(sql`max(${contacts.sentAt}) desc nulls last`)
    .limit(limit);

  return rows.map(({ address }) => address);
};
