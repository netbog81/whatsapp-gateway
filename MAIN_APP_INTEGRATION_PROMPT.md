# Prompt per l'agente: Integrazione WhatsApp Gateway nella Main App

## Contesto

La main-app è un'applicazione NestJS + TypeORM + GraphQL con frontend Angular Material e architettura a layer (module/resolver/service/repository). Deve integrarsi con un microservizio esterno chiamato **WhatsApp Gateway** già operativo.

Il gateway è raggiungibile sulla rete Docker interna tramite il container `message_gateway` sulla porta `3000` (esposto sull'host alla porta `3005`). È un servizio REST+Swagger che gestisce l'invio di messaggi WhatsApp via Evolution API, con code BullMQ, reminder automatici 24h prima degli appuntamenti e recap aggregati per paziente.

---

## Stack tecnico main-app

- **Backend**: NestJS, TypeORM, GraphQL (code-first con decoratori), PostgreSQL
- **Frontend**: Angular 17+, Angular Material, architettura a layer (smart/dumb components, services, store)
- **Auth**: JWT + ruoli
- **ORM**: TypeORM con migrations
- **Pattern**: repository pattern, domain services, DTOs separati per GraphQL input/output

---

## Parte 1: Schema database (TypeORM migrations)

### Tabella `whatsapp_tenant_config`
Configurazione per-tenant del gateway WhatsApp. Un tenant corrisponde a uno studio/cliente.

```sql
CREATE TABLE whatsapp_tenant_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL UNIQUE,          -- ID tenant (deve corrispondere al nome istanza Evolution, es. "bdq")
  gateway_url VARCHAR(500) NOT NULL,               -- URL base del gateway (es. "http://message_gateway:3000")
  gateway_api_key VARCHAR(500) NOT NULL,           -- API key con cui la main-app chiama il gateway (CIFRATA a riposo)
  is_active BOOLEAN NOT NULL DEFAULT true,
  recap_delay_seconds INT NOT NULL DEFAULT 60,     -- Buffer recap 30-600s, inviato al gateway come recapDelaySeconds
  reminder_hours_before INT NOT NULL DEFAULT 24,   -- Ore prima per reminder (informativo, logica nel gateway)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Tabella `whatsapp_message_template`
Template messaggi personalizzabili per-tenant.

```sql
CREATE TABLE whatsapp_message_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  template_type VARCHAR(50) NOT NULL,              -- 'RECAP_SINGLE' | 'RECAP_MULTI' | 'REMINDER_24H' | 'CANCELLATION' | 'UPDATE'
  template_text TEXT NOT NULL,                     -- Testo con variabili: {name}, {date}, {time}, {appointments}
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_tenant_template UNIQUE (tenant_id, template_type)
);
```

**Template di default da inserire al seed:**
```
RECAP_SINGLE:  "Gentile {name}, confermiamo il suo appuntamento per il {date} alle {time}."
RECAP_MULTI:   "Gentile {name}, confermiamo i seguenti appuntamenti:\n{appointments}"
REMINDER_24H:  "Promemoria: il suo appuntamento è domani alle {time}."
```

La main-app è responsabile di **comporre il testo finale** prima di inviarlo al gateway, sostituendo le variabili `{name}`, `{date}`, `{time}`, `{appointments}` con i valori reali dell'appuntamento. Il testo composto viene passato nei campi `recapMessage` e `reminderMessage` del payload. Se omessi, il gateway usa testi di fallback hardcoded.

### Tabella `whatsapp_message_log`
Log di tutti i messaggi inviati/ricevuti tramite il gateway.

```sql
CREATE TABLE whatsapp_message_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  correlation_id UUID,                             -- ID univoco dalla chiamata al gateway
  appointment_id VARCHAR(100),                     -- ID appuntamento referenziato
  patient_id VARCHAR(100),                         -- ID paziente
  patient_name VARCHAR(255),
  patient_phone VARCHAR(50),
  message_type VARCHAR(50) NOT NULL,               -- 'RECAP' | 'REMINDER_24H' | 'INBOUND' | 'STATUS_UPDATE'
  direction VARCHAR(10) NOT NULL,                  -- 'OUTBOUND' | 'INBOUND'
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING',   -- 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'
  evolution_message_id VARCHAR(255),               -- ID messaggio restituito da Evolution API
  raw_payload JSONB,                               -- Payload raw dell'evento Evolution (per debug)
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_whatsapp_log_tenant ON whatsapp_message_log(tenant_id);
CREATE INDEX idx_whatsapp_log_appointment ON whatsapp_message_log(appointment_id);
CREATE INDEX idx_whatsapp_log_patient ON whatsapp_message_log(patient_id);
CREATE INDEX idx_whatsapp_log_status ON whatsapp_message_log(status);
CREATE INDEX idx_whatsapp_log_correlation ON whatsapp_message_log(correlation_id);
```

### Tabella `whatsapp_webhook_event`
Archivio grezzo degli eventi ricevuti dal gateway (per audit e debug).

```sql
CREATE TABLE whatsapp_webhook_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR(100) NOT NULL,
  correlation_id UUID,
  event_type VARCHAR(100) NOT NULL,               -- 'messages.upsert' | 'messages.update' | 'connection.update' | ecc.
  raw_event JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT false,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_event_tenant ON whatsapp_webhook_event(tenant_id);
