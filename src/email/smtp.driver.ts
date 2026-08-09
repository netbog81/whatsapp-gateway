import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { BaoService } from '../auth/bao.service';
import { EmailSendInput, EmailSendResult, SmtpConfig } from './email-driver.interface';

/** TTL della cache di transport e config: allineato a quella dei token. */
const CONFIG_TTL_MS = 10 * 60 * 1000;

/**
 * Consegna email via SMTP.
 *
 * Risoluzione della configurazione, per tenant:
 *  1. `mail/<tenant>/smtp` con `host` → il tenant ha un SMTP proprio e
 *     quello vince su tutto.
 *  2. altrimenti relay unico SaaS da `mail/saas-relay`, usando come
 *     mittente `from`/`from_name` del tenant se li ha indicati (così la
 *     struttura compare col proprio nome senza gestire la posta).
 *
 * In assenza di entrambi si cade sulle env SMTP_* (comodo in sviluppo).
 */
@Injectable()
export class SmtpDriver {
  readonly name = 'smtp';
  private readonly logger = new Logger(SmtpDriver.name);
  private readonly cache = new Map<string, { config: SmtpConfig; transport: Transporter; at: number }>();

  constructor(
    private readonly baoService: BaoService,
    private readonly configService: ConfigService,
  ) {}

  async send(input: EmailSendInput): Promise<EmailSendResult> {
    const { config, transport } = await this.resolve(input.tenantId);
    const from = config.fromName ? `"${config.fromName}" <${config.from}>` : config.from;

    const info = await transport.sendMail({
      from,
      to: input.email,
      subject: input.subject?.trim() || 'Codice di verifica',
      text: input.message,
    });

    return { providerMessageId: info.messageId, from: config.from };
  }

  /** Verifica la raggiungibilità dell'SMTP senza inviare nulla. */
  async verify(tenantId: string): Promise<{ ok: boolean; detail: string; source: SmtpConfig['source'] }> {
    try {
      const { config, transport } = await this.resolve(tenantId);
      await transport.verify();
      return {
        ok: true,
        detail: `SMTP raggiungibile su ${config.host}:${config.port}, mittente ${config.from}`,
        source: config.source,
      };
    } catch (error) {
      const message = (error as Error).message;
      return { ok: false, detail: `SMTP non raggiungibile: ${message}`, source: 'saas' };
    }
  }

  /** Invalida la cache: da chiamare dopo un cambio di credenziali. */
  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  private async resolve(tenantId: string): Promise<{ config: SmtpConfig; transport: Transporter }> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.at < CONFIG_TTL_MS) {
      return { config: cached.config, transport: cached.transport };
    }

    const config = await this.resolveConfig(tenantId);
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.user ? { auth: { user: config.user, pass: config.password ?? '' } } : {}),
    });

    this.cache.set(tenantId, { config, transport, at: Date.now() });
    this.logger.log(
      `SMTP risolto per ${tenantId}: ${config.host}:${config.port} (${config.source}), mittente ${config.from}`,
    );
    return { config, transport };
  }

  private async resolveConfig(tenantId: string): Promise<SmtpConfig> {
    const perTenant = await this.baoService.getSecret(`mail/${tenantId}/smtp`).catch(() => null);

    if (perTenant?.host) {
      return {
        host: perTenant.host,
        port: toPort(perTenant.port, 587),
        secure: toBool(perTenant.secure, toPort(perTenant.port, 587) === 465),
        user: perTenant.user,
        password: perTenant.password,
        from: perTenant.from || perTenant.user,
        fromName: perTenant.from_name,
        source: 'tenant',
      };
    }

    const shared = await this.baoService.getSecret('mail/saas-relay').catch(() => null);
    const host = shared?.host || this.configService.get<string>('SMTP_HOST');
    if (!host) {
      throw new Error(
        `Nessun SMTP configurato: né mail/${tenantId}/smtp né il relay mail/saas-relay (o env SMTP_HOST)`,
      );
    }

    const port = toPort(shared?.port ?? this.configService.get<string>('SMTP_PORT'), 587);
    // Il mittente resta quello del relay, ma il NOME visualizzato può
    // essere della struttura: il tenant lo imposta senza gestire la posta.
    const from = shared?.from || this.configService.get<string>('SMTP_FROM') || '';
    if (!from) {
      throw new Error('Relay SMTP senza mittente: valorizzare `from` in mail/saas-relay o SMTP_FROM');
    }

    return {
      host,
      port,
      secure: toBool(shared?.secure ?? this.configService.get<string>('SMTP_SECURE'), port === 465),
      user: shared?.user || this.configService.get<string>('SMTP_USER'),
      password: shared?.password || this.configService.get<string>('SMTP_PASSWORD'),
      from,
      fromName: perTenant?.from_name || shared?.from_name,
      source: 'saas',
    };
  }
}

function toPort(value: unknown, fallback: number): number {
  const parsed = parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}
