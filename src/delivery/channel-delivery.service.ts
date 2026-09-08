import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { BaoService } from '../auth/bao.service';
import { PersonalGsmDriver } from '../sms/personal-gsm.driver';
import { SkebbyDriver } from '../sms/skebby.driver';
import { SmsDriver, SmsDriverName } from '../sms/sms-driver.interface';
import { SmtpDriver } from '../email/smtp.driver';

/**
 * Consegna un messaggio provando i canali in ordine, fermandosi al primo che
 * riesce.
 *
 * Estratto da `OtpDeliveryService`, che per primo aveva avuto bisogno di
 * questa logica e ne resta un chiamante. Il motivo dell'estrazione e' che i
 * promemoria degli appuntamenti hanno esattamente lo stesso problema — quale
 * canale, con che riserva, saltando quelli senza recapito — e una seconda
 * copia sarebbe divergita proprio sui casi limite che qui costano di piu':
 * il numero non registrato su WhatsApp e il fail-open della verifica.
 *
 * Cosa NON sta qui, perche' e' del chiamante e non della consegna:
 * l'audit (ogni dominio ha i suoi eventi), la scelta del piano di canali, e
 * il significato del messaggio. Qui il testo e' opaco.
 */

export type DeliveryChannel = 'sms' | 'whatsapp' | 'email';

export interface DeliveryContent {
  /** Testo per WhatsApp. Vale anche per SMS ed email se non ne hanno uno proprio. */
  text: string;
  /** Oggetto dell'email. Ignorato dagli altri canali. */
  subject?: string;
  /** Testo dedicato all'SMS, quando serve piu' corto di quello WhatsApp. */
  smsText?: string;
  /** Corpo dedicato all'email, quando puo' essere piu' disteso. */
  emailBody?: string;
  /** Nome visualizzato del mittente: la denominazione dello studio. */
  emailFromName?: string;
}

export interface DeliveryRequest {
  tenantId: string;
  /** Canali in ordine di preferenza. Il primo che riesce vince. */
  channels: DeliveryChannel[];
  phone?: string;
  email?: string;
  smsDriver?: SmsDriverName;
  content: DeliveryContent;
  /** Intervallo minimo fra due invii WhatsApp dello stesso tenant. */
  whatsappMinIntervalMs?: number;
  /**
   * Prefisso Redis con cui marcare il messaggio WhatsApp inviato, cosi' il
   * consumer dei webhook sa di quale flusso registrare la ricevuta.
   */
  trackPrefix?: string;
  trackTtlSeconds?: number;
  /** Chiave del rate limit: flussi diversi non devono rallentarsi a vicenda. */
  rateLimitKey?: string;
}

export interface DeliveryAttempt {
  channel: DeliveryChannel;
  ok: boolean;
  driver?: string;
  errorMessage?: string;
}

export interface DeliveryOutcome {
  channel: DeliveryChannel;
  driver: string;
  providerMessageId?: string;
  /** Vero se il canale che ha consegnato non era il primo della lista. */
  usedFallback: boolean;
  recipientMasked: string;
  /** Canali scartati prima di provarli, con il motivo. */
  skipped: string[];
  attempts: DeliveryAttempt[];
}

/** Nessun canale aveva il recapito che gli serve: non e' un guasto. */
export class NoUsableChannelError extends Error {
  constructor(
    readonly requested: DeliveryChannel[],
    readonly skipped: string[],
  ) {
    super(
      `Nessun canale utilizzabile: richiesti ${requested.join(', ')} ` +
        'ma mancano i recapiti corrispondenti',
    );
    this.name = 'NoUsableChannelError';
  }
}

/** Tutti i canali utilizzabili hanno fallito davvero. */
export class AllChannelsFailedError extends Error {
  constructor(
    readonly attempted: DeliveryChannel[],
    readonly skipped: string[],
    readonly lastError: Error | null,
  ) {
    super(
      `Consegna fallita su tutti i canali (${attempted.join(', ')}): ${lastError?.message}`,
    );
    this.name = 'AllChannelsFailedError';
  }
}

const DEFAULT_WA_MIN_INTERVAL_MS = 2000;

