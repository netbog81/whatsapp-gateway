import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { BaoService } from '../auth/bao.service';
import { SmsDriver, SmsSendInput, SmsSendResult } from './sms-driver.interface';

/**
 * Driver Skebby (provider SMS commerciale italiano, API REST).
 * Config per-tenant in OpenBao KV `sms/<tenantId>/skebby`:
 *
 *   username, password   credenziali account (obbligatori)
 *   sender               mittente alfanumerico registrato (opzionale)
 *   message_type         "GP" (default, alta qualità) | "TI" | "SI"
 *
 * Env: SKEBBY_API_URL (default https://api.skebby.it/API/v1.0/REST).
 * La session key viene cachata in Redis (4 min) e rinnovata su 401.
 */
@Injectable()
export class SkebbyDriver implements SmsDriver {
  readonly name = 'skebby';
  private readonly logger = new Logger(SkebbyDriver.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly baoService: BaoService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    const secret = await this.baoService.getSecret(`sms/${input.tenantId}/skebby`);
    if (!secret?.username || !secret?.password) {
      throw new Error(`Skebby non configurato per il tenant ${input.tenantId}`);
    }

    try {
      return await this.doSend(input, secret, false);
    } catch (error: any) {
      if (error?.response?.status === 401) {
        // Session key scaduta: invalida cache e riprova una volta
        return this.doSend(input, secret, true);
      }
      throw error;
    }
  }

  private async doSend(
    input: SmsSendInput,
    secret: Record<string, any>,
    forceLogin: boolean,
  ): Promise<SmsSendResult> {
    const baseUrl = this.configService.get<string>('SKEBBY_API_URL', 'https://api.skebby.it/API/v1.0/REST');
    const [userKey, sessionKey] = await this.getSession(input.tenantId, secret, baseUrl, forceLogin);

    const body: Record<string, unknown> = {
      message_type: secret.message_type ?? 'GP',
      message: input.message,
      recipient: [input.phone],
      returnCredits: false,
    };
    if (secret.sender) body.sender = secret.sender;

    const response = await firstValueFrom(
      this.httpService.post(`${baseUrl}/sms`, body, {
        headers: { user_key: userKey, Session_key: sessionKey, 'Content-Type': 'application/json' },
        timeout: 15000,
      }),
    );

    if (response.data?.result !== 'OK') {
      throw new Error(`Skebby: invio fallito (${JSON.stringify(response.data?.result)})`);
    }
    this.logger.log(`SMS inviato via Skebby per tenant ${input.tenantId}`);
    return { providerMessageId: response.data?.order_id };
  }

  private async getSession(
    tenantId: string,
    secret: Record<string, any>,
    baseUrl: string,
    forceLogin: boolean,
  ): Promise<[string, string]> {
    const cacheKey = `sms:skebby:session:${tenantId}`;
    if (!forceLogin) {
      const cached = await this.redis.get(cacheKey);
      if (cached) return cached.split(';') as [string, string];
    }

    const response = await firstValueFrom(
      this.httpService.get(`${baseUrl}/login`, {
        params: { username: secret.username, password: secret.password },
        timeout: 15000,
      }),
    );
    // Risposta: "user_key;session_key"
    const session = String(response.data).trim();
    if (!session.includes(';')) {
      throw new Error('Skebby: login fallito (risposta inattesa)');
    }
    await this.redis.set(cacheKey, session, 'EX', 240);
    return session.split(';') as [string, string];
  }
}