CREATE INDEX idx_webhook_event_type ON whatsapp_webhook_event(event_type);
CREATE INDEX idx_webhook_event_processed ON whatsapp_webhook_event(processed);
```

---

## Parte 2: Backend NestJS

### Modulo da creare: `WhatsappModule`

Struttura a layer:
```
src/
  whatsapp/
    whatsapp.module.ts
    config/
      whatsapp-config.entity.ts          (TypeORM entity per whatsapp_tenant_config)
      whatsapp-config.repository.ts
      whatsapp-config.service.ts
      whatsapp-config.resolver.ts        (GraphQL mutations/queries per configurazione)
    template/
      whatsapp-template.entity.ts
      whatsapp-template.repository.ts
      whatsapp-template.service.ts
      whatsapp-template.resolver.ts
    log/
      whatsapp-log.entity.ts
      whatsapp-log.repository.ts
      whatsapp-log.service.ts
      whatsapp-log.resolver.ts           (GraphQL queries per monitoraggio)
    webhook/
      whatsapp-webhook.controller.ts     (REST endpoint POST /api/webhooks/whatsapp)
      whatsapp-webhook.service.ts
    gateway/
      whatsapp-gateway.service.ts        (HTTP client verso il gateway esterno)
      whatsapp-gateway.dto.ts
```

---

### 2.1 Gateway Service (chiamate HTTP al gateway)

Il servizio `WhatsappGatewayService` usa `@nestjs/axios` per chiamare il gateway esterno.

**Metodo: dispatch appuntamento**
```typescript
async dispatchBooking(params: {
  tenantId: string;
  appointmentId: string;
  patientId: string;
  patientName: string;
  phone: string;
  date: string; // ISO 8601 SENZA offset, es. "2026-03-15T10:30:00"
  userId: string;
  correlationId?: string;
}): Promise<{ correlationId: string }>
```

**Chiamata HTTP generata:**
```
POST {gateway_url}/whatsapp/dispatch
Headers:
  Content-Type: application/json
  x-tenant-id: {tenantId}
  x-tenant-api-key: {gateway_api_key}   ← decifrata da DB prima dell'uso
  x-user-id: {userId}