@Injectable()
export class ChannelDeliveryService {
  private readonly logger = new Logger(ChannelDeliveryService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly baoService: BaoService,
    private readonly personalGsmDriver: PersonalGsmDriver,
    private readonly skebbyDriver: SkebbyDriver,
    private readonly smtpDriver: SmtpDriver,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async deliver(request: DeliveryRequest): Promise<DeliveryOutcome> {
    const { usable, skipped } = await this.selectUsable(request);

    if (skipped.length) {
      this.logger.log(
        `Canali saltati per mancanza di recapito (tenant ${request.tenantId}): ${skipped.join(', ')}`,
      );
    }
    if (!usable.length) {
      throw new NoUsableChannelError([...new Set(request.channels)], skipped);
    }

    const attempts: DeliveryAttempt[] = [];
    let lastError: Error | null = null;

    for (let i = 0; i < usable.length; i++) {
      const channel = usable[i];
      try {
        const sent = await this.sendVia(channel, request);
        attempts.push({ channel, ok: true, driver: sent.driver });
        return {
          channel,
          driver: sent.driver,
          providerMessageId: sent.providerMessageId,
          usedFallback: i > 0,
          recipientMasked: this.maskFor(channel, request),
          skipped,
          attempts,
        };
      } catch (error: any) {
        lastError = error;
        attempts.push({ channel, ok: false, errorMessage: error.message });
        this.logger.warn(
          `Consegna fallita su canale ${channel} per tenant ${request.tenantId}: ${error.message} — ${
            i < usable.length - 1 ? 'provo il canale di riserva' : 'nessun altro canale'
          }`,
        );
      }
    }

    throw new AllChannelsFailedError(usable, skipped, lastError);
  }

  /**
   * Quali canali si possono davvero tentare.
   *
   * Un canale senza il proprio recapito viene saltato e NON conta come
   * errore: con piu' canali eterogenei e' la norma, non un'anomalia — chi non
   * ha lasciato l'email non ha un guasto sull'email.
   */
  private async selectUsable(
    request: DeliveryRequest,
  ): Promise<{ usable: DeliveryChannel[]; skipped: string[] }> {
    const usable: DeliveryChannel[] = [];
    const skipped: string[] = [];

    for (const channel of [...new Set(request.channels)]) {
      if (!this.hasRecipient(channel, request)) {
        skipped.push(channel);
        continue;
      }
      // Un numero senza WhatsApp non produce errore da Evolution: il messaggio
      // viene accettato e non arriva a nessuno. Senza questo controllo il
      // destinatario resterebbe senza avviso e nessuno se ne accorgerebbe.
      if (
        channel === 'whatsapp' &&
        (await this.isOnWhatsapp(request.tenantId, request.phone!)) === false
      ) {
        skipped.push('whatsapp (numero non su WhatsApp)');
        continue;
      }
      usable.push(channel);
    }

    return { usable, skipped };
  }

  /** Il canale ha il recapito che gli serve? */
  private hasRecipient(channel: DeliveryChannel, request: DeliveryRequest): boolean {
    return channel === 'email' ? !!request.email : !!request.phone;
  }

  /**
   * Il numero e' registrato su WhatsApp?
   *
   *   true  → registrato
   *   false → NON registrato: il canale va saltato
   *   null  → non determinabile (endpoint assente, errore, risposta
   *           inattesa): si prosegue e si tenta l'invio come prima
   *
   * Il fail-open e' deliberato: una diversa versione di Evolution deve
   * degradare al comportamento precedente, non impedire la consegna.
   * Esito in cache 24h — lo stato WhatsApp di un numero cambia di rado.
   */
  private async isOnWhatsapp(tenantId: string, phone: string): Promise<boolean | null> {
    const digits = phone.replace(/\D/g, '');
    const cacheKey = `wa_registered:${tenantId}:${digits}`;
    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached === '1') return true;
    if (cached === '0') return false;

    try {
      const token = await this.getEvolutionToken(tenantId);
      if (!token) return null;
      const evolutionUrl = this.configService.get<string>('EVOLUTION_API_URL');
      const response = await firstValueFrom(
        this.httpService.post(
          `${evolutionUrl}/chat/whatsappNumbers/${tenantId}`,
          { numbers: [digits] },
          { headers: { apikey: token }, timeout: 8000 },
        ),
      );
      const entry = Array.isArray(response.data) ? response.data[0] : null;
      if (!entry || typeof entry.exists !== 'boolean') {
        this.logger.warn(
          `Verifica numero WhatsApp: risposta inattesa da Evolution per ${tenantId}, procedo comunque`,
        );
        return null;
      }
      await this.redis.set(cacheKey, entry.exists ? '1' : '0', 'EX', 86400).catch(() => undefined);
      return entry.exists;
    } catch (error: any) {
      this.logger.warn(
        `Verifica numero WhatsApp non riuscita per ${tenantId} (${error.message}): procedo comunque`,
      );
      return null;
    }
  }

