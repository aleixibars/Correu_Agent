# Correu Agent

SaaS d'automatització de correu per a empreses: triatge automàtic, esborranys de resposta i digest diari sobre Gmail/Google Workspace i Microsoft 365/Outlook. Fase actual: **prova de concepte (PoC) single-tenant**.

Context tècnic complet i totes les decisions de disseny: [`context.md`](./context.md).

## Estructura

```
app/            Dashboard + API (Next.js)
worker/         Polling de bústies + cua de tasques (Node/TS, pg-boss)
shared/         Tipus TS i esquema Drizzle compartits
docs/agents/    Convencions per als agents autònoms
docs/adr/       Decisions arquitectòniques puntuals
.sandcastle/    Pipeline d'agents autònoms (implement/review/update-branch)
.github/workflows/agent-*.yml   CI del pipeline d'agents
```

## Desenvolupament local

Requisits: Node.js 22, npm, un `DATABASE_URL` de Postgres (Neon).

```bash
npm install
cp .env.example .env   # omple els valors
npm run typecheck
npm run test
```

## Base de dades

L'esquema Drizzle viu a `shared/src/db/schema.ts` i les migracions generades a `shared/drizzle/`.

```bash
npm run db:generate -w @correu-agent/shared   # genera una migració a partir de l'esquema
npm run db:migrate -w @correu-agent/shared    # aplica les migracions pendents a DATABASE_URL
```

`db:migrate` necessita `DATABASE_URL` a l'entorn (Neon, regió UE — `context.md` §10).

Els tests comproven que les migracions de `shared/drizzle/` coincideixen amb l'esquema:
si canvies `schema.ts` i no executes `db:generate`, `npm run test` falla.

El codi de servidor i el worker importen les taules des de `@correu-agent/shared/db/schema`,
no des del barrel `@correu-agent/shared` — el barrel l'importa codi que acaba al navegador.

`drizzle-orm` també és `devDependency` de l'arrel: npm deixa la còpia del workspace a
`shared/node_modules/`, on el binari `drizzle-kit` (que sí que puja a l'arrel) no la pot
resoldre i les dues comandes de dalt fallen amb «Please install latest version of drizzle-orm».

## Autenticació (Auth.js)

El login del tauler i la connexió de bústies comparteixen els mateixos proveïdors
OAuth (`context.md` §9): Google i Microsoft Entra ID. La configuració viu a
`app/src/lib/auth/`, i les sessions es guarden a Postgres (`auth_sessions`), no en
un JWT, perquè tancar la sessió sigui definitiu.

Variables d'entorn:

- `AUTH_SECRET` — `openssl rand -base64 32`.
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — credencials de l'app de Google Cloud Console.
- `AUTH_MICROSOFT_ENTRA_ID_ID` / `AUTH_MICROSOFT_ENTRA_ID_SECRET` — registre d'app a Entra ID.
- `AUTH_MICROSOFT_ENTRA_ID_ISSUER` — opcional; limita el login a un sol directori d'Azure.
- `AUTH_ALLOWED_EMAILS` — llista d'adreces (separades per comes) que poden entrar.

`AUTH_ALLOWED_EMAILS` és obligatòria a la pràctica: el PoC és single-tenant i sense
signup, i qualsevol compte de Google podria arribar a la bústia connectada, així que
una llista buida no deixa entrar ningú.

URL de callback a registrar als dos proveïdors:
`https://<domini>/api/auth/callback/google` i
`https://<domini>/api/auth/callback/microsoft-entra-id`.

L'adapter d'Auth.js (`app/src/lib/auth/drizzle-adapter.ts`) és propi i no
`@auth/drizzle-adapter`: aquest últim imposa les seves taules, ignora el `tenantId`
de l'esquema i desaria els tokens OAuth del proveïdor en clar. Les credencials per
llegir una bústia van xifrades a `mailbox_accounts` (`context.md` §7); les taules de
login només guarden l'enllaç d'identitat.

## Notificacions Web Push (VAPID)

Les notificacions de correu Urgent van per Web Push (`context.md` §5). Cal un parell
de claus VAPID per desplegament — generar-lo un sol cop:

```bash
npm run generate-vapid-keys
```

L'ordre imprimeix les dues claus; el subjecte s'escull a mà. Les tres variables van
a l'entorn (`.env` en local, secrets de Render en desplegament):

- `VAPID_PUBLIC_KEY` — clau pública, també lliurada al navegador en subscriure's.
- `VAPID_PRIVATE_KEY` — clau privada, mai al repositori ni al client.
- `VAPID_SUBJECT` — contacte del remitent, `mailto:...` o `https://...`.

Regenerar les claus invalida totes les subscripcions existents: els navegadors
s'han de tornar a subscriure.

El codi de servidor (`app/` API routes, `worker/`) importa l'enviament des de
`@correu-agent/shared/web-push`, no des del barrel arrel: `web-push` és un paquet
només de Node i el barrel l'importa codi que acaba al navegador.

## Pipeline d'agents

Les issues de GitHub amb l'etiqueta `agent:implement` són recollides automàticament per un agent implementador; la PR resultant passa per un agent revisor (`agent:review`) que fa merge automàtic (squash) si typecheck+test+build passen. Detalls a `context.md` §12 i `docs/agents/`.
