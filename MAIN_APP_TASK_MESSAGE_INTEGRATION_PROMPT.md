# Prompt per l'agente: Integrazione Task Messages (Messaggistica/ToDo tra utenti) nella Main App

## Contesto

La main-app è un'applicazione NestJS + TypeORM + GraphQL con frontend Angular Material e architettura a layer (module/resolver/service/repository). Deve integrarsi con il modulo **Task Messages** del microservizio **WhatsApp Gateway** (stesso gateway già integrato per i messaggi WhatsApp).

Il modulo Task Messages è un servizio di **messaggistica interna tra utenti con visibilità programmata e tracking dei task**. Un utente A invia un messaggio/task a un utente B, con una data opzionale di disponibilità. Se la data è nel futuro, il messaggio rimane nascosto fino a quel giorno (es. reminder di fine mese dal 25 in poi, per evitare che il destinatario lo veda e lo segni come fatto prima della scadenza). Il gateway orchestra il ciclo di vita (scheduling, attivazione) e invia webhook alla main app per le transizioni di stato rilevanti.

Il gateway è raggiungibile sulla rete Docker interna tramite il container `message_gateway` sulla porta `3000` (esposto sull'host alla porta `3005`).

---

## Stack tecnico main-app

- **Backend**: NestJS, TypeORM, GraphQL (code-first con decoratori), PostgreSQL
- **Frontend**: Angular 17+, Angular Material, architettura a layer (smart/dumb components, services, store)
- **Auth**: JWT + ruoli
- **ORM**: TypeORM con migrations
- **Pattern**: repository pattern, domain services, DTOs separati per GraphQL input/output

---

## Architettura: cosa passa dal gateway e cosa no

Il gateway è necessario solo per le operazioni che richiedono BullMQ (scheduling). Le transizioni di stato `read` e `complete` vengono gestite **direttamente dalla main app** nel suo DB, senza passare dal gateway (round-trip inutile: la main app chiamerebbe il gateway, che invierebbe un webhook alla stessa main app).

| Operazione | Passa dal gateway? | Perché |
|---|---|---|
| **Create** | **Sì** | Il gateway gestisce scheduling BullMQ per messaggi con `availableFrom` futuro |
| **Update** (schedulato) | **Sì** | Il gateway deve rischedulare il job BullMQ |
| **Delete** (schedulato) | **Sì** | Il gateway deve rimuovere il job BullMQ |
| **Delete** (available) | **No** | La main app aggiorna direttamente il DB. Il gateway non ha job da rimuovere |
| **Read** | **No** | La main app aggiorna direttamente `status=READ` + `read_at` nel suo DB |
| **Complete** | **No** | La main app aggiorna direttamente `status=COMPLETED` + `completed_at` nel suo DB |
| **Attivazione schedulata** | **Sì (webhook)** | BullMQ fires → gateway invia webhook `task_message.available` → main app aggiorna DB |

**Il gateway resta comunque idempotente**: gli endpoint `POST /task-messages/:id/read` e `POST /task-messages/:id/complete` esistono nel gateway e funzionano. Se in futuro si volesse far passare tutto dal gateway (per centralizzare o auditare), basta cambiare il flusso nella main app senza modificare il gateway.

---

## Macchina a stati del messaggio

```
SCHEDULED ──[BullMQ fires / data arriva]──→ AVAILABLE ──[destinatario apre]──→ READ ──[destinatario completa]──→ COMPLETED
    │                                            │
    └──[mittente cancella]──→ DELETED            └──[mittente cancella]──→ DELETED
    │
    └──[mittente modifica]──→ SCHEDULED (aggiornato)
```

**Regole chiave:**
- `SCHEDULED`: messaggio invisibile al destinatario. Il mittente può modificare contenuto e data, oppure cancellare.
- `AVAILABLE`: messaggio visibile al destinatario. Il mittente può solo cancellare (non più modificare).
- `READ`: il destinatario ha aperto il messaggio. Il mittente non può più né modificare né cancellare.
- `COMPLETED`: il destinatario ha segnato il task come eseguito. Stato terminale.
- `DELETED`: cancellato dal mittente. Stato terminale.

---

## Parte 1: Schema database (TypeORM migrations)

### Tabella `task_message`
Source of truth per le query del frontend. Il DB della main app è il repository persistente.

```sql
CREATE TABLE task_message (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway_message_id UUID NOT NULL UNIQUE,        -- ID univoco assegnato dal gateway (= messageId nella response di create)
  tenant_id VARCHAR(100) NOT NULL,
  sender_user_id UUID NOT NULL,                    -- FK verso tabella utenti (User A - mittente)
  recipient_user_id UUID NOT NULL,                 -- FK verso tabella utenti (User B - destinatario)
  content TEXT NOT NULL,                           -- Testo del messaggio/task
  status VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED | AVAILABLE | READ | COMPLETED | DELETED
  available_from TIMESTAMPTZ,                      -- Data visibilità. NULL = disponibile subito
  correlation_id UUID,                             -- Tracciabilità end-to-end
  read_at TIMESTAMPTZ,                             -- Quando utente B ha aperto
  completed_at TIMESTAMPTZ,                        -- Quando utente B ha segnato completato
  deleted_at TIMESTAMPTZ,                          -- Soft delete
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_msg_tenant_recipient_status ON task_message(tenant_id, recipient_user_id, status);
CREATE INDEX idx_task_msg_tenant_sender_status ON task_message(tenant_id, sender_user_id, status);
CREATE INDEX idx_task_msg_gateway_id ON task_message(gateway_message_id);
CREATE INDEX idx_task_msg_correlation ON task_message(correlation_id);
CREATE INDEX idx_task_msg_tenant_completed ON task_message(tenant_id, status) WHERE status = 'COMPLETED';
```

### Tabella `task_message_webhook_event`
Archivio grezzo dei webhook ricevuti dal gateway (audit e debug).

```sql
CREATE TABLE task_message_webhook_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  correlation_id UUID,
  event_type VARCHAR(100) NOT NULL,                -- 'task_message.created' | 'task_message.available' | ecc.
  raw_event JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_task_webhook_tenant ON task_message_webhook_event(tenant_id);
CREATE INDEX idx_task_webhook_type ON task_message_webhook_event(event_type);
```

---

## Parte 2: Backend NestJS

### Modulo da creare: `TaskMessageModule`

Struttura a layer:

```
src/
  task-message/
    task-message.module.ts
    entities/
      task-message.entity.ts                (TypeORM entity per task_message)
      task-message-webhook-event.entity.ts  (TypeORM entity per task_message_webhook_event)
    repositories/
      task-message.repository.ts
    services/
      task-message.service.ts               (Business logic + persistenza + query + transizioni locali)
      task-message-gateway.service.ts       (HTTP client verso il gateway — solo create/update/delete schedulato)
    resolvers/
      task-message.resolver.ts              (GraphQL queries + mutations)
    webhook/
      task-message-webhook.controller.ts    (REST — non serve endpoint dedicato, usa il routing nel webhook esistente)
      task-message-webhook.service.ts       (Logica di processing webhook)
    dto/
      create-task-message.input.ts          (GraphQL input)
      update-task-message.input.ts          (GraphQL input)
      task-message.type.ts                  (GraphQL output type)
```

---

### 2.1 Gateway Service (chiamate HTTP al gateway)

Il servizio `TaskMessageGatewayService` usa `@nestjs/axios` per chiamare il gateway. **Solo per le operazioni che richiedono BullMQ.**

#### Creare un messaggio/task

```
POST {gateway_url}/task-messages
Headers:
  Content-Type: application/json
  x-tenant-id: {tenantId}
  x-tenant-api-key: {gateway_api_key}

Body:
{
  "senderUserId": "uuid-utente-a",
  "recipientUserId": "uuid-utente-b",
  "content": "Ricordati di inviare il report mensile entro fine mese.",
  "availableFrom": "2026-03-25T00:00:00Z",   // opzionale, se omesso → disponibile subito
  "correlationId": "uuid-opzionale"
}

Response 201:
{
  "messageId": "uuid-assegnato-dal-gateway",
  "status": "SCHEDULED"  // oppure "AVAILABLE" se availableFrom è null/passato
}
```

#### Modificare un messaggio schedulato

```
PATCH {gateway_url}/task-messages/{messageId}?senderUserId={uuid}
Headers:
  Content-Type: application/json
  x-tenant-id: {tenantId}
  x-tenant-api-key: {gateway_api_key}

Body:
{
  "content": "Contenuto aggiornato",           // opzionale
  "availableFrom": "2026-03-28T00:00:00Z"      // opzionale
}

Response 200:
{ "status": "updated" }
```

**Vincoli:** Solo se status == `SCHEDULED` e il chiamante è il mittente. Altrimenti 400/403.

#### Cancellare un messaggio SCHEDULATO (richiede rimozione job BullMQ)

```
DELETE {gateway_url}/task-messages/{messageId}?senderUserId={uuid}
Headers:
  x-tenant-id: {tenantId}
  x-tenant-api-key: {gateway_api_key}

Response 200:
{ "status": "deleted" }
```

**Vincoli:** Solo se status == `SCHEDULED` o `AVAILABLE` e il chiamante è il mittente. Altrimenti 400/403.

**Nota:** Per cancellare un messaggio `AVAILABLE`, la main app può anche aggiornare direttamente il suo DB senza passare dal gateway (non c'è nessun job BullMQ da rimuovere). L'endpoint gateway resta disponibile per compatibilità.

#### Health check

```
GET {gateway_url}/task-messages/health
Headers:
  x-tenant-id: {tenantId}
  x-tenant-api-key: {gateway_api_key}

Response 200:
{ "status": "ok", "module": "task-messages", "tenantId": "...", "timestamp": "..." }
```

---

### 2.2 Webhook Controller (ricezione eventi dal gateway)

Il gateway invia webhook alla main app **solo per le transizioni che gestisce lui**:

| Evento webhook | Quando | Azione main-app |
|--------|--------|-----------------|
| `task_message.created` | Messaggio creato (SCHEDULED o AVAILABLE) | Inserisci record in `task_message` con i dati dal payload |
| `task_message.updated` | Messaggio schedulato modificato via gateway | Aggiorna contenuto/data in `task_message` |
| `task_message.available` | BullMQ ha attivato un messaggio schedulato | Aggiorna `status = 'AVAILABLE'`. **Notifica il destinatario** |
| `task_message.deleted` | Mittente ha cancellato via gateway | Aggiorna `status = 'DELETED'` + `deleted_at` |

**Non ci sono webhook per `read` e `complete`** — queste transizioni vengono gestite direttamente dalla main app nel suo DB.

**URL:** I webhook task-messages arrivano sullo **stesso endpoint** `MAIN_APP_WEBHOOK_URL` già configurato per WhatsApp (il gateway usa la stessa coda `callback-webhook`). La main-app deve distinguerli tramite il campo `gateway_metadata.source`.

**Struttura payload webhook ricevuto:**
```json
{
  "gateway_metadata": {
    "source": "task-message-service",
    "event": "task_message.available",
    "message_id": "uuid-messaggio",
    "correlation_id": "uuid",
    "tenant_id": "studio-roma-01",
    "sender_user_id": "uuid-utente-a",
    "recipient_user_id": "uuid-utente-b",
    "content": "Testo del messaggio",
    "status": "AVAILABLE",
    "available_from": "2026-03-25T00:00:00Z",
    "created_at": "2026-03-15T10:00:00Z",
    "timestamp": "2026-03-25T00:00:01Z"
  }
}
```

**Verifica firma HMAC (obbligatoria):**

Stessa logica già implementata per il webhook WhatsApp. Il secret per-tenant è in OpenBao (`kv/whatsapp/{tenantId}/webhook_secret`). Usare `timingSafeEqual` per il confronto.

```typescript
import * as crypto from 'crypto';

function verifyWebhookSignature(
  body: string,           // raw body come stringa
  signature: string,      // valore header X-Webhook-Signature
  secret: string,         // da OpenBao
): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}
```

**Logica di routing nel webhook controller esistente:**

Poiché il gateway invia tutti i webhook (WhatsApp + Task Messages) allo stesso URL, il webhook controller esistente (`POST /api/webhooks/whatsapp`) deve essere aggiornato per fare routing:

```typescript
// Nel webhook controller/service esistente:
const metadata = body.gateway_metadata;

if (metadata?.source === 'task-message-service') {
  // Delega al TaskMessageWebhookService
  await this.taskMessageWebhookService.processEvent(metadata, rawBody, tenantId);
} else {
  // Logica WhatsApp esistente (invariata)
  await this.whatsappWebhookService.processEvent(body, tenantId);
}
```

**Logica nel TaskMessageWebhookService:**

1. Verificare firma HMAC (se non già verificata dal controller padre)
2. Salvare evento grezzo in `task_message_webhook_event`
3. In base a `metadata.event`:
   - `task_message.created` → Crea record in `task_message` con tutti i campi dal payload. Se `status === 'AVAILABLE'`, notifica il destinatario
   - `task_message.updated` → Aggiorna `content`, `available_from`, `updated_at` sul record esistente (match per `gateway_message_id`)
   - `task_message.available` → Aggiorna `status = 'AVAILABLE'`, `updated_at`. **Invia notifica real-time al destinatario**
   - `task_message.deleted` → Aggiorna `status = 'DELETED'`, `deleted_at`, `updated_at`
4. Rispondere sempre **200 OK**

---

### 2.3 Task Message Service (Business Logic)

Questo service gestisce la logica di business lato main-app. Le operazioni che richiedono BullMQ passano dal gateway; le transizioni di stato semplici vengono gestite localmente.

#### Operazioni che passano dal gateway

**Flusso per creare un messaggio (User A dal frontend):**

1. Frontend Angular → GraphQL mutation `createTaskMessage`
2. Resolver chiama `TaskMessageService.create()`
3. Service chiama `TaskMessageGatewayService.create()` → HTTP POST al gateway
4. Gateway risponde con `{ messageId, status }`
5. **NON salvare subito in DB** — il webhook `task_message.created` arriverà dal gateway e il webhook service salverà il record. Questo evita duplicazioni.
6. Restituire `{ messageId, status }` al frontend come conferma provvisoria

**Flusso per modificare un messaggio schedulato (User A dal frontend):**

1. User A modifica contenuto o data
2. Frontend → GraphQL mutation `updateTaskMessage(messageId, input)`
3. Service verifica nel DB locale che `status === 'SCHEDULED'` e `sender_user_id === currentUser`
4. Service chiama `TaskMessageGatewayService.update()` → HTTP PATCH al gateway
5. Il webhook `task_message.updated` arriverà e aggiornerà il DB

**Flusso per cancellare un messaggio SCHEDULATO (User A dal frontend):**

1. User A clicca "Cancella" su un messaggio SCHEDULED
2. Frontend → GraphQL mutation `deleteTaskMessage(messageId)`
3. Service verifica nel DB locale che `status === 'SCHEDULED'` e `sender_user_id === currentUser`
4. Service chiama `TaskMessageGatewayService.delete()` → HTTP DELETE al gateway (rimuove il job BullMQ)
5. Il webhook `task_message.deleted` arriverà e aggiornerà il DB

#### Operazioni gestite direttamente dalla main app (senza gateway)

**Flusso per cancellare un messaggio AVAILABLE (User A dal frontend):**

1. User A clicca "Cancella" su un messaggio AVAILABLE
2. Frontend → GraphQL mutation `deleteTaskMessage(messageId)`
3. Service verifica nel DB locale che `status === 'AVAILABLE'` e `sender_user_id === currentUser`
4. Service aggiorna direttamente nel DB: `status = 'DELETED'`, `deleted_at = NOW()`, `updated_at = NOW()`
5. Nessuna chiamata al gateway (non c'è job BullMQ da rimuovere)

**Flusso per leggere un messaggio (User B dal frontend):**

1. User B apre il messaggio nel frontend
2. Frontend → GraphQL mutation `markTaskMessageAsRead(messageId)`
3. Service verifica nel DB locale che `status === 'AVAILABLE'` e `recipient_user_id === currentUser`
4. Service aggiorna direttamente nel DB: `status = 'READ'`, `read_at = NOW()`, `updated_at = NOW()`
5. Nessuna chiamata al gateway

**Flusso per completare un task (User B dal frontend):**

1. User B clicca "Segna come completato"
2. Frontend → GraphQL mutation `completeTaskMessage(messageId)`
3. Service verifica nel DB locale che `status === 'READ'` e `recipient_user_id === currentUser`
4. Service aggiorna direttamente nel DB: `status = 'COMPLETED'`, `completed_at = NOW()`, `updated_at = NOW()`
5. Nessuna chiamata al gateway

#### Idempotenza

Tutte le transizioni devono essere **idempotenti**: se un messaggio è già `READ`, una seconda chiamata `markAsRead` non fa nulla (ritorna successo senza errore). Questo garantisce che:
- Se il gateway viene chiamato per errore (future refactoring), non si rompe nulla
- Le race condition tra webhook e operazioni dirette non causano problemi
- Il frontend può riprovare senza rischi

```typescript
async markAsRead(messageId: string, currentUserId: string, tenantId: string): Promise<boolean> {
  const msg = await this.repository.findOne({
    where: { gatewayMessageId: messageId, tenantId }
  });
  if (!msg) throw new NotFoundException();
  if (msg.recipientUserId !== currentUserId) throw new ForbiddenException();

  // Idempotente: se già READ o oltre, non fare nulla
  if (msg.status === 'READ' || msg.status === 'COMPLETED') return true;
  if (msg.status !== 'AVAILABLE') throw new BadRequestException('Messaggio non disponibile');

  msg.status = 'READ';
  msg.readAt = new Date();
  msg.updatedAt = new Date();
  await this.repository.save(msg);
  return true;
}
```

#### Query per il frontend (lette dal DB locale)

Queste query leggono direttamente dal DB PostgreSQL della main-app, NON dal gateway.

```typescript
// Inbox del destinatario (messaggi disponibili + letti, non completati/cancellati)
async getInbox(tenantId: string, recipientUserId: string): Promise<TaskMessage[]>
// Filtro: status IN ('AVAILABLE', 'READ'), ordinato per created_at DESC

// Messaggi inviati dal mittente (tutti gli stati tranne DELETED)
async getSent(tenantId: string, senderUserId: string): Promise<TaskMessage[]>
// Filtro: status != 'DELETED', ordinato per created_at DESC

// Task completati (per entrambi)
async getCompleted(tenantId: string, userId: string): Promise<TaskMessage[]>
// Filtro: status = 'COMPLETED' AND (sender_user_id = userId OR recipient_user_id = userId)

// Conteggio non letti (per badge notifiche)
async countUnread(tenantId: string, recipientUserId: string): Promise<number>
// Filtro: status = 'AVAILABLE' AND recipient_user_id = userId
```

---

### 2.4 Notifiche Real-time al Frontend

Quando il webhook `task_message.available` arriva (messaggio schedulato diventa disponibile) o un messaggio viene creato con status `AVAILABLE` (immediato), la main-app deve notificare il destinatario.

**Opzioni consigliate (in ordine di semplicità):**

1. **Polling leggero** (raccomandato per MVP): il frontend chiama periodicamente una query GraphQL `taskMessageUnreadCount` ogni 30-60 secondi. Se il conteggio cambia, aggiorna il badge e opzionalmente fa refetch dell'inbox.

2. **GraphQL Subscriptions** (WebSocket): per notifiche istantanee, implementare una subscription `onTaskMessageReceived(recipientUserId)` che il webhook service pubblica quando processa un evento `task_message.available`.

3. **Server-Sent Events (SSE)**: alternativa più leggera ai WebSocket per notifiche push unidirezionali.

Per l'MVP partire con il polling, poi eventualmente aggiungere subscriptions.

---

## Parte 3: GraphQL API

### Types

```graphql
enum TaskMessageStatus {
  SCHEDULED
  AVAILABLE
  READ
  COMPLETED
  DELETED
}

type TaskMessage {
  id: ID!
  gatewayMessageId: String!
  tenantId: String!
  senderUserId: String!
  senderUser: User                    # Relazione: risolvi nome utente per visualizzazione
  recipientUserId: String!
  recipientUser: User                 # Relazione: risolvi nome utente per visualizzazione
  content: String!
  status: TaskMessageStatus!
  availableFrom: DateTime
  readAt: DateTime
  completedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
}

type TaskMessagePage {
  items: [TaskMessage!]!
  total: Int!
}
```

### Queries

```graphql
type Query {
  # Inbox destinatario: messaggi AVAILABLE + READ
  taskMessageInbox(
    page: Int = 1
    limit: Int = 20
  ): TaskMessagePage!

  # Messaggi inviati dal mittente (tutti gli stati visibili)
  taskMessageSent(
    page: Int = 1
    limit: Int = 20
  ): TaskMessagePage!

  # Task completati (sia come mittente che come destinatario)
  taskMessageCompleted(
    page: Int = 1
    limit: Int = 20
  ): TaskMessagePage!

  # Singolo messaggio per dettaglio
  taskMessage(id: ID!): TaskMessage

  # Conteggio messaggi non letti (per badge)
  taskMessageUnreadCount: Int!
}
```

**Nota:** `tenantId` e `userId` vengono estratti dal JWT dell'utente autenticato, NON passati come parametri. Il resolver li ricava dal contesto della richiesta.

### Mutations

```graphql
input CreateTaskMessageInput {
  recipientUserId: String!
  content: String!
  availableFrom: DateTime             # Opzionale: se omesso → disponibile subito
}

input UpdateTaskMessageInput {
  content: String                     # Opzionale
  availableFrom: DateTime             # Opzionale
}

type TaskMessageResult {
  messageId: String!
  status: TaskMessageStatus!
}

type Mutation {
  # User A crea un messaggio/task → passa dal gateway
  createTaskMessage(input: CreateTaskMessageInput!): TaskMessageResult!

  # User A modifica messaggio schedulato → passa dal gateway
  updateTaskMessage(messageId: String!, input: UpdateTaskMessageInput!): Boolean!

  # User A cancella messaggio → gateway se SCHEDULED, diretto se AVAILABLE
  deleteTaskMessage(messageId: String!): Boolean!

  # User B segna come letto → diretto nel DB (non passa dal gateway)
  markTaskMessageAsRead(messageId: String!): Boolean!

  # User B segna task come completato → diretto nel DB (non passa dal gateway)
  completeTaskMessage(messageId: String!): Boolean!
}
```

---

## Parte 4: Frontend Angular

### 4.1 Area Messaggi/Task

**Route principale:** `/task-messages` (accessibile a tutti gli utenti autenticati)

**Sub-route e tab:**

```
/task-messages
  ├── /inbox        ← Tab "Ricevuti" (default)
  ├── /sent         ← Tab "Inviati"
  └── /completed    ← Tab "Completati"
```

### Struttura componenti

```
task-messages/
  task-messages.module.ts
  task-messages-routing.module.ts
  containers/
    task-messages-page/                  ← smart component (pagina con tab)
      task-messages-page.component.ts
    task-message-compose/                ← smart component (dialog creazione)
      task-message-compose.component.ts
  components/
    task-message-list/                   ← dumb component (lista messaggi)
      Inputs: messages: TaskMessage[], emptyText: string
      Outputs: open, delete, complete
    task-message-card/                   ← dumb component (singolo messaggio nella lista)
      Inputs: message: TaskMessage, isOwner: boolean
      Outputs: open, delete, edit, complete
    task-message-detail/                 ← dumb component (dialog dettaglio)
      Inputs: message: TaskMessage, currentUserId: string
      Outputs: markRead, complete, close
    task-message-compose-form/           ← dumb component (form creazione/modifica)
      Inputs: users: User[], editMode: boolean, message?: TaskMessage
      Outputs: save: EventEmitter<CreateTaskMessageInput>
  services/
    task-message.service.ts              ← chiamate GraphQL
    task-message-notification.service.ts ← polling conteggio non letti
```

### 4.2 Layout pagina principale

```
┌──────────────────────────────────────────────────────────┐
│  Messaggi & Task                          [+ Nuovo Task] │
├──────────────────────────────────────────────────────────┤
│  [Ricevuti (3)]    [Inviati]    [Completati]             │
│  ─── mat-tab-group ────────────────────────────────────  │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ● Da: Mario Rossi                   15 Mar 2026   │  │
│  │   Ricordati di inviare il report mensile...        │  │
│  │   Stato: ■ DISPONIBILE                             │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ ○ Da: Luca Bianchi                  10 Mar 2026   │  │
│  │   Controlla fatture Q1 e inviale a contabilità     │  │
│  │   Stato: ■ LETTO                    [✓ Completa]  │  │
│  ├────────────────────────────────────────────────────┤  │
│  │ ◎ Da: Anna Verdi          Disponibile dal 25 Mar  │  │
│  │   (messaggio non ancora visibile - schedulato)     │  │
│  │   Stato: ■ SCHEDULATO                              │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  [mat-paginator]                                         │
└──────────────────────────────────────────────────────────┘
```

### 4.3 Tab "Ricevuti" (Inbox)

Mostra messaggi con status `AVAILABLE` e `READ` dove l'utente corrente è il **destinatario**.

**Comportamento per messaggio:**
- Se `AVAILABLE` (non letto): sfondo evidenziato / badge "Nuovo". Al click → apri dialog dettaglio → auto-invoca `markTaskMessageAsRead`
- Se `READ` (letto): sfondo normale. Mostra pulsante "Segna come completato"
- Ordinamento: `created_at DESC`

### 4.4 Tab "Inviati"

Mostra messaggi dove l'utente corrente è il **mittente**. Tutti gli stati visibili tranne `DELETED`.

**Comportamento per stato:**
- `SCHEDULED`: icona orologio + data programmata. Azioni: "Modifica", "Cancella"
- `AVAILABLE`: icona busta. Azione: "Cancella"
- `READ`: icona occhio. Nessuna azione (non modificabile, non cancellabile)
- `COMPLETED`: icona check verde. Nessuna azione.

### 4.5 Tab "Completati"

Mostra messaggi con status `COMPLETED` dove l'utente è **mittente o destinatario**. Archivio dei task eseguiti.

### 4.6 Dialog Creazione/Modifica Messaggio

```
┌─────────────────────────────────────────┐
│  Nuovo Messaggio/Task                    │
├─────────────────────────────────────────┤
│                                          │
│  Destinatario:  [mat-autocomplete]  *   │
│  (ricerca utenti per nome)               │
│                                          │
│  Contenuto:     [mat-form-field]    *   │
│  [textarea multilinea]                   │
│                                          │
│  Disponibile dal: [mat-datepicker]      │
│  (opzionale - lascia vuoto per subito)   │
│                                          │
│  Se la data è impostata:                 │
│  ℹ️  Il destinatario vedrà il messaggio  │
│     solo a partire dalla data indicata.  │
│                                          │
│            [Annulla]    [Invia]          │
└─────────────────────────────────────────┘
```

### 4.7 Badge Notifiche

Aggiungere un badge con conteggio messaggi non letti nell'area appropriata del layout principale (sidebar, toolbar, o nav).

```typescript
// task-message-notification.service.ts
// Polling ogni 30 secondi
@Injectable()
export class TaskMessageNotificationService {
  private unreadCount$ = new BehaviorSubject<number>(0);

  constructor(private taskMessageService: TaskMessageService) {
    // Poll ogni 30 secondi
    interval(30000).pipe(
      startWith(0),
      switchMap(() => this.taskMessageService.getUnreadCount()),
    ).subscribe(count => this.unreadCount$.next(count));
  }

  get unreadCount(): Observable<number> {
    return this.unreadCount$.asObservable();
  }
}
```

Il badge deve mostrare il numero di messaggi `AVAILABLE` (non ancora letti) per l'utente corrente.

---

## Parte 5: Sicurezza

### Autenticazione e autorizzazione

- Tutte le GraphQL queries/mutations richiedono autenticazione JWT
- Le chiamate al gateway usano `x-tenant-id` e `x-tenant-api-key` (credenziali del tenant, non dell'utente)
- Il `senderUserId` viene preso dal JWT dell'utente corrente, **non dal frontend** (prevenire spoofing)
- Le query filtrano automaticamente per `tenantId` del JWT (isolamento multi-tenant)

### Webhook

- Stessa verifica HMAC già in uso per i webhook WhatsApp
- Stessa chiave per-tenant da OpenBao (`kv/whatsapp/{tenantId}/webhook_secret`)

### Validazione

- `recipientUserId` deve essere un utente valido appartenente allo stesso tenant
- `content` non può essere vuoto
- `availableFrom` se presente deve essere nel futuro
- Il mittente non può inviare messaggi a se stesso

---

## Parte 6: Flusso completo end-to-end (esempio)

1. **User A** (Mario) crea un task per **User B** (Luca): "Invia fatture Q1" disponibile dal 25 marzo
2. Frontend → `createTaskMessage({ recipientUserId: luca_id, content: "Invia fatture Q1", availableFrom: "2026-03-25" })`
3. Main app → POST al gateway → Gateway crea job BullMQ con delay → risponde `{ messageId, status: "SCHEDULED" }`
4. Webhook `task_message.created` arriva → main app salva in DB con status `SCHEDULED`
5. Mario vede nella tab "Inviati": "Invia fatture Q1 - SCHEDULATO - disponibile dal 25/03"
6. Mario può modificare il testo o la data (via gateway), oppure cancellare (via gateway)
7. **25 marzo**: BullMQ fires → webhook `task_message.available` → main app aggiorna status a `AVAILABLE`
8. Luca vede badge "1 nuovo messaggio" e nella tab "Ricevuti": "Invia fatture Q1"
9. Luca apre il messaggio → **main app aggiorna direttamente** `status = READ` nel suo DB (senza chiamare il gateway)
10. Mario vede nella tab "Inviati": status cambia a `LETTO` (non può più cancellare)
11. Luca invia le fatture e clicca "Segna come completato" → **main app aggiorna direttamente** `status = COMPLETED` nel suo DB
12. Il task si sposta nella tab "Completati" sia per Mario che per Luca

---

## Parte 7: Checklist implementazione

### Backend
- [ ] Creare migration TypeORM per `task_message` e `task_message_webhook_event`
- [ ] Creare entities TypeORM
- [ ] Creare `TaskMessageGatewayService` con metodi HTTP verso gateway (solo: create, update, delete per SCHEDULED)
- [ ] Creare `TaskMessageWebhookService` per processing dei webhook ricevuti (created, updated, available, deleted)
- [ ] Aggiornare il webhook controller esistente per fare routing tra WhatsApp e Task Messages (basato su `gateway_metadata.source`)
- [ ] Creare `TaskMessageService` con:
  - Logica business: create (via gateway), update (via gateway), delete (gateway se SCHEDULED, diretto se AVAILABLE)
  - Transizioni locali idempotenti: markAsRead, markAsCompleted (dirette nel DB, senza gateway)
  - Query per il frontend: inbox, sent, completed, unreadCount
- [ ] Creare `TaskMessageResolver` con queries e mutations GraphQL
- [ ] Validazione: recipient deve esistere e appartenere allo stesso tenant
- [ ] Validazione: senderUserId dal JWT, non dal frontend

### Frontend
- [ ] Creare modulo `TaskMessagesModule` con routing
- [ ] Pagina principale con 3 tab (Ricevuti, Inviati, Completati)
- [ ] Componente lista messaggi (`task-message-list`)
- [ ] Componente card messaggio (`task-message-card`) con azioni contestuali per stato
- [ ] Dialog dettaglio messaggio (`task-message-detail`) con auto-read
- [ ] Dialog creazione/modifica (`task-message-compose`) con autocomplete destinatario + datepicker
- [ ] Servizio notifiche con polling conteggio non letti
- [ ] Badge notifiche nella navbar/sidebar
- [ ] Aggiungere voce nel menu di navigazione

---

## Note importanti

1. **Il DB della main app è la source of truth** per le query del frontend. Il gateway è solo un orchestratore per lo scheduling BullMQ. Le transizioni `read` e `complete` avvengono direttamente nel DB della main app.

2. **Il `gateway_message_id`** è l'UUID restituito dal gateway nella risposta di creazione (`messageId`). È l'ID usato per le chiamate al gateway (update, delete) e per il matching con i webhook. Salvarlo nella tabella `task_message`.

3. **Stessa infrastruttura webhook.** I webhook task-messages arrivano sullo stesso URL `MAIN_APP_WEBHOOK_URL` dei webhook WhatsApp. Distinguere tramite `gateway_metadata.source === 'task-message-service'`.

4. **Credenziali gateway.** Le credenziali (`gateway_url`, `gateway_api_key`) sono le stesse già configurate in `whatsapp_tenant_config`. Non serve una tabella di configurazione separata per i task messages.

5. **Formato date.** Tutte le date sono in formato ISO 8601 con timezone (es. `2026-03-25T00:00:00Z`).

6. **Multi-tenancy.** Il `tenantId` viene estratto dal JWT dell'utente. Tutte le query devono filtrare per `tenant_id`.

7. **Idempotenza.** Tutte le transizioni di stato sono idempotenti. Se un messaggio è già nello stato target, l'operazione ritorna successo senza errore. Questo permette di far passare le operazioni dal gateway in futuro senza breaking changes.

8. **Fire-and-forget per il gateway.** Le chiamate al gateway (create, update, delete schedulato) non devono bloccare il frontend. Il frontend mostra uno stato ottimistico e si aggiorna quando il polling conferma il cambio di stato.

9. **Endpoint gateway idempotenti.** Gli endpoint `POST /task-messages/:id/read` e `POST /task-messages/:id/complete` esistono nel gateway e funzionano. Attualmente non vengono usati dalla main app, ma restano disponibili per futuri scenari (auditing centralizzato, ecc.).
