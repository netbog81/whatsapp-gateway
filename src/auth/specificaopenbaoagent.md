# Specifica: Integrazione OpenBao Agent per WhatsApp Gateway Microservice

## Obiettivo
Documentazione operativa per integrare un nuovo microservizio (WhatsApp Gateway) con OpenBao Agent, riutilizzando lo stesso pattern della main app (login-saas).

---

## 1. Architettura

```
                        ┌──────────────────────┐
                        │   OpenBao Server     │
                        │ openbao.curandis.cloud│
                        └──────────┬───────────┘
                                   │
                                   │ HTTPS
                                   │
                        ┌──────────▼───────────┐
                        │   OpenBao Agent      │
                        │  http://127.0.0.1:8200│
                        │  (proxy locale)      │
                        │                      │
                        │  - auto_auth AppRole │
                        │  - token renewal     │
                        │  - request forwarding│
                        └──────────┬───────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    │              │              │
            ┌───────▼──────┐ ┌────▼───────┐ ┌────▼────────┐
            │ login-saas   │ │ whatsapp   │ │ altro svc   │
            │ (main app)   │ │ gateway    │ │ (futuro)    │
            └──────────────┘ └────────────┘ └─────────────┘
```

L'OpenBao Agent gia' in esecuzione sulla macchina puo' servire anche il microservizio WhatsApp Gateway. Tutte le app si connettono allo stesso proxy locale senza bisogno di credenziali proprie.

---

## 2. Prerequisiti

### 2.1 Policy OpenBao
Assicurarsi che l'AppRole dell'Agent abbia le policy necessarie per i path del WhatsApp Gateway. Aggiungere una policy su OpenBao Server:

```hcl
# Policy: whatsapp-gateway
path "database/static-creds/postgres-whatsapp-service-account" {
  capabilities = ["read"]
}

# Se il microservizio ha bisogno di leggere secret aggiuntivi (es. API keys WhatsApp)
path "kv/data/whatsapp-gateway/*" {
  capabilities = ["read"]
}
```

Associare la policy all'AppRole dell'Agent:

```bash
# Aggiungere la policy all'AppRole esistente dell'Agent
openbao write auth/approle/role/agent-role \
  token_policies="main-app-policy,whatsapp-gateway-policy" \
  ...
```

### 2.2 Static Role PostgreSQL
Creare il static role in OpenBao per il service account del WhatsApp Gateway:

```bash
openbao write database/static-roles/postgres-whatsapp-service-account \
  db_name=postgres \
  username="whatsapp_svc" \
  rotation_period=86400
```

### 2.3 Installare la libreria
```bash
npm install @curandis/openbao-core@^1.0.0
```

> **Nota**: La libreria e' nel registry GitLab privato. Configurare `.npmrc`:
> ```
> @curandis:registry=https://gitlab.curandis.cloud/api/v4/packages/npm/
> //gitlab.curandis.cloud/api/v4/packages/npm/:_authToken=${GITLAB_TOKEN}
> ```

---

## 3. Struttura file del microservizio

```
whatsapp-gateway/
├── src/
│   ├── main.ts                              # Bootstrap con OpenBao
│   ├── app.module.ts                        # Module con forRootAsync
│   ├── database/
│   │   └── wa-db-credential-manager.service.ts  # Gestore rotazione credenziali
│   └── ...
├── .env                                     # Configurazione
└── package.json
```

---

## 4. Configurazione (.env)

```env
# === OpenBao Agent ===
OPENBAO_AGENT_MODE=true
OPENBAO_ADDR=http://127.0.0.1:8200

# === Database ===
DB_HOST=localhost
DB_PORT=5432
DB_DATABASE=whatsapp_db

# === Fallback DB credentials (solo development) ===
WA_DB_USERNAME=whatsapp_svc
WA_DB_PASSWORD=changeme

# === Application ===
PORT=3001
NODE_ENV=development
```

---

## 5. Codice di implementazione

### 5.1 main.ts — Bootstrap con OpenBao

