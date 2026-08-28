# context.md — Correu Agent: SaaS d'automatització de correu per a empreses

Document viu de context tècnic per a qualsevol (humà o agent d'IA) que treballi en aquest codi. Actualitzar-lo quan es revisiti una decisió d'aquí sota. Resultat d'una sessió de grilling (§13, Decisions Log).

> **Missió.** Construir un SaaS d'automatització de correu electrònic per a empreses: triatge automàtic, esborranys de resposta, digest diari i (opcional, granular) resposta automàtica, connectant Gmail/Google Workspace i Microsoft 365/Outlook. Fase actual: **prova de concepte (PoC) single-tenant** a cost €0/mes, amb migració futura a multi-tenant real i, si cal, a servidor privat.

---

## 1. Visió general del producte

Producte SaaS **multi-tenant** (cada empresa client connecta el seu propi correu), però la **fase actual és un PoC single-tenant**: una sola bústia connectada (el Gmail personal del desenvolupador, més un compte Outlook de prova), sense signup, sense facturació, sense onboarding d'altres empreses. L'esquema de base de dades ja porta `tenant_id` des del principi per evitar una migració dolorosa quan arribi el segon client (§7).

Objectiu del PoC: validar que el nucli d'IA (triatge + redacció d'esborranys + digest) funciona prou bé abans d'invertir en infraestructura multi-tenant (auth per empresa, facturació, onboarding).

---

## 2. Funcions

Nucli (sempre actiu):

- **Triatge automàtic**: cada fil de correu nou es classifica en una de 6 categories fixes (§4).
- **Esborranys de resposta**: per a fils que ho necessiten, es genera un esborrany de resposta que l'usuari revisa al dashboard.
- **Digest diari**: resum dins del dashboard (no per correu) dels fils processats el dia.

Opcional, granular per categoria:

