# Specifica: Connessione a OpenBao e lettura KV con `@curandis/openbao-core`

## Obiettivo

Questa specifica descrive come utilizzare la libreria `@curandis/openbao-core` per connettersi a un server OpenBao (compatibile Vault) e recuperare segreti dal KV store v2.

---

## 1. Dipendenze

```bash
npm install @curandis/openbao-core
```

> La libreria è pubblicata su un registry GitLab privato. Assicurarsi che `.npmrc` contenga il token di accesso al registry `@curandis`.

Dipendenza transitiva utilizzata internamente: `node-vault`.

---

## 2. Variabili d'ambiente

| Variabile             | Descrizione                                      | Default                      |
|-----------------------|--------------------------------------------------|------------------------------|
| `OPENBAO_ADDR`        | URL dell'endpoint OpenBao (o dell'Agent proxy)   | `http://host-gateway:8200`   |
| `OPENBAO_AGENT_MODE`  | Se `"true"`, usa l'Agent proxy per autenticazione e rinnovo token | `undefined` (false)          |

**Agent Mode** significa che un OpenBao Agent gira sulla macchina host e gestisce autonomamente autenticazione e token renewal. Il client si limita a parlare con l'Agent via HTTP senza gestire credenziali.

---

## 3. Inizializzazione del client

```typescript
import { OpenbaoBaseService } from '@curandis/openbao-core';

// Crea l'istanza passando endpoint e modalità agent
const openbao = new OpenbaoBaseService({
  endpoint: 'http://host-gateway:8200',  // oppure process.env.OPENBAO_ADDR
  agentMode: true,                        // oppure process.env.OPENBAO_AGENT_MODE === 'true'
});
```

### Parametri del costruttore

| Parametro    | Tipo      | Obbligatorio | Descrizione                                         |
|--------------|-----------|--------------|-----------------------------------------------------|
| `endpoint`   | `string`  | Si           | URL del server OpenBao o dell'Agent proxy            |
| `agentMode`  | `boolean` | No           | Abilita la modalità Agent (delega auth all'Agent)    |

---

## 4. Lettura di un segreto KV v2

Per leggere un segreto dal mount KV v2, usa il metodo `getClient().read()`:

```typescript
async function getSecret(path: string): Promise<Record<string, any> | null> {
  try {
    // Il path deve essere prefissato con "kv/data/" per KV v2
    const result = await (openbao as any).getClient().read(`kv/data/${path}`);

    // La struttura di risposta KV v2 è: result.data.data
    return result?.data?.data ?? null;
  } catch (error: any) {
    if (error?.response?.statusCode === 404) {
      // Segreto non trovato
      return null;
    }
    throw error;
  }
}
```

### Struttura del path

Il path passato a `getSecret()` NON deve includere il prefisso `kv/data/`. Questo viene aggiunto internamente.

```
getSecret("whatsapp/mio-tenant/gateway_access")
  → legge da: kv/data/whatsapp/mio-tenant/gateway_access
```

### Struttura della risposta KV v2

La risposta raw di OpenBao per un KV v2 read ha questa struttura:

```json
{
  "data": {
    "data": {
      "api_key": "valore-segreto",
      "altro_campo": "altro-valore"
    },
    "metadata": {
      "created_time": "...",
      "version": 1
    }
  }
}
```

I dati effettivi sono in `result.data.data`.

---

## 5. Nota su `getClient()`

Il metodo `getClient()` di `OpenbaoBaseService` restituisce l'istanza `node-vault` sottostante. Attualmente non è esposto nel tipo pubblico della libreria, quindi è necessario un cast `as any`:

```typescript
(openbao as any).getClient()
```

Il client `node-vault` espone metodi come:
- `.read(path)` — lettura segreto
- `.write(path, data)` — scrittura segreto
- `.list(path)` — elenco chiavi
- `.delete(path)` — cancellazione segreto

---

## 6. Integrazione con NestJS

Esempio completo di un service NestJS:

```typescript
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenbaoBaseService } from '@curandis/openbao-core';

@Injectable()
export class BaoService implements OnModuleInit {
  private readonly logger = new Logger(BaoService.name);
  private openbao: OpenbaoBaseService;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const endpoint = this.configService.get<string>('OPENBAO_ADDR', 'http://host-gateway:8200');
    const agentMode = this.configService.get<string>('OPENBAO_AGENT_MODE') === 'true';

    this.openbao = new OpenbaoBaseService({ endpoint, agentMode });
    this.logger.log(`OpenBao client inizializzato: ${endpoint} (agent mode: ${agentMode})`);
  }

  async getSecret(path: string): Promise<Record<string, any> | null> {
    try {
      const result = await (this.openbao as any).getClient().read(`kv/data/${path}`);
      return result?.data?.data ?? null;
    } catch (error: any) {
      if (error?.response?.statusCode === 404) {
        this.logger.warn(`Segreto non trovato: ${path}`);
        return null;
      }
      this.logger.error(`Errore lettura segreto ${path}: ${error.message}`);
      throw error;
    }
  }
}
```

### Registrazione nel modulo

```typescript
import { Global, Module } from '@nestjs/common';
import { BaoService } from './bao.service';

@Global()
@Module({
  providers: [BaoService],
  exports: [BaoService],
})
export class AuthModule {}
```

Il decoratore `@Global()` rende `BaoService` iniettabile in qualsiasi modulo senza bisogno di importare `AuthModule`.

---

## 7. Esempi di path KV utilizzati

| Path KV                                    | Campi attesi   | Uso                                      |
|--------------------------------------------|----------------|------------------------------------------|
| `whatsapp/{tenantId}/gateway_access`       | `api_key`      | Autenticazione API del gateway            |
| `whatsapp/{tenantId}/webhook_secret`       | `secret`       | Firma HMAC dei webhook                    |
| `whatsapp/{tenantId}/evolution_apikey`     | `api_key`      | Accesso all'API Evolution                 |

---

## 8. Gestione errori

| Codice HTTP | Significato           | Comportamento consigliato           |
|-------------|-----------------------|-------------------------------------|
| 404         | Segreto non trovato   | Restituire `null`, loggare warning  |
| 403         | Permesso negato       | Propagare errore, verificare policy |
| 5xx         | Errore server OpenBao | Propagare errore, retry opzionale   |

---

## 9. Best practice: caching

I segreti non cambiano frequentemente. Si consiglia di cachare i risultati (es. in Redis) con TTL appropriati:

| Tipo segreto     | TTL consigliato |
|------------------|-----------------|
| API key          | 10 minuti       |
| Webhook secret   | 1 ora           |
| Token esterni    | 1 ora           |

---

## 10. Checklist rapida

1. Installare `@curandis/openbao-core` (con accesso al registry privato)
2. Configurare le variabili d'ambiente `OPENBAO_ADDR` e `OPENBAO_AGENT_MODE`
3. Istanziare `new OpenbaoBaseService({ endpoint, agentMode })`
4. Leggere segreti con `(openbao as any).getClient().read('kv/data/<path>')`
5. Estrarre i dati da `result.data.data`
6. Gestire errore 404 come "segreto non trovato"
7. Cachare i risultati con TTL appropriati