```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createOpenbaoService, OpenbaoBaseService } from '@curandis/openbao-core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Carica .env (__dirname a runtime e' dist/src/, risaliamo di 2 livelli)
const envFilePath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envFilePath });

async function bootstrap() {
  const isAgentMode = process.env.OPENBAO_AGENT_MODE === 'true';
  const isDevelopment = process.env.NODE_ENV === 'development';

  console.log(`[Bootstrap] Modalita' OpenBao: ${isAgentMode ? 'Agent proxy' : 'AppRole diretto'}`);

  let openbaoService: OpenbaoBaseService | null = null;
  let waDbCreds: { username: string; password: string };

  try {
    // 1. Crea il servizio OpenBao e recupera le credenziali DB
    const result = await createOpenbaoService({
      config: {
        endpoint: process.env.OPENBAO_ADDR || 'http://127.0.0.1:8200',
        agentMode: isAgentMode,
        // In agent mode questi sono undefined (l'Agent gestisce l'auth)
        // In AppRole mode vengono letti dal .env
        roleId: isAgentMode ? undefined : process.env.CURANDIS_OPENBAO_ROLE_ID,
        secretId: isAgentMode ? undefined : process.env.CURANDIS_OPENBAO_SECRET_ID,
        envFilePath: isAgentMode ? undefined : envFilePath,
      },
      credentialSources: [
        {
          name: 'wa-db',                    // Nome univoco per questo credential source
          staticCredsPath: 'database/static-creds/postgres-whatsapp-service-account',
          rotationEventName: 'credentials.wa-db.rotated',
          credentialRefreshIntervalMs: 6 * 60 * 60 * 1000,  // 6 ore
          fallbackEnvUsername: 'WA_DB_USERNAME',
          fallbackEnvPassword: 'WA_DB_PASSWORD',
        },
      ],
    });

    openbaoService = result.service;
    waDbCreds = result.credentials['wa-db'];
    console.log(`[Bootstrap] Credenziali DB da OpenBao (user: ${waDbCreds.username})`);

  } catch (error) {
    // Fallback: solo in development
    if (isDevelopment) {
      const fbUser = process.env.WA_DB_USERNAME;
      const fbPass = process.env.WA_DB_PASSWORD;
      if (fbUser && fbPass) {
        console.warn('[Bootstrap] OpenBao non disponibile, uso credenziali fallback dal .env');
        waDbCreds = { username: fbUser, password: fbPass };
      } else {
        console.error('[Bootstrap] OpenBao non disponibile e nessuna credenziale fallback');
        throw error;
      }
    } else {
      // In produzione OpenBao e' obbligatorio
      throw error;
    }
  }

  // 2. Se OpenBao non era disponibile, crea un servizio dummy
  if (!openbaoService) {
    openbaoService = new OpenbaoBaseService({
      endpoint: 'http://127.0.0.1:8200',
      agentMode: true,
    });
  }

  // 3. Crea l'app NestJS passando credenziali e servizio OpenBao
  const app = await NestFactory.create(
    AppModule.forRootAsync({
      waDbCredentials: waDbCreds,
      openbaoService,
    }),
  );

  // 4. Collega EventEmitter per ricevere eventi di rotazione credenziali
  const eventEmitter = app.get(EventEmitter2);
  openbaoService.setEventEmitter(eventEmitter);

  // 5. Configurazione app (CORS, validation, ecc.)
  app.enableCors({
    origin: [
      'http://localhost:4200',
      /^https:\/\/.*\.curandis\.cloud$/,
    ],
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({
    whitelist: false,
    forbidNonWhitelisted: false,
    transform: true,
  }));

  const port = process.env.PORT || 3001;
  await app.listen(port, '0.0.0.0');

  console.log(`[WhatsApp Gateway] Avviato su porta ${port}`);
  console.log(`[WhatsApp Gateway] OpenBao: ${isAgentMode ? 'Agent proxy' : 'AppRole'} @ ${process.env.OPENBAO_ADDR}`);
  console.log(`[WhatsApp Gateway] DB user: ${waDbCreds.username}`);
}