Body:
{
  "type": "APPOINTMENT_BOOKING",
  "data": {
    "appointmentId": "string",
    "pazienteId": "string",
    "phone": "39XXXXXXXXXX",
    "date": "2026-03-15T10:30:00",
    "name": "Mario Rossi",
    "recapMessage": "Gentile Mario Rossi, confermiamo il suo appuntamento per il 15/03/2026 alle 10:30.",
    "reminderMessage": "Promemoria: il suo appuntamento è domani alle 10:30.",
    "recapMultiTemplate": "Gentile {name}, confermiamo i seguenti appuntamenti:\n{appointments}",
    "recapLine": "- 15/03/2026 alle 10:30",
    "recapDelaySeconds": 60
  },
  "correlationId": "uuid-opzionale"
}
```

**Formato di `date`: ora locale senza offset.** Il gateway interpreta la stringa
in `Europe/Rome` applicando da sé l'ora legale. Un offset fisso (`+01:00`) manda
in avanti di un'ora tutti i messaggi da fine marzo a fine ottobre.

**Recap multiplo:** se nella finestra di raggruppamento arriva più di un
appuntamento per lo stesso numero, il gateway compone il messaggio partendo da
`recapMultiTemplate` (grezzo) sostituendo `{name}` e `{appointments}` con
l'elenco delle `recapLine` bufferizzate. Il buffer è indicizzato per numero di
telefono, così funziona anche per i walk-in senza anagrafica.

**Finestra di raggruppamento (`recapDelaySeconds`, 30-600s, default 60):** è
**scorrevole**, cioè riparte a ogni nuovo appuntamento per lo stesso numero —
l'operatore non deve chiudere tutte le prenotazioni entro la prima finestra. Lo
slittamento si ferma a `min(5 × finestra, 15 minuti)` dal primo appuntamento del
gruppo, altrimenti una sequenza continua di prenotazioni rimanderebbe il recap
all'infinito. Valori fuori range vengono normalizzati dal gateway.

**Metodo: modifica appuntamento**
```
POST {gateway_url}/whatsapp/dispatch

Body:
{
  "type": "APPOINTMENT_UPDATE",
  "data": {
    "appointmentId": "string",
    "pazienteId": "string",
    "phone": "39XXXXXXXXXX",
    "date": "2026-03-16T11:00:00",          ← NUOVO orario
    "name": "Mario Rossi",
    "updateMessage": "Gentile Mario Rossi, il suo appuntamento è stato spostato al 16/03/2026 alle 11:00.",
    "reminderMessage": "Promemoria: il suo appuntamento è domani alle 11:00.",
    "sendUpdateNotification": true
  },
  "correlationId": "uuid-opzionale"
}
```

Il gateway rimuove il reminder programmato sul vecchio orario, invia la notifica
di spostamento (saltata con `sendUpdateNotification: false`) e riprogramma il
reminder 24h sul nuovo orario. La notifica non passa dal buffer recap.

**Metodo: cancellazione reminder**
```
DELETE {gateway_url}/whatsapp/booking/{appointmentId}
Headers:
  x-tenant-id: {tenantId}
  x-tenant-api-key: {gateway_api_key}
  x-user-id: {userId}
```

**Importante:** Dopo ogni chiamata al gateway, salvare un record in `whatsapp_message_log` con status `PENDING` e il `correlationId` restituito.

---

### 2.2 Webhook Controller (ricezione eventi dal gateway)

```
POST /api/webhooks/whatsapp
Headers ricevuti:
  x-tenant-id: {tenantId}
  x-correlation-id: {correlationId}
  x-webhook-signature: sha256={hmac_hex}
Body: payload raw dell'evento Evolution (JSON)
```

**URL configurato nel gateway:** `http://host-gateway:3000/api/webhooks/whatsapp`
(`host-gateway` è l'alias Docker per l'IP dell'host — la main-app gira direttamente sull'host sulla porta 3000.)
In produzione impostare nel `.env` del gateway: `MAIN_APP_WEBHOOK_URL=http://host-gateway:3000/api/webhooks/whatsapp`

**Struttura payload ricevuto:**
```json
{
  "event": "messages.update",
  "instance": "bdq",
  "data": {
    "key": {
      "remoteJid": "393515847659@s.whatsapp.net",
      "fromMe": true,
      "id": "EVOLUTION_MESSAGE_ID"
    },
    "update": {
      "status": "READ"
    }
  }
}
```

**Verifica firma HMAC (obbligatoria):**

