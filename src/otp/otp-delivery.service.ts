import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { BaoService } from '../auth/bao.service';
import { AuditService } from '../audit/audit.service';
import { PersonalGsmDriver } from '../sms/personal-gsm.driver';
import { SkebbyDriver } from '../sms/skebby.driver';
import { SmsDriver, SmsDriverName } from '../sms/sms-driver.interface';
import { SmtpDriver } from '../email/smtp.driver';
import { OtpChannel, SendOtpDto, SendOtpResult } from './dto/send-otp.dto';

/** Intervallo minimo tra messaggi WhatsApp OTP dello stesso tenant (più corto dei recap: il paziente sta aspettando). */
const OTP_WA_MIN_INTERVAL_MS = 2000;

/**
 * Consegna OTP con fallback di canale. Il gateway è "dumb pipe": il codice
 * è generato e verificato SOLO dal chiamante (modulo signature del
 * registry); qui arriva un testo opaco che non viene mai loggato.
 *
 * Priorità canali: dto.channelPriority (passata dal chiamante, fonte:
 * signature_tenant_configs del registry) → KV `sms/<tenant>/otp_config`
 * ({ primary_channel, fallback_channel, sms_driver }) → default
 * whatsapp→sms (ogni tenant oggi ha WhatsApp configurato).
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger(OtpDeliveryService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly baoService: BaoService,
    private readonly auditService: AuditService,
    private readonly personalGsmDriver: PersonalGsmDriver,
    private readonly skebbyDriver: SkebbyDriver,
    private readonly smtpDriver: SmtpDriver,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async send(tenantId: string, dto: SendOtpDto, ipAddress: string): Promise<SendOtpResult> {
    const { channels, smsDriverName } = await this.resolvePlan(tenantId, dto);
    const correlationId = dto.correlationId ?? 'OTP';
    const startTime = Date.now();

    // Canali privi del recapito necessario: saltati senza contare come
    // errore. Con più canali eterogenei è la norma, non un'anomalia.
    const usable = channels.filter((channel) => this.hasRecipient(channel, dto));
    const skipped = channels.filter((channel) => !usable.includes(channel));
    if (skipped.length) {
      this.logger.log(
        `Canali saltati per mancanza di recapito (tenant ${tenantId}): ${skipped.join(', ')}`,
      );
    }
    if (!usable.length) {
      throw new BadGatewayException(
        `Nessun canale utilizzabile: richiesti ${channels.join(', ')} ma mancano i recapiti corrispondenti`,
      );
    }

    let lastError: Error | null = null;
    for (let i = 0; i < usable.length; i++) {
      const channel = usable[i];
      const recipientMasked = this.maskFor(channel, dto);
      try {
        const result = await this.sendVia(channel, tenantId, dto, smsDriverName);
        const outcome: SendOtpResult = { ...result, channel, usedFallback: i > 0, recipientMasked };

        await this.auditService.log({
          tenantId,
          correlationId,
          eventType: i > 0 ? 'OTP_FALLBACK' : 'OTP_DISPATCHED',
          actor: { user_id: 'SYSTEM', ip_address: ipAddress },
          resource: { entity: 'OTP', id: correlationId },
          status: 'SUCCESS',
          payload: { recipient: recipientMasked, channel, driver: outcome.driver },
          metadata: {
            processing_time_ms: Date.now() - startTime,
            channel,
            driver: outcome.driver,
            used_fallback: i > 0,
            skipped_channels: skipped,
          },
        });
        return outcome;
      } catch (error: any) {
        lastError = error;
        this.logger.warn(
          `Consegna OTP fallita su canale ${channel} per tenant ${tenantId}: ${error.message} — ${
            i < usable.length - 1 ? 'provo fallback' : 'nessun altro canale'
          }`,
        );
      }
    }

    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'ERROR',
      actor: { user_id: 'SYSTEM', ip_address: ipAddress },
      resource: { entity: 'OTP', id: correlationId },
      status: 'FAILED',
      payload: { channels: usable, skipped, errorMessage: lastError?.message },
      metadata: { processing_time_ms: Date.now() - startTime },
    });
    throw new BadGatewayException(
      `Consegna OTP fallita su tutti i canali (${usable.join(', ')}): ${lastError?.message}`,
    );
  }

  /**
   * Prova del canale email: senza destinatario verifica solo che l'SMTP
   * risponda, con destinatario manda un messaggio di prova. Non tocca il
   * flusso OTP e non genera codici.
   */
  async testEmail(
    tenantId: string,
    to?: string,
  ): Promise<{ ok: boolean; detail: string; source: string }> {
    this.smtpDriver.invalidate(tenantId);
    const verified = await this.smtpDriver.verify(tenantId);
    if (!verified.ok || !to) return verified;

    try {
      const sent = await this.smtpDriver.send({
        tenantId,
        email: to,
        subject: 'Prova di invio — Curandis',
        message:
          'Messaggio di prova del canale email.\n\n' +
          'Se lo stai leggendo, la configurazione SMTP funziona e i codici di firma ' +
          'potranno essere recapitati a questo indirizzo.',
      });
      return {
        ok: true,
        detail: `Messaggio di prova inviato a ${maskEmail(to)} da ${sent.from}`,
        source: verified.source,
      };
    } catch (error) {
      return {
        ok: false,
        detail: `SMTP raggiungibile ma invio fallito: ${(error as Error).message}`,
        source: verified.source,
      };
    }
  }

  /** Il canale ha il recapito che gli serve? */
  private hasRecipient(channel: OtpChannel, dto: SendOtpDto): boolean {
    return channel === 'email' ? !!dto.email : !!dto.phone;
  }

  private maskFor(channel: OtpChannel, dto: SendOtpDto): string {
    return channel === 'email' ? maskEmail(dto.email ?? '') : maskPhone(dto.phone ?? '');
  }

  private async resolvePlan(
    tenantId: string,
    dto: SendOtpDto,
  ): Promise<{ channels: OtpChannel[]; smsDriverName: SmsDriverName }> {
    let channels = dto.channelPriority;
    let smsDriverName = dto.smsDriver;

    if (!channels || !smsDriverName) {
      const config = await this.baoService.getSecret(`sms/${tenantId}/otp_config`);
      if (!channels) {
        if (config?.primary_channel) {
          channels = [config.primary_channel];
          if (config.fallback_channel && config.fallback_channel !== config.primary_channel) {
            channels.push(config.fallback_channel);
          }
        } else {
          channels = ['whatsapp', 'sms'];
        }
      }
      smsDriverName = smsDriverName ?? config?.sms_driver ?? 'personal_gsm';
    }

    // dedup preservando l'ordine
    return { channels: [...new Set(channels)], smsDriverName };
  }

  private async sendVia(
    channel: OtpChannel,
    tenantId: string,
    dto: SendOtpDto,
    smsDriverName: SmsDriverName,
  ): Promise<Omit<SendOtpResult, 'channel' | 'usedFallback' | 'recipientMasked'>> {
    if (channel === 'sms') {
      const driver = this.smsDriver(smsDriverName);
      const result = await driver.send({ tenantId, phone: dto.phone!, message: dto.message });
      return { driver: driver.name, providerMessageId: result.providerMessageId };
    }
    if (channel === 'email') {
      const result = await this.smtpDriver.send({
        tenantId,
        email: dto.email!,
        subject: dto.subject,
        message: dto.message,
      });
      return { driver: this.smtpDriver.name, providerMessageId: result.providerMessageId };
    }
    return this.sendViaWhatsapp(tenantId, dto);
  }

  private smsDriver(name: SmsDriverName): SmsDriver {
    return name === 'skebby' ? this.skebbyDriver : this.personalGsmDriver;
  }

  private async sendViaWhatsapp(
    tenantId: string,
    dto: SendOtpDto,
  ): Promise<Omit<SendOtpResult, 'channel' | 'usedFallback' | 'recipientMasked'>> {
    const token = await this.getEvolutionToken(tenantId);
    if (!token) {
      throw new Error(`Nessun token Evolution per il tenant ${tenantId}`);
    }

    await this.applyOtpRateLimit(tenantId);

    const evolutionUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const response = await firstValueFrom(
      this.httpService.post(
        `${evolutionUrl}/message/sendText/${tenantId}`,
        { number: dto.phone!, text: dto.message },
        { headers: { apikey: token }, timeout: 15000 },
      ),
    );
    return { driver: 'evolution', providerMessageId: response.data?.key?.id };
  }

  /** Stessa cache token del WhatsappProcessor (chiave condivisa). */
  private async getEvolutionToken(tenantId: string): Promise<string | null> {
    const cacheKey = `evolution:token:${tenantId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const secret = await this.baoService.getSecret(`whatsapp/${tenantId}/evolution_apikey`);
    if (secret?.api_key) {
      await this.redis.set(cacheKey, secret.api_key, 'EX', 3600);
      return secret.api_key;
    }
    return null;
  }

  private async applyOtpRateLimit(tenantId: string): Promise<void> {
    const key = `ratelimit:otp:evolution:${tenantId}`;
    const last = await this.redis.get(key);
    if (last) {
      const elapsed = Date.now() - parseInt(last, 10);
      if (elapsed < OTP_WA_MIN_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, OTP_WA_MIN_INTERVAL_MS - elapsed));
      }
    }
    await this.redis.set(key, Date.now().toString(), 'EX', 60);
  }
}

/** mario.rossi@example.com → m**********i@example.com (mai l'indirizzo intero). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.length <= 2 ? local.slice(0, 1) : `${local[0]}${'*'.repeat(local.length - 2)}${local.slice(-1)}`;
  return `${visible}@${domain}`;
}

/** +393471234567 → +39*******567 (nei log/audit non va mai il numero completo). */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 6)}${phone.slice(-3)}`;
}
