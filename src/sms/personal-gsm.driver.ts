import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { BaoService } from '../auth/bao.service';
import { SmsDriver, SmsSendInput, SmsSendResult } from './sms-driver.interface';

/**
 * Driver per il gateway SMS GSM fisico di rete (device personale con API
 * HTTP).
 *
 * La configurazione si cerca in due posti, nell'ordine:
 *
 *   1. `sms/<tenantId>/gsm_gateway`   — il tenant ha un device proprio
 *   2. `sms/saas-relay/gsm_gateway`   — device condiviso di tutta la SaaS
 *
 * Stessa forma del ripiego dell'email (`mail/saas-relay`): un tenant che non
 * ha un proprio apparato manda comunque, senza che qualcuno debba ricordarsi
 * di copiargli la configurazione. Chi ne ha uno resta indipendente.
 *
 * Chiavi del secret:
 *
 *   base_url     es. "http://192.168.1.50:8080"  (obbligatorio)
 *   api_key      token del device (opzionale)
 *   http_method  "POST" (default) | "GET"
 *   path         default "/send"
 *   auth_style   "bearer" (default, header Authorization) | "query" (param apikey)
 *   sender       etichetta del mittente, se il firmware la supporta (opzionale)
 *
 * POST: JSON { to, message }. GET: query ?to=<phone>&text=<msg>.
 * Adattare i campi del secret al firmware del device.
 */
@Injectable()
export class PersonalGsmDriver implements SmsDriver {
  readonly name = 'personal_gsm';
  private readonly logger = new Logger(PersonalGsmDriver.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly baoService: BaoService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const config = await this.getConfig(input.tenantId);
    if (!config?.base_url) {
      throw new Error(
        `Gateway GSM non configurato: né sms/${input.tenantId}/gsm_gateway ` +
          'né il ripiego condiviso sms/saas-relay/gsm_gateway',
      );
    }

    const method = (config.http_method ?? 'POST').toUpperCase();
    const path = config.path ?? '/send';
    const authStyle = config.auth_style ?? 'bearer';
    const url = `${config.base_url.replace(/\/$/, '')}${path}`;

    const headers: Record<string, string> = {};
    const params: Record<string, string> = {};
    if (config.api_key) {
      if (authStyle === 'query') params.apikey = config.api_key;
      else headers.Authorization = `Bearer ${config.api_key}`;
    }

    const response =
      method === 'GET'
        ? await firstValueFrom(
            this.httpService.get(url, {
              headers,
              params: { ...params, to: input.phone, text: input.message },
              timeout: 15000,
            }),
          )
        : await firstValueFrom(
            this.httpService.post(
              url,
              { to: input.phone, message: input.message },
              { headers, params, timeout: 15000 },
            ),
          );

    this.logger.log(
      `SMS inviato via GSM gateway per tenant ${input.tenantId} ` +
        `(apparato ${config.source === 'saas' ? 'condiviso' : 'del tenant'}, HTTP ${response.status})`,
    );
    const id = response.data?.id ?? response.data?.message_id ?? response.data?.messageId;
    return { providerMessageId: id ? String(id) : undefined };
  }

  /**
   * Configurazione del device: prima quella del tenant, poi quella condivisa.
   *
   * Si tiene in cache anche l'esito "condiviso": senza, ogni SMS di un tenant
   * privo di apparato proprio interrogherebbe OpenBao due volte.
   */
  private async getConfig(tenantId: string): Promise<Record<string, any> | null> {
    const cacheKey = `sms:gsm:config:${tenantId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const perTenant = await this.baoService
      .getSecret(`sms/${tenantId}/gsm_gateway`)
      .catch(() => null);

    let resolved: Record<string, any> | null = null;
    if (perTenant?.base_url) {
      resolved = { ...perTenant, source: 'tenant' };
    } else {
      const shared = await this.baoService
        .getSecret('sms/saas-relay/gsm_gateway')
        .catch(() => null);
      if (shared?.base_url) resolved = { ...shared, source: 'saas' };
    }

    if (resolved) {
      await this.redis.set(cacheKey, JSON.stringify(resolved), 'EX', 600);
    }
    return resolved;
  }
}
