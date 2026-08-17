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

El codi de servidor i el worker importen les taules des de `@correu-agent/shared/db/schema`,
no des del barrel `@correu-agent/shared` — el barrel l'importa codi que acaba al navegador.

`drizzle-orm` també és `devDependency` de l'arrel: npm deixa la còpia del workspace a
`shared/node_modules/`, on el binari `drizzle-kit` (que sí que puja a l'arrel) no la pot
resoldre i les dues comandes de dalt fallen amb «Please install latest version of drizzle-orm».

## Pipeline d'agents

Les issues de GitHub amb l'etiqueta `agent:implement` són recollides automàticament per un agent implementador; la PR resultant passa per un agent revisor (`agent:review`) que fa merge automàtic (squash) si typecheck+test+build passen. Detalls a `context.md` §12 i `docs/agents/`.
