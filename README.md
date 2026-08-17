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

## Pipeline d'agents

Les issues de GitHub amb l'etiqueta `agent:implement` són recollides automàticament per un agent implementador; la PR resultant passa per un agent revisor (`agent:review`) que fa merge automàtic (squash) si typecheck+test+build passen. Detalls a `context.md` §12 i `docs/agents/`.
