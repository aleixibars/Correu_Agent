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
- `AUTH_URL` — URL pública del tauler, només l'origen i sense camí (p. ex.
  `https://correu.onrender.com`): Auth.js pren qualsevol camí d'aquí com a base
  de les seves rutes.
- `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` — credencials de l'app de Google Cloud Console.
- `AUTH_MICROSOFT_ENTRA_ID_ID` / `AUTH_MICROSOFT_ENTRA_ID_SECRET` — registre d'app a Entra ID.
- `AUTH_MICROSOFT_ENTRA_ID_ISSUER` — limita el login a un sol directori d'Azure.
- `AUTH_ALLOWED_EMAILS` — llista d'adreces (separades per comes) que poden entrar.

`AUTH_ALLOWED_EMAILS` és obligatòria a la pràctica: el PoC és single-tenant i sense
signup, i qualsevol compte de Google podria arribar a la bústia connectada, així que
una llista buida no deixa entrar ningú.

Amb Microsoft, la llista d'adreces sola no n'hi ha prou: el claim `email` d'Entra ID
no està verificat i qualsevol directori d'Azure el pot posar a l'adreça que vulgui
(patró «nOAuth»). Sense `AUTH_MICROSOFT_ENTRA_ID_ISSUER` l'emissor per defecte és
`/common/`, que accepta tots els directoris. Per tant, o bé es fixa l'emissor a un
sol directori, o bé s'afegeix `xms_edov` com a claim opcional del registre d'app
(el login el rebutja quan el claim diu que l'adreça no està verificada). Per al
compte personal d'Outlook de proves, l'emissor a fixar és el directori de comptes
personals: `https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0`.

URL de callback a registrar als dos proveïdors:
`https://<domini>/api/auth/callback/google` i
`https://<domini>/api/auth/callback/microsoft-entra-id`.

L'adapter d'Auth.js (`app/src/lib/auth/drizzle-adapter.ts`) és propi i no
`@auth/drizzle-adapter`: aquest últim imposa les seves taules, ignora el `tenantId`
de l'esquema i desaria els tokens OAuth del proveïdor en clar. Les credencials per
llegir una bústia van xifrades a `mailbox_accounts` (`context.md` §7); les taules de
login només guarden l'enllaç d'identitat.

## Connexió de bústies

Iniciar la sessió al tauler no dona accés al correu: el login només identifica
qui hi ha al davant. Connectar una bústia és un segon flux OAuth per proveïdor,
que demana els permisos de correu i desa els tokens xifrats a `mailbox_accounts`
(`context.md` §7). Els dos fluxos tornen al tauler amb el mateix paràmetre
`?bustia=` i comparteixen els missatges de `app/src/lib/mailbox/connect-messages.ts`.

### Gmail

Codi a `app/src/lib/mailbox/` (`google-oauth.ts`, `connect-google-mailbox.ts`).

- Comença a `/api/mailbox/google/connect` (enllaç al tauler) i torna a
  `/api/mailbox/google/callback`.
- Permisos demanats: `gmail.readonly`, `gmail.send` i `openid`. Si l'usuari en
  desmarca cap dels dos de Gmail, la connexió es rebutja en lloc de desar una
  bústia a mitges.
- Reutilitza l'app de Google Cloud Console del login (`AUTH_GOOGLE_ID` /
  `AUTH_GOOGLE_SECRET`) i cal registrar-hi també aquesta URL de callback:
  `https://<domini>/api/mailbox/google/callback`. L'API de Gmail ha d'estar
  activada al projecte de Google Cloud.
- En connectar es desa el `historyId` de la bústia com a `sync_cursor`: el
  worker només processa correu nou a partir d'aquell punt (`context.md` §4).
  Tornar a connectar la mateixa bústia només refresca les credencials i manté
  el cursor, per no saltar-se el correu arribat mentrestant.
- `TOKEN_ENCRYPTION_KEY` és obligatòria: sense clau el callback no pot desar
  els tokens.

### Microsoft 365/Outlook