bootstrap();
```

### 5.2 app.module.ts — Module con forRootAsync

```typescript
import { Module, DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { OpenbaoBaseModule, OpenbaoBaseService } from '@curandis/openbao-core';
import { WaDbCredentialManager } from './database/wa-db-credential-manager.service';
// import le tue entity qui
// import { Message } from './modules/messages/entities/message.entity';

export interface AppModuleOptions {
  waDbCredentials: { username: string; password: string };
  openbaoService: OpenbaoBaseService;
}

@Module({})
export class AppModule {
  static forRootAsync(options: AppModuleOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // EventEmitter per eventi di rotazione credenziali
        EventEmitterModule.forRoot(),

        // TypeORM configurato con credenziali da OpenBao
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432', 10),
          username: options.waDbCredentials.username,   // Da OpenBao
          password: options.waDbCredentials.password,   // Da OpenBao
          database: process.env.DB_DATABASE || 'whatsapp_db',
          entities: [/* ...le tue entity */],
          synchronize: false,
          migrationsRun: true,
          migrations: [__dirname + '/migrations/*.{ts,js}'],
        }),

        // Registra OpenbaoBaseService nel DI container (Global module)
        OpenbaoBaseModule.forRoot(options.openbaoService),

        // ... altri moduli del microservizio
      ],
      providers: [
        // Gestore rotazione credenziali DB
        WaDbCredentialManager,
        // ... altri provider
      ],
    };
  }
}
```

### 5.3 wa-db-credential-manager.service.ts — Gestore rotazione

```typescript
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DatabaseCredentialManagerBase } from '@curandis/openbao-core';

/**
 * Gestisce la rotazione delle credenziali DB per il WhatsApp Gateway.
 *
 * Quando OpenBao ruota la password del static role, questo servizio:
 * 1. Riceve l'evento 'credentials.wa-db.rotated'
 * 2. Chiude le connessioni DB esistenti
 * 3. Riconnette TypeORM con le nuove credenziali
 * 4. Verifica la connettivita' con SELECT 1
 */
@Injectable()
export class WaDbCredentialManager extends DatabaseCredentialManagerBase {
  constructor(
    @InjectDataSource() waDataSource: DataSource,
    eventEmitter: EventEmitter2,
  ) {
    super(waDataSource, eventEmitter, {
      dataSourceName: 'whatsapp',
      eventName: 'credentials.wa-db.rotated',
    });
  }
}
```

---

## 6. Dipendenze package.json

```json
{
  "dependencies": {
    "@curandis/openbao-core": "^1.0.0",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/typeorm": "^11.0.0",
    "@nestjs/event-emitter": "^3.0.1",
    "dotenv": "^17.3.1",
    "eventemitter2": "^6.4.9",
    "node-vault": "^0.10.9",
    "typeorm": "^0.3.0",
    "pg": "^8.13.0"
  }
}
```

---

## 7. Flusso operativo completo

### 7.1 Avvio del microservizio

```
1. dotenv.config()
   └── Carica .env: OPENBAO_AGENT_MODE=true, OPENBAO_ADDR=http://127.0.0.1:8200

2. createOpenbaoService()
   ├── new OpenbaoBaseService({ endpoint, agentMode: true })
   ├── registerDatabaseCredentialSource('wa-db', 'database/static-creds/postgres-whatsapp-service-account')
   ├── loginWithAppRole()
   │   └── Agent mode: no-op (l'Agent gestisce l'auth)
   └── getDatabaseCredentials('wa-db')
       └── GET http://127.0.0.1:8200/v1/database/static-creds/postgres-whatsapp-service-account
           └── Agent proxy inietta token → OpenBao Server → { username, password }

3. NestFactory.create(AppModule.forRootAsync({ waDbCreds, openbaoService }))
   ├── TypeOrmModule.forRoot({ username, password, ... })
   ├── OpenbaoBaseModule.forRoot(openbaoService)
   └── WaDbCredentialManager registrato come provider

4. openbaoService.setEventEmitter(eventEmitter)
   └── Abilita emissione eventi di rotazione

5. app.listen(3001)
```

### 7.2 Rotazione credenziali (runtime, ogni 6 ore)

```
1. Timer scatta (setInterval ogni 6h)
   └── OpenbaoBaseService.refreshDatabaseCredentials('wa-db')

2. GET /v1/database/static-creds/postgres-whatsapp-service-account
   └── OpenBao restituisce le credenziali correnti

3. Confronto password:
   ├── Uguale: log "no change", nessuna azione
   └── Diversa:
       └── eventEmitter.emit('credentials.wa-db.rotated', { username, password })

4. WaDbCredentialManager riceve l'evento:
   ├── dataSource.options.username = newUsername
   ├── dataSource.options.password = newPassword
   ├── dataSource.destroy()        → chiude pool connessioni
   ├── dataSource.initialize()     → riconnette con nuove credenziali
   └── dataSource.query('SELECT 1') → verifica connettivita'
```

---

## 8. Lettura di secret aggiuntivi (opzionale)

Se il microservizio ha bisogno di leggere altri secret da OpenBao (es. API key di WhatsApp Business), puoi usare direttamente il client:

```typescript
import { Injectable } from '@nestjs/common';
import { OpenbaoBaseService } from '@curandis/openbao-core';