Il gateway firma ogni webhook con `HMAC-SHA256(webhook_secret, body)` dove il secret è per-tenant (`kv/whatsapp/{tenantId}/webhook_secret` su OpenBao). La main-app deve verificare la firma prima di processare l'evento.

```typescript
import * as crypto from 'crypto';

function verifyWebhookSignature(
  body: string,           // raw body come stringa (NON parsato)
  signature: string,      // valore dell'header X-Webhook-Signature
  secret: string,         // secret letto da OpenBao per il tenant
): boolean {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  // Confronto timing-safe per prevenire timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected),
  );
}
```

**Attenzione:** per la verifica usare il **raw body** (Buffer/stringa), non il body già parsato da JSON. In NestJS usare `getRawBody()` o configurare un middleware che preserva il raw body prima del parsing.

Se la firma non è presente o non è valida, rispondere **401 Unauthorized** e loggare il tentativo.

**Logica nel webhook service:**

1. Verificare firma HMAC — se invalida, rispondere 401 e terminare
2. Salvare evento grezzo in `whatsapp_webhook_event`
3. In base a `event`:
   - `messages.upsert` → aggiorna `whatsapp_message_log.status = 'SENT'`, salva `evolution_message_id`, `sent_at = NOW()`
   - `messages.update` con `status = 'DELIVERY_ACK'` → aggiorna status `DELIVERED`, `delivered_at = NOW()`
   - `messages.update` con `status = 'READ'` → aggiorna status `READ`, `read_at = NOW()`
   - `connection.update` → log solo (utile per alert se istanza si disconnette)
   - `send.message` → conferma invio, aggiorna `evolution_message_id`
4. Rispondere sempre **200 OK** dopo verifica (anche in caso di errore interno di processing — logga ma non far ritentare il gateway inutilmente)

**Matching del log:** usa `correlationId` dall'header o `data.key.id` (evolution_message_id) per trovare il record in `whatsapp_message_log`.

---

### 2.3 Integrazione con il modulo Appuntamenti

Nei punti del codice dove vengono gestiti gli appuntamenti, iniettare `WhatsappGatewayService` e chiamare:

**Creazione appuntamento:**
```typescript
// Dopo il salvataggio in DB
await this.whatsappGatewayService.dispatchBooking({
  tenantId: tenant.whatsappTenantId,  // es. "bdq"
  appointmentId: appointment.id,
  patientId: patient.id,
  patientName: `${patient.firstName} ${patient.lastName}`,
  phone: patient.phone,               // formato +39XXXXXXXXXX
  date: appointment.startTime.toISOString(),
  userId: currentUser.id,
});
```

**Modifica appuntamento (cambio data/ora):**
1. Prima cancella il reminder precedente:
   ```typescript
   await this.whatsappGatewayService.cancelBooking(tenantId, appointment.id, userId);
   ```
2. Poi crea un nuovo dispatch con la nuova data.

**Cancellazione appuntamento:**
```typescript
await this.whatsappGatewayService.cancelBooking(tenantId, appointment.id, userId);
// Aggiorna anche il log: status = 'CANCELLED'
```

**Importante:** Tutte queste chiamate devono essere **fire-and-forget con gestione errori** — un errore del gateway non deve bloccare il salvataggio dell'appuntamento nel DB principale. Usa `try/catch` e loga l'errore senza rilanciarlo.

---

### 2.4 Endpoint Health e Test

#### Health check
```
GET {gateway_url}/whatsapp/health
Headers:
  x-tenant-id: {tenantId}
  x-tenant-api-key: {gateway_api_key}

Response 200:
{
  "status": "ok",
  "tenantId": "bdq",
  "timestamp": "2026-03-09T10:00:00.000Z"
}
```
Usare nel mutation `testWhatsappConnection` per verificare che URL e API key siano corretti.

