// Seeds fictitious data so the dashboard can be browsed locally without a
// real connected mailbox or any Anthropic/worker activity (README "Prova
// local"). Reuses the single PoC tenant Auth.js creates on first login
// (context.md §1, app/src/lib/auth/drizzle-adapter.ts `resolveTenantId`) and
// the demo mailbox if they already exist; the six fixture threads themselves
// are not deduplicated, so re-running adds another six rather than erroring.

import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  dailyDigests,
  drafts,
  mailboxAccounts,
  messages,
  tenants,
  threads,
} from "../src/db/schema";
import {
  DRAFT_ELIGIBLE_CATEGORIES,
  TRIAGE_CATEGORIES,
  type TriageCategory,
} from "../src/triage/taxonomy";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed the database.");
}

const db = drizzle(new Pool({ connectionString: databaseUrl }), {
  schema: { tenants, mailboxAccounts, threads, messages, drafts, dailyDigests },
});

const DEMO_MAILBOX_EMAIL = "demo@correu-agent.test";

const FIXTURES: Record<
  TriageCategory,
  { subject: string; from: string; snippet: string; body: string }
> = {
  urgent: {
    subject: "Servidor caigut — necessitem resposta ara",
    from: "client.critic@empresa-exemple.cat",
    snippet: "El servidor de producció no respon des de fa 20 minuts...",
    body: "Bon dia,\n\nEl nostre servidor de producció no respon des de fa 20 minuts i estem perdent vendes. Necessitem una resposta urgent.\n\nGràcies,\nClient Crític",
  },
  comercial: {
    subject: "Pressupost per a 50 llicències",
    from: "compres@altraempresa.cat",
    snippet: "Voldríem un pressupost per a 50 llicències del vostre producte...",
    body: "Hola,\n\nSom una empresa de 50 persones i ens interessa el vostre producte. Podeu enviar-nos un pressupost?\n\nSalutacions,\nDepartament de Compres",
  },
  suport: {
    subject: "No puc accedir al meu compte",
    from: "usuari.despistat@gmail.com",
    snippet: "Des d'ahir no puc entrar al meu compte, em diu contrasenya incorrecta...",
    body: "Hola,\n\nDes d'ahir no puc entrar al meu compte encara que la contrasenya és correcta. Podeu ajudar-me?\n\nGràcies,\nUsuari",
  },
  facturacio: {
    subject: "Dubte sobre la factura de juliol",
    from: "administracio@clientfidel.cat",
    snippet: "Hem rebut la factura de juliol però l'import no coincideix amb...",
    body: "Bon dia,\n\nHem rebut la factura de juliol però l'import no coincideix amb el pressupost acordat. Podeu revisar-ho?\n\nAtentament,\nAdministració",
  },
  newsletter: {
    subject: "🔥 Ofertes exclusives només aquesta setmana!",
    from: "no-reply@butlleti-marketing.com",
    snippet: "No et perdis les nostres ofertes exclusives d'aquesta setmana...",
    body: "Ofertes exclusives! Descomptes fins al 70%! No et perdis res!",
  },
  personal: {
    subject: "Dinar dijous?",
    from: "amic.antic@gmail.com",
    snippet: "Ei! Fa temps que no ens veiem, et va bé dinar dijous?",
    body: "Ei!\n\nFa temps que no ens veiem. Et va bé dinar dijous que ve?\n\nUna abraçada,\nel teu amic",
  },
};

async function resolveDemoTenantId(): Promise<string> {
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .orderBy(asc(tenants.createdAt))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(tenants)
    .values({ name: "Correu Agent (PoC)" })
    .returning({ id: tenants.id });
  return created.id;
}

async function resolveDemoMailboxId(tenantId: string): Promise<string> {
  const [existing] = await db
    .select({ id: mailboxAccounts.id })
    .from(mailboxAccounts)
    .where(
      and(
        eq(mailboxAccounts.tenantId, tenantId),
        eq(mailboxAccounts.emailAddress, DEMO_MAILBOX_EMAIL),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(mailboxAccounts)
    .values({
      tenantId,
      provider: "google",
      emailAddress: DEMO_MAILBOX_EMAIL,
      providerAccountId: `seed-${randomUUID()}`,
      // No tokens: this mailbox is never actually polled, only shown.
    })
    .returning({ id: mailboxAccounts.id });
  return created.id;
}

async function seedThread(
  tenantId: string,
  mailboxAccountId: string,
  category: TriageCategory,
): Promise<void> {
  const fixture = FIXTURES[category];
  const now = new Date();

  const [thread] = await db
    .insert(threads)
    .values({
      tenantId,
      mailboxAccountId,
      providerThreadId: `seed-${category}-${randomUUID()}`,
      subject: fixture.subject,
      category,
      triagedAt: now,
      lastMessageAt: now,
    })
    .returning({ id: threads.id });

  const [message] = await db
    .insert(messages)
    .values({
      tenantId,
      threadId: thread.id,
      providerMessageId: `seed-${randomUUID()}`,
      direction: "inbound",
      fromAddress: fixture.from,
      toAddresses: [DEMO_MAILBOX_EMAIL],
      subject: fixture.subject,
      snippet: fixture.snippet,
      bodyText: fixture.body,
      sentAt: now,
    })
    .returning({ id: messages.id });

  if (DRAFT_ELIGIBLE_CATEGORIES.includes(category)) {
    await db.insert(drafts).values({
      tenantId,
      threadId: thread.id,
      inReplyToMessageId: message.id,
      status: "pending",
      body: `Hola,\n\nGràcies pel teu missatge. [Esborrany fictici per a la categoria "${category}" — dades de prova.]\n\nSalutacions,\nCorreu Agent`,
      model: "seed-fixture",
    });
  }
}

async function seedDigest(tenantId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db
    .insert(dailyDigests)
    .values({
      tenantId,
      digestDate: today,
      summary:
        "Avui s'han triat 6 fils de prova: 1 urgent, 1 comercial, 1 de suport, 1 de facturació, 1 newsletter i 1 personal. Dades fictícies generades per `npm run db:seed`.",
      threadCount: TRIAGE_CATEGORIES.length,
      model: "seed-fixture",
    })
    .onConflictDoUpdate({
      target: [dailyDigests.tenantId, dailyDigests.digestDate],
      set: {
        summary:
          "Avui s'han triat 6 fils de prova: 1 urgent, 1 comercial, 1 de suport, 1 de facturació, 1 newsletter i 1 personal. Dades fictícies generades per `npm run db:seed`.",
        threadCount: TRIAGE_CATEGORIES.length,
      },
    });
}

async function main(): Promise<void> {
  const tenantId = await resolveDemoTenantId();
  const mailboxAccountId = await resolveDemoMailboxId(tenantId);

  for (const category of TRIAGE_CATEGORIES) {
    await seedThread(tenantId, mailboxAccountId, category);
  }
  await seedDigest(tenantId);

  console.log(`Seeded 6 fictitious threads (tenant ${tenantId}).`);
  console.log(
    "Log in with an address from AUTH_ALLOWED_EMAILS to browse them on the dashboard.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
