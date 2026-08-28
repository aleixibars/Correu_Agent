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

### Dades fictícies per a una prova local

`npm run db:seed -w @correu-agent/shared` insereix 6 fils fictius (un per categoria, amb
un missatge i, on toca, un esborrany pendent) i el digest d'avui, sense necessitat de cap
bústia real ni clau d'Anthropic. Reutilitza el tenant únic del PoC (el mateix que crea el
primer login) si ja existeix; re-executar-lo n'afegeix sis més, no dona error. Cal fer
login amb una adreça d'`AUTH_ALLOWED_EMAILS` per veure'ls al tauler.

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
de consultes duplicades al darrere. Qui ho fa complir és la política `short` de
la cua (`worker/src/queue/queue-client.ts`): amb la política per defecte el
`singletonKey` no filtra res. pg-boss fixa la política en crear la cua i no la
deixa canviar després, així que una cua creada per un worker anterior amb una
altra política s'esborra i es torna a crear a l'arrencada (avisant-ne): no hi ha
res a la cua que valgui la pena conservar, un tic perdut només vol dir consultar
el correu dos minuts més tard.

El primer tic és immediat: un worker que acaba de reiniciar no ha d'esperar dos
minuts per mirar el correu.

La feina es processa a `worker/src/queue/mailbox-poll.ts`: rellegeix la bústia de
la base de dades (els tokens i el cursor es mouen entre encuar i processar) i la
consulta pel client del proveïdor. Una bústia que falla no atura la resta del
lot: l'error es registra amb l'id de la bústia i es reporta al resultat de la
feina. Si cap no s'ha pogut consultar, la feina falla perquè pg-boss la
reintenti.

El que troba el polling es persisteix a `shared/src/mailbox/persist.ts`: un fil
per conversa del proveïdor, el cos sencer de cada missatge i una entrada d'audit
del correu realment nou. Triar-lo és el pas següent del pipeline.

### Gmail/Google Workspace

`worker/src/poll/gmail.ts` + `shared/src/mail/gmail.ts`:

- Renova l'access token amb el refresh token desat quan queda menys d'un minut
  de vida, i el torna a desar xifrat.
- La primera consulta d'una bústia no descarrega res: només demana el
  `historyId` actual i el desa com a cursor, així el correu anterior a la
  connexió no s'importa (`context.md` §4).
- Les consultes següents demanen l'historial des del cursor desat. Si Gmail ja
  l'ha caducat (guarda l'historial una setmana), es reprèn des d'ara i es
  registra un avís: el correu saltat entremig no es recupera.
- Un poll agafa com a molt `MAX_MESSAGES_PER_POLL` missatges i deixa la resta
  per al tic següent, avançant el cursor fins al darrer registre d'historial
  processat. Sense aquest límit, una bústia molt endarrerida faria una feina més
  llarga que la caducitat del job de pg-boss i no avançaria mai.