#### Test invio diretto (sincrono)
```
POST {gateway_url}/whatsapp/test/direct
Headers: x-tenant-id, x-tenant-api-key
Body: { "phone": "393471234567", "name": "Mario Rossi", "message": "Testo opzionale" }

Response 200:
{
  "mode": "direct",
  "status": "sent",
  "evolutionMessageId": "XXXXXXXX",
  "phone": "393471234567",
  "text": "..."
}
```
Bypass completo della coda BullMQ — risposta immediata con esito da Evolution API.

#### Test recap + reminder singolo
```
POST {gateway_url}/whatsapp/test/recap
Headers: x-tenant-id, x-tenant-api-key
Body: { "phone": "393471234567", "name": "Mario Rossi" }

Response 200:
{
  "mode": "recap",
  "correlationId": "uuid",
  "pazienteId": "test-patient-XXXXXXXX",
  "appointmentId": "test-appt-XXXXXXXX",
  "appointmentDate": "2026-03-10T10:30:00.000+01:00",
  "scheduled": {
    "recap":    { "delaySeconds": 60,  "jobId": "test-recap:bdq:test-patient-..." },
    "reminder": { "delayMinutes": 5,   "jobId": "test-reminder:bdq:test-appt-..." }
  }
}
```
Simula 1 appuntamento reale nella coda: **recap dopo 60s** (delay di produzione), **reminder dopo 5 minuti** (simula il promemoria 24h anticipato).

#### Test flusso completo (3 appuntamenti)
```
POST {gateway_url}/whatsapp/test/full-flow
Headers: x-tenant-id, x-tenant-api-key
Body: { "phone": "393471234567", "name": "Mario Rossi" }

Response 200:
{
  "mode": "full-flow",
  "correlationId": "uuid",
  "pazienteId": "test-patient-XXXXXXXX",
  "appointmentCount": 3,
  "scheduled": {
    "recap": { "delaySeconds": 60, "jobId": "test-recap:bdq:test-patient-..." },
    "reminders": [
      { "label": "1", "appointmentDate": "...", "reminderDelayMinutes": 5, "jobId": "..." },
      { "label": "2", "appointmentDate": "...", "reminderDelayMinutes": 6, "jobId": "..." },
      { "label": "3", "appointmentDate": "...", "reminderDelayMinutes": 7, "jobId": "..." }
    ]
  }
}
```
Simula 3 appuntamenti dello stesso paziente: **recap aggregato dopo 60s** (un unico messaggio con tutti e tre), **3 reminder separati a 5/6/7 minuti**.

> **Nota:** Gli endpoint `/test/*` sono protetti dalla stessa `x-tenant-api-key` degli endpoint di produzione. Usarli solo in ambiente di staging/test con numeri di telefono reali del team.

---

## Parte 3: GraphQL API

### Query per il monitoraggio

```graphql
type WhatsappMessageLog {
  id: ID!
  tenantId: String!
  correlationId: String
  appointmentId: String
  patientId: String
  patientName: String
  patientPhone: String
  messageType: String!
  direction: String!
  status: String!
  evolutionMessageId: String
  errorMessage: String
  sentAt: DateTime
  deliveredAt: DateTime
  readAt: DateTime
  createdAt: DateTime!
}

type WhatsappMessageLogPage {
  items: [WhatsappMessageLog!]!
  total: Int!
}

type Query {
  whatsappMessageLogs(
    tenantId: String!
    patientId: String
    appointmentId: String
    status: String
    messageType: String
    dateFrom: DateTime
    dateTo: DateTime
    page: Int = 1
    limit: Int = 50
  ): WhatsappMessageLogPage!

  whatsappMessageLog(id: ID!): WhatsappMessageLog
}
```

### Mutation per la configurazione

```graphql
input WhatsappConfigInput {
  tenantId: String!
  gatewayUrl: String!
  gatewayApiKey: String!
  isActive: Boolean
}

input WhatsappTemplateInput {
  tenantId: String!
  templateType: String!    # 'RECAP_SINGLE' | 'RECAP_MULTI' | 'REMINDER_24H' | 'CANCELLATION' | 'UPDATE'
  templateText: String!
}

type Mutation {
  saveWhatsappConfig(input: WhatsappConfigInput!): WhatsappTenantConfig!
  saveWhatsappTemplate(input: WhatsappTemplateInput!): WhatsappMessageTemplate!
  testWhatsappConnection(tenantId: String!): Boolean!  # chiama GET {gateway_url}/docs e verifica 200
}
```