@Injectable()
export class WhatsAppConfigService {
  constructor(private readonly openbao: OpenbaoBaseService) {}

  async getWhatsAppApiKey(): Promise<string> {
    // Legge da KV v2: kv/data/whatsapp-gateway/api-credentials
    const OPENBAO_ADDR = process.env.OPENBAO_ADDR || 'http://127.0.0.1:8200';
    const url = `${OPENBAO_ADDR}/v1/kv/data/whatsapp-gateway/api-credentials`;

    const response = await fetch(url);
    const body = await response.json() as any;

    // KV v2: body.data.data contiene i campi del secret
    return body.data.data.api_key;
  }
}
```

Oppure usando il client `node-vault` interno (piu' strutturato):

```typescript
@Injectable()
export class WhatsAppConfigService {
  constructor(private readonly openbao: OpenbaoBaseService) {}

  async getWhatsAppCredentials(): Promise<{ apiKey: string; phoneNumberId: string }> {
    // Usa il client vault interno (non serve token manuale in Agent mode)
    const result = await (this.openbao as any).getClient().read('kv/data/whatsapp-gateway/api-credentials');

    return {
      apiKey: result.data.data.api_key,
      phoneNumberId: result.data.data.phone_number_id,
    };
  }
}
```

---

## 9. Aggiungere credentialSources multipli

Se il microservizio usa piu' database, aggiungi piu' sorgenti:

```typescript
const result = await createOpenbaoService({
  config: { ... },
  credentialSources: [
    {
      name: 'wa-db',
      staticCredsPath: 'database/static-creds/postgres-whatsapp-service-account',
      rotationEventName: 'credentials.wa-db.rotated',
      credentialRefreshIntervalMs: 6 * 60 * 60 * 1000,
      fallbackEnvUsername: 'WA_DB_USERNAME',
      fallbackEnvPassword: 'WA_DB_PASSWORD',
    },
    {
      name: 'analytics-db',
      staticCredsPath: 'database/static-creds/postgres-analytics-service-account',
      rotationEventName: 'credentials.analytics-db.rotated',
      credentialRefreshIntervalMs: 12 * 60 * 60 * 1000,  // 12 ore
      fallbackEnvUsername: 'ANALYTICS_DB_USERNAME',
      fallbackEnvPassword: 'ANALYTICS_DB_PASSWORD',
    },
  ],
});

// Ogni DB ha le sue credenziali
const waDbCreds = result.credentials['wa-db'];
const analyticsDbCreds = result.credentials['analytics-db'];
```

E un `CredentialManager` dedicato per ogni DataSource.

---

## 10. Checklist di integrazione

- [ ] **OpenBao Server**: creare static role `postgres-whatsapp-service-account`
- [ ] **OpenBao Server**: creare/aggiornare policy per includere il path del static role
- [ ] **OpenBao Server**: associare la policy all'AppRole dell'Agent
- [ ] **Microservizio**: installare `@curandis/openbao-core` dal registry GitLab
- [ ] **Microservizio**: configurare `.env` con `OPENBAO_AGENT_MODE=true`
- [ ] **Microservizio**: implementare `main.ts` con `createOpenbaoService()`
- [ ] **Microservizio**: implementare `AppModule.forRootAsync()` con credenziali dinamiche
- [ ] **Microservizio**: implementare `WaDbCredentialManager` per hot-swap credenziali
- [ ] **Test**: verificare che il microservizio si avvii e legga le credenziali dall'Agent
- [ ] **Test**: verificare il fallback a `.env` in development (con Agent spento)
- [ ] **Test**: verificare la rotazione credenziali (cambiare password manualmente su OpenBao)

---

## 11. Troubleshooting

| Problema | Causa | Soluzione |
|----------|-------|-----------|
| `ECONNREFUSED 127.0.0.1:8200` | Agent non in esecuzione | Avviare l'Agent: `openbao agent -config=agent.hcl` |
| `403 Forbidden` su read | Policy mancante per il path | Aggiungere la policy all'AppRole dell'Agent |
| `404 Not Found` su static-creds | Static role non creato | Creare il static role su OpenBao Server |
| Credenziali vecchie dopo rotazione | `WaDbCredentialManager` non registrato | Verificare che sia nei `providers` di `AppModule` |
| Fallback non funziona | `NODE_ENV` non e' `development` | Impostare `NODE_ENV=development` nel `.env` |