  private maskFor(channel: DeliveryChannel, request: DeliveryRequest): string {
    return channel === 'email'
      ? maskEmail(request.email ?? '')
      : maskPhone(request.phone ?? '');
  }

  private async sendVia(
    channel: DeliveryChannel,
    request: DeliveryRequest,
  ): Promise<{ driver: string; providerMessageId?: string }> {
    if (channel === 'sms') {
      const driver = this.smsDriverFor(request.smsDriver ?? 'personal_gsm');
      const result = await driver.send({
        tenantId: request.tenantId,
        phone: request.phone!,
        message: request.content.smsText ?? request.content.text,
      });
      return { driver: driver.name, providerMessageId: result.providerMessageId };
    }

    if (channel === 'email') {
      const result = await this.smtpDriver.send({
        tenantId: request.tenantId,
        email: request.email!,
        subject: request.content.subject,
        message: request.content.emailBody ?? request.content.text,
        fromName: request.content.emailFromName,
      });
      return { driver: this.smtpDriver.name, providerMessageId: result.providerMessageId };
    }

    return this.sendViaWhatsapp(request);
  }

  private smsDriverFor(name: SmsDriverName): SmsDriver {
    return name === 'skebby' ? this.skebbyDriver : this.personalGsmDriver;
  }

  private async sendViaWhatsapp(
    request: DeliveryRequest,
  ): Promise<{ driver: string; providerMessageId?: string }> {
    const token = await this.getEvolutionToken(request.tenantId);
    if (!token) {
      throw new Error(`Nessun token Evolution per il tenant ${request.tenantId}`);
    }

    await this.applyRateLimit(request);

    const evolutionUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const response = await firstValueFrom(
      this.httpService.post(
        `${evolutionUrl}/message/sendText/${request.tenantId}`,
        { number: request.phone!, text: request.content.text },
        { headers: { apikey: token }, timeout: 15000 },
      ),
    );

    const providerMessageId = response.data?.key?.id;
    if (providerMessageId && request.trackPrefix) {
      // Marca il messaggio: il consumer dei webhook registrera' l'esito di
      // consegna solo per i flussi che l'hanno chiesto, senza sporcare gli altri.
      await this.redis
        .set(
          `${request.trackPrefix}${request.tenantId}:${providerMessageId}`,
          '1',
          'EX',
          request.trackTtlSeconds ?? 3600,
        )
        .catch(() => undefined);
    }

    return { driver: 'evolution', providerMessageId };
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

  private async applyRateLimit(request: DeliveryRequest): Promise<void> {
    const interval = request.whatsappMinIntervalMs ?? DEFAULT_WA_MIN_INTERVAL_MS;
    const key = `ratelimit:${request.rateLimitKey ?? 'delivery'}:evolution:${request.tenantId}`;
    const last = await this.redis.get(key);
    if (last) {
      const elapsed = Date.now() - parseInt(last, 10);
      if (elapsed < interval) {
        await new Promise((resolve) => setTimeout(resolve, interval - elapsed));
      }
    }
    await this.redis.set(key, Date.now().toString(), 'EX', 60);
  }
}

/** mario.rossi@example.com → m**********i@example.com (mai l'indirizzo intero). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible =
    local.length <= 2
      ? local.slice(0, 1)
      : `${local[0]}${'*'.repeat(local.length - 2)}${local.slice(-1)}`;
  return `${visible}@${domain}`;
}

/** +393471234567 → +39*******567 (nei log/audit non va mai il numero completo). */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 6)}${phone.slice(-3)}`;
}