- **Resposta automàtica** (auto-reply): activable per categoria/regla, mai un interruptor global tot-o-res. Elegible només a **Comercial/Vendes, Suport/Atenció al client, Facturació/Administració**. **Mai** a Urgent ni Personal/Altres (massa risc/sensibilitat). Newsletter/Spam no necessita resposta, només arxivar/etiquetar.
- **Descart automàtic** (auto-discard): activable per categoria/regla, amb el mateix patró que l'auto-resposta però l'acció oposada — el fil es descarta sol just en triar-lo, sense generar mai esborrany ni consumir el pipeline de redacció. Elegible a **totes les categories excepte Urgent** (invariant de seguretat igual que l'auto-resposta). Cada regla pot afinar-se amb patrons de remitent i/o paraules clau a l'assumpte; sense cap dels dos, s'aplica a tota la categoria. Per defecte, sense cap regla desada, Newsletter/Spam ja es descarta sol (no necessita resposta); la resta de categories comencen desactivades.

Flux d'aprovació d'un esborrany:
- **Aprovar** → envia realment el correu via l'API del proveïdor (Gmail API / Microsoft Graph), amb opció d'editar el text i els destinataris (Per a / Cc / Cco) abans d'aprovar. Els camps arrenquen amb el que el fil implica (respondre a qui ha escrit) i autocompleten amb els contactes recents del tenant, llegits de les adreces que `messages` ja acumula — no hi ha taula de contactes. Els tres camps es desen a l'esborrany en aprovar-lo, perquè l'audit log tingui a qui es va enviar i no només què (§7).
- **Rebutjar** → l'usuari pot **descartar** (arxiva sense resposta) o **regenerar amb una instrucció de feedback** (nova crida al model amb el comentari afegit).

---

## 3. Fora d'abast al PoC (backlog per a una segona actualització)

No implementar ara, però no descartat — apuntat aquí perquè no es perdi:

- Base de coneixement / context d'empresa (to de veu, FAQ, info de productes) injectat als esborranys — probablement via RAG. El PoC redacta amb el contingut del fil sol.
- Processament d'adjunts (PDFs, imatges).
- Categories configurables per l'usuari (el PoC usa la taxonomia fixa de §4).
- Multi-tenant real: signup, onboarding d'altres empreses, facturació.
- Push/webhooks en temps real (Gmail Pub/Sub, Microsoft Graph webhooks) en lloc de polling.
- Import de l'historial de correu previ a la connexió.
- Dashboard instal·lable com a PWA / suport mòbil (el producte és per a ordinadors d'oficina, no per a mòbil).
- DPA i flux de consentiment RGPD complet (bloquejant abans d'onboardejar el primer client de pagament amb dades de tercers reals).
- Auto-merge revisat/reduït: es manté auto-merge complet del pipeline (§8), no cal ajornar-ho.

---

## 4. Triatge: taxonomia i regles

Sis categories fixes per al PoC (configurabilitat ajornada, §3):

| Categoria | Auto-resposta elegible |
|---|---|
| Urgent | No |
| Comercial/Vendes | Sí |
| Suport/Atenció al client | Sí |
| Facturació/Administració | Sí |
| Newsletter/Spam | No (només arxivar/etiquetar) |
| Personal/Altres | No |

**Baixa confiança de classificació**: el model assigna sempre la categoria més probable — no existeix un estat "sense classificar" que generi una cua de treball manual.

**Unitat de triatge**: per **fil/conversa** (`threadId` de Gmail / `conversationId` de Microsoft Graph), no per missatge individual. Un fil ja triat no es torna a triar en cada resposta dins del mateix fil. Els esborranys de resposta han d'incloure les capçaleres `In-Reply-To`/`References` correctes per respondre dins del fil.

**Backlog en connectar una bústia**: només es processa correu **nou** a partir del moment de connexió. L'historial existent no es processa (import opcional, fora d'abast, §3).

---

## 5. Notificacions

- **Urgent**: notificació activa i immediata via **Web Push** al navegador/dashboard (no correu electrònic — enviar una notificació a la mateixa bústia vigilada seria circular). Patró VAPID, igual que a Reviu, cost €0.
- **Resta de categories**: cobertes pel digest diari dins del dashboard, sense notificació activa ni correu.
- El dashboard és una eina d'ús a **ordinador d'oficina**, no una app mòbil — Web Push només cal funcionar a escriptori (sense la restricció d'iOS d'instal·lar-ho com a PWA).

---

## 6. Model d'IA i cost

Separació de model per tasca:
- **Triatge/classificació**: Claude Haiku — tasca senzilla d'una etiqueta, cost mínim.
- **Esborranys de resposta i digest**: Claude Sonnet — on la qualitat de redacció es nota.
- **Idioma**: detecció automàtica de l'idioma del correu entrant; l'esborrany respon en el mateix idioma. Sense idioma fix.

---

## 7. Model de dades i retenció

Entitats principals (esquema Drizzle sobre Postgres): `Tenant`, `User` (login via Auth.js), `MailboxAccount` (proveïdor, tokens OAuth xifrats, per tenant), `Thread`, `Message`, `Draft`, `AutoReplyRule` (per categoria, per tenant), `AuditLogEntry`.

- **`tenant_id` present des del principi** a totes les taules multi-tenant, encara que el PoC només tingui un tenant — evita una migració dolorosa quan arribi el segon client.
- **Cos complet del correu emmagatzemat** a BD (no es recupera en directe de l'API cada vegada — més lent i consumeix quota). **Retenció: 90 dies**, després es purga a una versió esquemàtica (metadades + categoria + resum), configurable per tenant en el futur (no al PoC).
- **Xifratge a nivell d'aplicació** només per als **tokens OAuth** (credencial d'accés directe al correu — el risc més crític). El cos del correu queda cobert pel xifratge de disc per defecte de Neon; xifrar-lo també a nivell d'aplicació és desproporcionat per al PoC.
- **Audit log**: cada acció rellevant (correu classificat, esborrany generat, aprovat/rebutjat/regenerat, auto-resposta enviada) es registra — per poder respondre "per què es va enviar aquest correu" davant d'un client real.
- **Regió UE** per a Neon i Render des del principi — preparació RGPD barata (evita migració de dades més endavant). El compliment RGPD complet (DPA, consentiment) és bloquejant abans del primer client de pagament amb dades de tercers, no abans (§3).

---

## 8. Disparador i freqüència

- **Polling** (no push/webhooks al PoC, §3): el worker consulta cada bústia connectada **cada 2 minuts**.
- Migració futura a push (Gmail Pub/Sub, Microsoft Graph webhooks) quan calgui temps real, sense canviar l'arquitectura de fons.

---

## 9. Autenticació i proveïdors

- **Gmail/Google Workspace i Microsoft 365/Outlook**, tots dos des de V1 (no excloure cap dels dos: un producte B2B no pot descartar Microsoft 365 d'entrada).
- **Auth.js** per a OAuth (Google + Microsoft/Azure AD), reutilitzat també com a **login del dashboard** (mateixa peça que ja cal per connectar les bústies).
- Configuració d'app OAuth a Google Cloud Console i registre d'app a Azure/Entra ID: pas manual que fa l'usuari, guiat amb `mattpocock-skills:wizard` a la fase d'implementació corresponent — no bloqueja la resta del bootstrap.

---

## 10. Infraestructura, desplegament i cost

**Objectiu PoC: ~€0/mes** (free tiers). Migració a servidor privat prevista si cal, sense canvi d'arquitectura d'aplicació.

```text
┌─────────────────────────┐
│ Navegador (escriptori)   │
│ Dashboard (Next.js)      │
└────────────┬─────────────┘
             │ HTTPS
             ▼
┌─────────────────────────┐      ┌─────────────────────────┐
│ app/ — Next.js            │◄────►│ worker/ — Node/TS         │
│ dashboard + API routes    │      │ polling + cua (pg-boss)   │
│ Render (Web Service)      │      │ Render (Background Worker)│
└────────────┬─────────────┘      └────────────┬─────────────┘
             │                                    │
             └───────────────┬────────────────────┘
                              ▼
                  ┌─────────────────────────┐
                  │ PostgreSQL                │
                  │ Neon — free tier, regió UE │
                  └─────────────────────────┘
```

- **Frontend + backend (API)**: `app/` — Next.js, desplegat a Render com a Web Service, subdomini gratuït de Render per al PoC (domini propi no necessari encara).
- **Worker**: `worker/` — servei Node/TS separat, desplegat a Render com a **Background Worker** (procés de llarga durada, no serverless — necessari per al polling).
- **Base de dades**: PostgreSQL a Neon, free tier, **regió UE**.
- **Cua de tasques**: `pg-boss` (basada en Postgres) — evita afegir Redis com a peça d'infra extra pagant per un altre proveïdor, amb el volum baix del PoC.

---

## 11. Tech stack

- **App (dashboard + API)**: Next.js + TypeScript + React. UI en **català**.
- **Worker**: Node.js + TypeScript, `pg-boss` per a la cua de polling.
- **Base de dades**: PostgreSQL (Neon, regió UE).
- **ORM**: Drizzle.
- **Auth**: Auth.js (NextAuth), proveïdors OAuth Google i Microsoft/Azure AD.
- **IA**: API d'Anthropic — Claude Haiku (triatge) i Claude Sonnet (redacció/digest).
- **Package manager**: npm.
- **Testing**: Vitest.
- **Notificacions**: Web Push (VAPID), patró ja provat a Reviu.

Triats independentment de l'stack de Reviu, avaluats pel millor encaix amb: OAuth multi-tenant dual-proveïdor, workers de polling programats, crides a LLM, dashboard d'aprovació.

---

## 12. Pipeline d'agents autònoms (reutilitzat de Reviu)

Es porta **sencer** el mètode de Reviu (issues de GitHub com a especificació, agents autònoms que implementen+revisen+mergegen via CI), amb aquests ajustos específics per a `Correu_Agent`:

- **Auto-merge actiu** des del principi (igual que Reviu) — `agent-review.yml` fa `gh pr merge --squash --delete-branch` automàticament quan typecheck+test+build passen.
- **Model dels agents de CI: Opus, última versió disponible** (`claude-opus-5`) — no Sonnet, decisió explícita per prioritzar qualitat d'implementació per sobre del cost en aquesta fase.
- **Secrets nous i separats** de Reviu: `CLAUDE_CODE_OAUTH_TOKEN` i `AGENT_PAT` propis d'aquest repo (aïlla quota/facturació entre projectes).
- **Plugin caveman mantingut** als tres workflows (`agent-implement.yml`, `agent-review.yml`, `agent-update-branch.yml`) per retallar consum de tokens dels agents.
- **`agent-wave-advance.yml`** reutilitzat igual: quan una PR que tanca una issue es mergeja, activa automàticament (`agent:implement`) les issues que només estaven bloquejades per aquella, via dependències natives de GitHub.
- **Etiquetes de triatge**: mateixes 5 canòniques que Reviu (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) + les operatives del pipeline (`agent:implement`, `agent:review`, `agent:update-branch`).
- **Patró de documentació**: `context.md` (aquest document) + `docs/adr/` per a decisions arquitectòniques puntuals futures, `docs/agents/*.md` (issue-tracker, triage-labels, domain) adaptats de Reviu.
- **`.sandcastle/CODING_STANDARDS.md`**: reescrit per a l'stack d'aquest projecte (§11), no el de Reviu.
- **Convenció de commits/PR**: `Fix #<issue>: <títol>` com a missatge/títol, `Closes #<issue>` al body — necessari perquè `agent-wave-advance.yml` trobi quina issue tanca cada PR.

---

## 13. Decisions Log

Resolt durant la sessió de grilling (50 preguntes) que ha donat forma a aquest document:

| Decisió | Resolució |
|---|---|
| Naturalesa del projecte | Producte SaaS concret, no motlle genèric |
| Model de negoci | SaaS multi-tenant (fase actual: PoC single-tenant) |
| Funcions nucli | Triatge + esborranys + digest; auto-resposta com a opció granular |
| Autonomia | Human-in-the-loop; auto-resposta granular per categoria, mai global |
| Proveïdors de correu | Gmail i Microsoft 365, tots dos des de V1 |
| Disparador | Polling cada 2 min; migració futura a push |
| Pipeline d'agents | Reutilitzat sencer, amb auto-merge actiu |
| Interfície | Dashboard web (Next.js) + backend/API + worker |
| Stack | Escollit pel millor encaix (§11), no heretat de Reviu |
| Pressupost infra | €0/mes (free tiers) al PoC; servidor privat si cal després |
| Abast del PoC | Single-tenant, amb el Gmail del desenvolupador + Outlook de prova |
| Idioma dels esborranys | Detecció automàtica, resposta en el mateix idioma |
| Categories de triatge | Fixes (6), configurabilitat ajornada |
| Categories elegibles per auto-resposta | Comercial, Suport, Facturació; mai Urgent ni Personal |
| Categories elegibles per descart automàtic | Totes excepte Urgent; Newsletter activada per defecte sense regla desada |
| Digest | Diari, dins del dashboard (no per correu) |
| Aprovació d'esborranys | Aprovar envia realment el correu; rebutjar = descartar o regenerar amb feedback |
| Emmagatzematge de correu | Cos complet a BD, retenció 90 dies |
| Idioma del dashboard | Català |
| Models d'IA | Haiku (triatge) + Sonnet (redacció/digest) |
| Autenticació del dashboard | Auth.js complet des del PoC |
| Adjunts | Fora d'abast al PoC |
| Xifratge en repòs | Nivell aplicació només per tokens OAuth |
| Secrets de CI | Nous i separats de Reviu |
| Plugin caveman a CI | Mantingut |
| Etiquetes de triatge | Mateix esquema que Reviu |
| Document de context | Mateix patró `context.md` + `docs/adr/` |
| Estructura del monorepo | `app/` + `worker/` + `shared/` |
| Package manager / testing | npm + Vitest |
| Domini PoC | Subdomini gratuït de Render |
| Configuració OAuth | Guiada amb wizard a la fase d'implementació |
| Creació d'issues inicials | A càrrec de l'agent, organitzades en onades |
| Gestió de fils | Per threadId/conversationId, no per missatge |
| Backlog en connectar | Ignorat, només correu nou |
| Interval de polling | 2 minuts |
| Classificació de baixa confiança | Sempre la més probable, sense estat manual |
| Notificació Urgent | Web Push, no correu |
| Dashboard mòbil/PWA | Fora d'abast — producte pensat per a escriptori d'oficina |
| Esquema multi-tenant-ready | `tenant_id` des del principi |
| Context d'empresa per a esborranys | Fora d'abast al PoC, apuntat a backlog V2 |
| Traça d'auditoria | Mantinguda (`AuditLogEntry`) |
| RGPD | Preparació bàsica ja (regió UE); DPA/consentiment ajornats a client real |
| Regió de dades | UE (Neon i Render) |
| Model dels agents de CI | Opus, última versió (`claude-opus-5`) |

No queden decisions arquitectòniques obertes que bloquegin la creació de les issues inicials. Cap termini de llançament conegut encara.