`/api/mailbox/microsoft/connect` (enllaç des del tauler) porta l'usuari al
consentiment d'Entra ID amb els permisos que necessita el pipeline —
`Mail.Read`, `Mail.Send` i `offline_access` — i `/api/mailbox/microsoft/callback`
desa la bústia a `mailbox_accounts` amb els tokens xifrats (`context.md` §7).

És un flux a part del login: entrar amb Microsoft només diu qui hi ha al tauler,
i no dóna cap accés al correu. Reutilitza el mateix registre d'app
(`AUTH_MICROSOFT_ENTRA_ID_ID` / `_SECRET` / `_ISSUER`), així que només cal
registrar-hi una URL de redirecció més:
`https://<domini>/api/mailbox/microsoft/callback`. Els permisos `Mail.Read` i
`Mail.Send` (delegats) s'han d'afegir al registre d'app.

Detalls del flux:

- Cal `TOKEN_ENCRYPTION_KEY`: sense clau (o sense les variables d'Entra), la
  connexió s'atura al tauler i ni tan sols envia l'usuari a la pantalla de
  consentiment, que li demanaria accés al correu per després llençar-lo.
- L'estat CSRF i el verificador PKCE viuen en una galeta `httpOnly` d'un sol ús
  que caduca als 10 minuts; si caduca, el tauler ho diu i es pot tornar a
  començar.
- La URL de redirecció la marca `AUTH_URL` (igual que el flux de Gmail), no les
  capçaleres `X-Forwarded-*`: el proxy de Render les posa, però qui truca també
  pot posar-les.
- Sense `offline_access` consentit, Entra no retorna cap refresh token i la
  connexió es rebutja: la bústia deixaria de ser consultable en una hora.
- Reconnectar una bústia ja connectada només refresca les credencials: no mou
  `connected_at` ni esborra `sync_cursor`, perquè el correu arribat mentrestant
  segueix sent seu (`context.md` §4).

## Polling de bústies

El worker consulta cada bústia connectada **cada 2 minuts**
(`worker/src/poll-interval.ts`, `context.md` §8; el pas a webhooks queda per més
endavant). Cada tic (`worker/src/poll/schedule.ts`) encua una feina `mailbox-poll`
per bústia amb un `singletonKey` propi, així una consulta lenta no deixa una cua
de consultes duplicades al darrere. El primer tic és immediat: un worker que
acaba de reiniciar no ha d'esperar dos minuts per mirar el correu.

La feina es processa a `worker/src/queue/mailbox-poll.ts`: rellegeix la bústia de
la base de dades (els tokens i el cursor es mouen entre encuar i processar) i la
consulta pel client del proveïdor. Una bústia que falla no atura la resta del
lot; si cap no s'ha pogut consultar, la feina falla perquè pg-boss la reintenti.

### Microsoft 365/Outlook

`worker/src/poll/microsoft.ts` + `shared/src/mailbox/microsoft-mail.ts`:

- Renova l'access token amb el refresh token desat quan queda menys d'un minut
  de vida, i el torna a desar xifrat. Entra rota el refresh token només de
  vegades; quan no ho fa, es manté el desat.
- La primera consulta d'una bústia demana `$deltatoken=latest`, que dóna un
  cursor sense enumerar tota la bústia — l'historial no es processa
  (`context.md` §4) — i tot seguit recupera el correu arribat entre la connexió
  i aquesta primera consulta amb un `$filter` per `receivedDateTime`.
- Les consultes següents parteixen del delta link desat a `sync_cursor` i el
  desen actualitzat. El cursor s'escriu després que Graph hagi respost: una
  consulta que mor a mitges es repeteix en lloc de saltar-se correu.
- Queden fora esborranys propis, entrades de supressió i correu anterior a
  `connected_at`.
- Variables necessàries al worker: `DATABASE_URL`, `AUTH_MICROSOFT_ENTRA_ID_ID`,
  `AUTH_MICROSOFT_ENTRA_ID_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ISSUER` (opcional) i
  `TOKEN_ENCRYPTION_KEY`. Es llegeixen en arrencar: si en falta cap, el worker no
  arrenca, en lloc de fallar una bústia cada dos minuts.

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
