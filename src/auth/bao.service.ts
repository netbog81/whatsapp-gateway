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

    this.openbao = new OpenbaoBaseService({
      endpoint,
      agentMode,
      enableProxyHealthCheck: true,
      proxyHealthCheckIntervalMs: 60 * 1000,
    });
    this.logger.log(`OpenBao client inizializzato: ${endpoint} (agent mode: ${agentMode})`);
  }

  /**
   * Recupera un segreto da OpenBao (KV v2) tramite Agent proxy.
   * @param path - es. "whatsapp/bdq/gateway_access"
   * @returns L'oggetto con i dati del segreto, o null se non trovato
   */
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

  /**
   * Scrive un segreto su OpenBao (KV v2) tramite Agent proxy.
   * Sovrascrive l'intero set di campi al path indicato (comportamento KV v2:
   * il write crea una nuova versione con SOLO i campi passati).
   * Richiede capability create/update sulla policy dell'AppRole dell'agent.
   * @param path - es. "whatsapp/bdq/evolution_apikey"
   * @param data - campi del segreto, es. { api_key: "..." }
   */
  async writeSecret(path: string, data: Record<string, any>): Promise<void> {
    try {
      await (this.openbao as any).getClient().write(`kv/data/${path}`, { data });
    } catch (error: any) {
      this.logger.error(`Errore scrittura segreto ${path}: ${error.message}`);
      throw error;
    }
  }
}