- Queden fora els esborranys propis i el correu que ja és a la paperera (igual
  que a Outlook, on només es llegeix la safata d'entrada); el correu enviat es
  marca com a `outbound`.
- Si una pàgina d'historial posterior a la primera desapareix a mitja consulta,
  es conserva el correu ja llegit i es reprèn des del darrer registre processat:
  tornar a començar des d'ara saltaria la resta de l'historial.
- Variables necessàries al worker: `DATABASE_URL`, `AUTH_GOOGLE_ID`,
  `AUTH_GOOGLE_SECRET` i `TOKEN_ENCRYPTION_KEY`. Es llegeixen en arrencar: sense
  elles el worker no arrenca, en lloc de fallar cada poll en silenci cada 2
  minuts.

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

## Triatge automàtic

Cada fil nou es classifica en una de les 6 categories fixes de `context.md` §4
amb Claude Haiku (`context.md` §6): el model és barat i la feina és una sola
etiqueta. La taxonomia viu a `shared/src/triage/taxonomy.ts` i la comparteixen
l'esquema (`triage_category`), el classificador i el tauler.

- El classificador (`shared/src/triage/classify.ts`) llegeix el correu ja
  desat, no el torna a demanar al proveïdor (`context.md` §7).
- **No hi ha estat "sense classificar"** (`context.md` §4): una resposta del
  model que no anomeni cap categoria cau a `personal` — l'única que ni avisa com
  a urgent ni és elegible per a auto-resposta — en lloc de generar una cua de
  feina manual.
- Un fil ja triat no es torna a triar quan hi arriba una resposta: l'escriptura
  (`shared/src/triage/triage-thread.ts`) va condicionada a `triaged_at is null`,
  cosa que també resol dos workers classificant el mateix fil alhora.
- Cada classificació queda a l'audit log com a `thread_classified`, amb la
  categoria anterior i el model que ha respost (`context.md` §7).

El disparador és el mateix tic de 2 minuts que el polling
(`worker/src/triage/schedule.ts`): en lloc de fiar-se de la feina de polling que
acaba d'escriure el fil, cada tic pregunta a la base de dades quins fils encara
no tenen categoria i n'encua un `thread-triage` per fil (`singletonKey` per fil).
Així un fil que es va quedar sense classificar — feina perduda, error de l'API —
el recull el tic següent. La feina es processa a
`worker/src/queue/thread-triage.ts`: un fil que falla no atura el lot, i si no
se n'ha pogut triar cap la feina falla perquè pg-boss la reintenti.

- Variable necessària al worker: `ANTHROPIC_API_KEY`. Es llegeix en arrencar: si
  falta, el worker no arrenca, en lloc de fallar un fil rere l'altre.

## Adjunts d'un correu

A `/fils/[id]`, cada missatge llista els fitxers que li han arribat: nom, mida,
previsualització dels tipus que el navegador pinta sense executar-los i
descàrrega de qualsevol (`context.md` §2).

- **Només se'n desen les metadades** (`message_attachments`: nom, `mime_type`,
  mida i l'identificador del proveïdor). Els bytes no es guarden mai enlloc
  (`context.md` §7): un PoC a €0/mes no paga per tenir una còpia de cada PDF que
  el proveïdor ja custodia.
- El poll les recull dels dos proveïdors: a Gmail, de les parts MIME que porten
  `filename` i `body.attachmentId` (`shared/src/mail/gmail.ts`); a Graph, de
  `GET /messages/{id}/attachments` per a tot missatge que no digui
  `hasAttachments: false` (`shared/src/mailbox/microsoft-mail.ts`) — un
  `deltaLink` guardat abans que el camp entrés al `$select` respon sense ell
  mentre visqui, i llegir-ho com a "cap adjunt" deixaria la bústia sense
  llistar-ne cap mai. De Graph només se'n queden els
  `fileAttachment`: un adjunt de referència és un enllaç a OneDrive i no té
  bytes per baixar.
- Els que el correu incrusta al seu propi cos (la imatge d'una signatura) es
  desen marcats com a `inline` i no surten a la llista del fil.
- `GET /api/adjunts/[id]` és qui els serveix: comprova la sessió, llegeix les
  metadades del tenant, en treu un token viu de la bústia
  (`app/src/lib/mailbox/access-token.ts`, el mateix que fa servir l'enviament
  d'un esborrany) i baixa el fitxer del proveïdor en aquell moment
  (`app/src/lib/mailbox/attachment-download.ts`). Res no queda desat al servidor.
- Un adjunt l'escriu qui envia el correu i el serveix el mateix origen que el
  tauler, així que **només s'ofereixen en línia els tipus que el navegador no
  executa** (imatges menys SVG, i PDF). La resta surt com a
  `application/octet-stream`, com a descàrrega i amb
  `Content-Security-Policy: sandbox`, que la deixa en un origen opac. Tot surt
  amb `nosniff` i `Cache-Control: private, no-store`. La previsualització no
  porta `sandbox` a posta: el visor de PDF del navegador no s'hi carrega, i
  allà qui talla el risc és la llista de tipus inerts. Amb `?descarrega=1` fins
  i tot un PDF baixa en lloc d'obrir-se.

## Retenció de correu (90 dies)

El cos complet dels missatges es desa a la base de dades, però només durant **90
dies** (`context.md` §7). Passada la finestra, el worker el substitueix per una
versió esquemàtica en lloc d'esborrar la fila: metadades (remitent, destinataris,
assumpte, dates, capçaleres del fil), la categoria del fil i un resum. La fila ha
de sobreviure perquè l'audit log i el digest hi apunten.

- La purga viu a `shared/src/retention/purge.ts`
  (`@correu-agent/shared/retention`): buida `body_text` i `body_html`, marca
  `body_purged_at` i deixa la resta de columnes intactes.
- El resum que queda és el `snippet` del proveïdor; per al correu que no en va
  portar cap, la purga n'omple un amb l'inici del cos abans de buidar-lo — del
  text pla si n'hi ha i, si el missatge només porta HTML (el cas normal de
  Graph), del mateix HTML sense etiquetes. Així cap missatge purgat queda sense
  resum consultable.
- L'edat es mesura per la data del proveïdor (`sent_at`) i, si no n'hi ha, per
  quan es va desar la fila (`created_at`): cap missatge pot quedar-se fora de la
  finestra per sempre.
- `body_purged_at` és alhora la marca i el filtre, així que la feina és
  idempotent: repetir-la no torna a purgar res ni sobreescriu el resum ja desat.
- La feina (`worker/src/queue/retention-purge.ts`) va per la cua
  `retention-purge`, programada pel cron de pg-boss un cop al dia a les 03:00 UTC.
  El cron és de pg-boss i no del worker: un desplegament no ha de reiniciar el
  rellotge d'una feina diària, ni dos workers l'han de disparar cadascun.

## Digest diari

Cada dia el worker resumeix els fils que ha processat el dia anterior i en desa
el digest **dins del tauler** — mai per correu (`context.md` §5): enviar un avís
a la mateixa bústia vigilada seria circular.

- L'agregació viu a `shared/src/digest/collect.ts`
  (`@correu-agent/shared/digest`): agrupa els fils per categoria, en l'ordre de
  la taxonomia (`context.md` §4), i deixa fora les categories on no ha arribat
  res. Quan el tauler mostri el digest llegirà aquesta mateixa funció, així que
  no hi haurà dues maneres d'agrupar un mateix dia.
- El dia és el dia **UTC** en què el fil es va triar (`triaged_at`), no el dia en
  què va arribar el correu: no hi ha zona horària per tenant i un correu de les
  23:59 classificat després de mitjanit ha de sortir a un sol digest, no a cap ni
  a tots dos.
- El text el redacta Claude Sonnet (`shared/src/digest/summarise.ts`), que és on
  la qualitat de redacció es nota (`context.md` §6), i sempre en català — la
  llengua del tauler — sigui quina sigui la del correu. L'assumpte dels fils
  arriba al model entre etiquetes `<digest>` i es tracta com a text no fiable,
  igual que al classificador.
- El digest només llegeix assumpte i categoria, mai el cos: un dia el correu del
  qual ja s'ha purgat (`context.md` §7) es resumeix igual.
- La feina (`worker/src/queue/daily-digest.ts`) va per la cua `daily-digest`,
  programada pel cron de pg-boss un cop al dia a les 05:00 UTC — el dia ha
  d'haver acabat abans de poder-lo resumir. Un tenant que falla no atura la
  resta, i si fallen tots la feina falla perquè pg-boss la reintenti. Els
  reintents van amb espera creixent i no de seguida: cada execució cobreix un
  dia i ningú no hi torna, així que un model saturat es perdria el dia sencer si
  els tres intents caiguessin dins del mateix segon. L'espera màxima queda dins
  del mateix dia UTC, perquè un reintent no acabi resumint el dia equivocat.
- Un dia sense correu processat no genera cap fila ni cap crida al model. Tornar
  a executar un dia (`daily_digests` és únic per tenant i data) el reescriu: és
  una correcció, mai un segon digest del mateix correu.
- Si el model respon sense text, el digest d'aquell tenant falla en lloc de
  desar-se buit: la columna és `not null` i una fila buida seria un titular
  damunt d'un dia en blanc que ja ningú no tornaria a generar.

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

No totes van als dos serveis de Render: el Web Service (`app/`) només llegeix
`VAPID_PUBLIC_KEY`, que lliura al navegador; el Background Worker (`worker/`) les
necessita les tres, perquè és qui signa i envia la notificació. El worker les
llegeix a l'arrencada i peta si en falta cap, igual que amb els secrets de
Google, Entra i Anthropic — un worker desplegat sense elles entra en bucle de
reinici en comptes de perdre avisos en silenci.

El codi de servidor (`app/` API routes, `worker/`) importa l'enviament des de
`@correu-agent/shared/web-push`, no des del barrel arrel: `web-push` és un paquet
només de Node i el barrel l'importa codi que acaba al navegador.

El circuit complet: al tauler, «Activa les notificacions» registra el service
worker (`app/public/sw.js`), subscriu el navegador i desa la subscripció a
`push_subscriptions` via `POST /api/push`. Quan el triatge classifica un fil com
a Urgent, el worker envia la notificació a totes les subscripcions del tenant i
esborra les que el servei de push declara caducades. Cap altra categoria genera
avís actiu: van al digest diari. Un clic a l'avís obre la llista de fils
(`/fils`); quan existeixi la pàgina d'un fil concret, l'avís hi haurà d'apuntar
(`URGENT_NOTIFICATION_PATH` a `shared/src/web-push/urgent.ts`).

## Pipeline d'agents

Les issues de GitHub amb l'etiqueta `agent:implement` són recollides automàticament per un agent implementador; la PR resultant passa per un agent revisor (`agent:review`) que fa merge automàtic (squash) si typecheck+test+build passen. Detalls a `context.md` §12 i `docs/agents/`.