---

## Parte 4: Frontend Angular

### 4.1 Pagina Configurazione WhatsApp
**Route:** `/settings/whatsapp` (sezione Impostazioni, solo per ADMIN)

**Componenti (architettura a layer):**

```
whatsapp-settings/
  whatsapp-settings.module.ts
  containers/
    whatsapp-settings-page/           ← smart component
      whatsapp-settings-page.component.ts
  components/
    whatsapp-config-form/             ← dumb component
      Input: config: WhatsappConfig
      Output: save: EventEmitter<WhatsappConfigInput>
    whatsapp-template-editor/         ← dumb component
      Input: templates: WhatsappTemplate[]
      Output: saveTemplate: EventEmitter<WhatsappTemplateInput>
```

**Layout pagina configurazione (Angular Material):**

```
┌─────────────────────────────────────────────────┐
│  Configurazione WhatsApp Gateway                │
├─────────────────────────────────────────────────┤
│  [mat-card] Connessione Gateway                 │
│  ┌─────────────────────────────────────────┐   │
│  │ URL Gateway:     [mat-form-field]       │   │
│  │ API Key:         [mat-form-field] 👁    │   │
│  │ Tenant ID:       [mat-form-field]       │   │
│  │ Stato:           ● Attivo / ○ Inattivo  │   │
│  │                                         │   │
│  │  [Testa Connessione]    [Salva]         │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  [mat-card] Template Messaggi                   │
│  ┌─────────────────────────────────────────┐   │
│  │ [mat-tab-group]                         │   │
│  │  Tab: Recap singolo                     │   │
│  │  Tab: Recap multiplo                    │   │
│  │  Tab: Promemoria 24h                    │   │
│  │                                         │   │
│  │  [mat-form-field textarea] template     │   │
│  │  Variabili disponibili: {name} {date}   │   │
│  │  {time} {appointments}                  │   │
│  │                                         │   │
│  │  [Anteprima]    [Salva Template]        │   │
│  └─────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

### 4.2 Pagina Monitoraggio Messaggi WhatsApp
**Route:** `/whatsapp/monitor` (sezione operativa, per ADMIN e STAFF)

**Componenti:**

```
whatsapp-monitor/
  whatsapp-monitor.module.ts
  containers/
    whatsapp-monitor-page/           ← smart component
  components/
    whatsapp-filter-bar/             ← dumb: filtri ricerca
    whatsapp-message-table/          ← dumb: tabella mat-table
    whatsapp-message-detail/         ← dumb: dialog dettaglio
