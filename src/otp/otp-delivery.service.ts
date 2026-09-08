import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { AuditService } from '../audit/audit.service';
import { SmsDriverName } from '../sms/sms-driver.interface';
import { SmtpDriver } from '../email/smtp.driver';
import {
  ChannelDeliveryService,
  NoUsableChannelError,
  maskEmail,
  maskPhone,
} from '../delivery/channel-delivery.service';
import { OtpChannel, SendOtpDto, SendOtpResult } from './dto/send-otp.dto';

/** Le funzioni di mascheramento restano esposte da qui: erano nate in questo file. */
export { maskEmail, maskPhone };

/** Intervallo minimo tra messaggi WhatsApp OTP dello stesso tenant (più corto dei recap: il paziente sta aspettando). */
const OTP_WA_MIN_INTERVAL_MS = 2000;

/** Chiavi Redis condivise con il consumer dei webhook. */
export const OTP_TRACK_PREFIX = 'otp_track:';
export const OTP_STATUS_PREFIX = 'otp_status:';
/** Un'ora: molto oltre la finestra di validità di qualunque OTP. */
export const OTP_TRACK_TTL_S = 3600;

/**
 * Consegna OTP con fallback di canale. Il gateway è "dumb pipe": il codice
 * è generato e verificato SOLO dal chiamante (modulo signature del
 * registry); qui arriva un testo opaco che non viene mai loggato.
 *
 * La consegna vera e propria — ordine dei canali, salto di quelli senza
 * recapito, verifica del numero su WhatsApp — sta in
 * `ChannelDeliveryService`, condivisa con i promemoria degli appuntamenti.
 * Qui resta ciò che è dell'OTP e non della consegna: quale piano di canali
 * usare e quali eventi di audit scrivere.
 *
 * Priorità canali: la manda il chiamante a ogni richiesta, leggendola da
 * `signature_tenant_configs` del registry (colonne `otpChannels` e
 * `smsDriver`). È lì che il tenant la modifica, ed è l'unica fonte: in
 * OpenBao non c'è nessuna configurazione di canale, solo le credenziali dei
 * provider.
 */
@Injectable()
export class OtpDeliveryService {
  private readonly logger = new Logger(OtpDeliveryService.name);

  constructor(
    private readonly channelDelivery: ChannelDeliveryService,
    private readonly auditService: AuditService,
    private readonly smtpDriver: SmtpDriver,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async send(tenantId: string, dto: SendOtpDto, ipAddress: string): Promise<SendOtpResult> {
    const { channels, smsDriverName } = this.resolvePlan(dto);
    const correlationId = dto.correlationId ?? 'OTP';
    const startTime = Date.now();

    try {
      const outcome = await this.channelDelivery.deliver({
        tenantId,
        channels,
        phone: dto.phone,
        email: dto.email,
        smsDriver: smsDriverName,
        content: { text: dto.message, subject: dto.subject },
        whatsappMinIntervalMs: OTP_WA_MIN_INTERVAL_MS,
        trackPrefix: OTP_TRACK_PREFIX,
        trackTtlSeconds: OTP_TRACK_TTL_S,
        rateLimitKey: 'otp',
      });

      const result: SendOtpResult = {
        channel: outcome.channel as OtpChannel,
        driver: outcome.driver,
        providerMessageId: outcome.providerMessageId,
        usedFallback: outcome.usedFallback,
        recipientMasked: outcome.recipientMasked,
      };

      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: outcome.usedFallback ? 'OTP_FALLBACK' : 'OTP_DISPATCHED',
        actor: { user_id: 'SYSTEM', ip_address: ipAddress },
        resource: { entity: 'OTP', id: correlationId },
        status: 'SUCCESS',
        payload: {
          recipient: outcome.recipientMasked,
          channel: outcome.channel,
          driver: outcome.driver,
        },
        metadata: {
          processing_time_ms: Date.now() - startTime,
          channel: outcome.channel,
          driver: outcome.driver,
          used_fallback: outcome.usedFallback,
          skipped_channels: outcome.skipped,
        },
      });

      return result;
    } catch (error: any) {
      // Nessun canale utilizzabile non è un guasto di consegna: nessuno ha
      // provato niente, e l'audit di errore direbbe il falso.
      if (error instanceof NoUsableChannelError) {
        throw new BadGatewayException(error.message);
      }

      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'ERROR',
        actor: { user_id: 'SYSTEM', ip_address: ipAddress },
        resource: { entity: 'OTP', id: correlationId },
        status: 'FAILED',
        payload: {
          channels: error.attempted ?? channels,
          skipped: error.skipped ?? [],
          errorMessage: error.lastError?.message ?? error.message,
        },
        metadata: { processing_time_ms: Date.now() - startTime },
      });

      throw new BadGatewayException(
        `Consegna OTP fallita su tutti i canali (${(error.attempted ?? channels).join(', ')}): ${
          error.lastError?.message ?? error.message
        }`,
      );
    }
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

  /**
   * Esito di consegna di un OTP WhatsApp, se il webhook l'ha registrato.
   * Non blocca nessuno: l'operatore lo consulta quando vuole sapere se il
   * codice è arrivato, e il codice scade per conto suo.
   */
  async deliveryStatus(
    tenantId: string,
    providerMessageId: string,
  ): Promise<{ status: string; at: string } | null> {
    const raw = await this.redis
      .get(`${OTP_STATUS_PREFIX}${tenantId}:${providerMessageId}`)
      .catch(() => null);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Piano di canali per questa consegna.
   *
   * Arriva tutto dal chiamante: il registry lo manda a ogni richiesta,
   * leggendolo da `signature_tenant_configs` — che e' la manopola vera, quella
   * che il tenant vede e modifica dalla propria configurazione firme.
   *
   * Qui NON si legge piu' nessuna configurazione da OpenBao. C'era
   * (`sms/<tenant>/otp_config`), ma essendo scavalcata a ogni chiamata non ha
   * mai avuto effetto: una manopola che gira a vuoto costa piu' di quanto
   * valga. I default sotto servono solo a un chiamante che non specifichi
   * nulla, e non sono configurabili apposta: la configurazione ha gia' il suo
   * posto, ed e' il database del registry.
   */
  private resolvePlan(dto: SendOtpDto): {
    channels: OtpChannel[];
    smsDriverName: SmsDriverName;
  } {
    const channels: OtpChannel[] = dto.channelPriority?.length
      ? dto.channelPriority
      : ['whatsapp', 'sms'];

    // dedup preservando l'ordine
    return {
      channels: [...new Set(channels)],
      smsDriverName: dto.smsDriver ?? 'personal_gsm',
    };
  }
}