```

**Layout pagina monitoraggio:**

```
┌─────────────────────────────────────────────────────────┐
│  Monitoraggio Messaggi WhatsApp                         │
├─────────────────────────────────────────────────────────┤
│  [Filtri]                                               │
│  Paziente: [input]  Stato: [select]  Data: [datepicker] │
│  Tipo: [select]                          [Cerca]        │
├─────────────────────────────────────────────────────────┤
│  [mat-table]                                            │
│  │ Data/Ora │ Paziente │ Tipo │ Stato │ Telefono │ … │  │
│  ├──────────┼──────────┼──────┼───────┼──────────┤   │  │
│  │ 06/03 …  │ M.Rossi  │RECAP │  ✅   │+39351... │ 👁 │  │
│  │ 06/03 …  │ L.Gior…  │REM.  │  📬   │+39348... │ 👁 │  │
│  │ 05/03 …  │ A.Verdi  │RECAP │  ❌   │+39335... │ 👁 │  │
│                                                         │
│  Legenda: ✅ Letto  📬 Consegnato  📤 Inviato  ❌ Errore │
│                                                         │
│  [mat-paginator]                                        │
└─────────────────────────────────────────────────────────┘
```

**Dialog dettaglio messaggio:**
- Dati paziente e appuntamento
- Timeline stati (PENDING → SENT → DELIVERED → READ)
- Payload raw evento Evolution (expandibile per debug)
- Pulsante "Ri-invia" (chiama nuovamente dispatch, solo per ADMIN)

---

## Parte 5: Sicurezza

### Cifratura gateway_api_key
La `gateway_api_key` salvata in `whatsapp_tenant_config` **deve essere cifrata a riposo** nel database. Usa lo stesso pattern AES-256-GCM già presente nel gateway o il meccanismo di column encryption già in uso nella main-app.

### Autenticazione webhook in ingresso (HMAC-SHA256)

L'endpoint `POST /api/webhooks/whatsapp` è protetto da firma HMAC per-tenant. Il secret è salvato in OpenBao (`kv/whatsapp/{tenantId}/webhook_secret`) e condiviso tra gateway e main-app.

**Motivazione ISO 27001:** secret per-tenant garantisce blast radius limitato in caso di compromissione (A.9 Least Privilege) e rotazione indipendente per tenant senza downtime (A.10 Crittografia).

**Flusso di verifica:**
1. Leggere `x-tenant-id` dall'header
2. Recuperare il `webhook_secret` del tenant da OpenBao (con cache Redis 1h)
3. Verificare `X-Webhook-Signature` con `timingSafeEqual` — se invalida, rispondere 401
4. Processare l'evento

**Configurazione OpenBao su main-app:** la main-app deve avere policy di lettura su `kv/data/whatsapp/+/webhook_secret` (già predisposta dall'amministratore OpenBao insieme alle altre policy).

### Rate limiting
Non applicare rate limiting sull'endpoint webhook — il gateway già gestisce il proprio throttling.

---

## Parte 6: Checklist implementazione

**Backend:**
- [ ] Creare migration TypeORM per le 4 tabelle
- [ ] Creare entities TypeORM
- [ ] Creare `WhatsappGatewayService` con metodi `dispatchBooking`, `cancelBooking` e `healthCheck`
- [ ] Creare `WhatsappWebhookController` con endpoint `POST /api/webhooks/whatsapp` e verifica firma HMAC
- [ ] Creare `WhatsappLogService` con metodi di query per GraphQL
- [ ] Creare `WhatsappConfigService` con CRUD per configurazione tenant
- [ ] Creare resolvers GraphQL per configurazione e monitoraggio
- [ ] Integrare `WhatsappGatewayService` nel service degli appuntamenti (creazione/modifica/cancellazione)
- [ ] Seed dei template di default

**Frontend:**
- [ ] Pagina configurazione `/settings/whatsapp`
- [ ] Pagina monitoraggio `/whatsapp/monitor`
- [ ] Aggiungere voci di menu nelle sezioni appropriate
- [ ] Guard ruoli per le pagine (ADMIN per configurazione, ADMIN+STAFF per monitoraggio)

---

## Note importanti

1. **Il `tenantId` passato al gateway deve corrispondere esattamente al nome dell'istanza Evolution API** (es. se l'istanza si chiama `bdq`, il `tenantId` deve essere `bdq`). Questo è il campo `tenant_id` in `whatsapp_tenant_config`.

2. **Il numero di telefono** deve essere nel formato internazionale senza `+`: es. `393515847659` (non `+39...`). Verificare il formato prima di inviare.

3. **Fire-and-forget obbligatorio**: le chiamate al gateway non devono mai bloccare le operazioni sugli appuntamenti. Usare sempre `try/catch` e loggare gli errori senza rilanciare.

4. **Il gateway risponde immediatamente** con 201 quando accoda il job — non aspettare la conferma dell'invio effettivo su WhatsApp. Lo stato reale arriva tramite webhook.

5. **CorrelationId**: generarlo nella main-app (UUID v4) e passarlo al gateway. Usarlo per tracciare il ciclo di vita del messaggio nel log.
