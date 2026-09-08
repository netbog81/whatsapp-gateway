import {
  Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post,
  BadGatewayException, BadRequestException, UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { SmtpDriver } from '../email/smtp.driver';
import { SendEmailDto } from '../dto/send-email.dto';

/**
 * Invio di notifiche generiche, oggi solo email.
 *
 * Esiste perché finora l'unico percorso email del gateway era quello degli
 * OTP delle firme: un canale già configurato per tenant (SMTP proprio o relay
 * SaaS) ma raggiungibile solo con un payload da OTP. Qui la stessa consegna è
 * disponibile a chi deve mandare un messaggio qualunque — il primo caso è il
 * link di sottoscrizione dell'agenda a un operatore senza numero di telefono.
 *
 * Il gateway resta un "dumb pipe": riceve testo già pronto e non lo logga.
 */
@ApiTags('Notifiche')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Identificativo del tenant', required: true })
@ApiHeader({ name: 'X-Tenant-API-Key', description: 'Chiave segreta del tenant', required: true })
@UseGuards(TenantAuthGuard)
@Controller('notify')
export class NotifyController {
  private readonly logger = new Logger(NotifyController.name);

  constructor(private readonly smtpDriver: SmtpDriver) {}

  @Post('email')
  @ApiOperation({
    summary: 'Invia una email al destinatario indicato',
    description:
      'Usa la configurazione SMTP del tenant (kv `mail/<tenant>/smtp`) o, in sua assenza, ' +
      'il relay condiviso con mittente del tenant. Il corpo non viene loggato.',
  })
  @ApiResponse({ status: 200, description: 'Email consegnata al server SMTP.' })
  @ApiResponse({ status: 502, description: 'Consegna fallita.' })
  @HttpCode(HttpStatus.OK)
  async sendEmail(
    @Body() dto: SendEmailDto,
    @Headers('x-tenant-id') tenantId: string,
  ): Promise<{ sent: boolean; from: string; providerMessageId?: string }> {
    if (!tenantId) throw new BadRequestException('Header X-Tenant-ID mancante');

    try {
      const result = await this.smtpDriver.send({
        tenantId,
        email: dto.email,
        subject: dto.subject,
        message: dto.message,
      });
      // Si logga il destinatario, mai il contenuto.
      this.logger.log(`[NOTIFY-EMAIL] Inviata a ${dto.email} (tenant=${tenantId})`);
      return { sent: true, from: result.from, providerMessageId: result.providerMessageId };
    } catch (error: any) {
      this.logger.error(`[NOTIFY-EMAIL] Invio fallito a ${dto.email}: ${error?.message}`);
      throw new BadGatewayException(`Invio email fallito: ${error?.message ?? 'errore sconosciuto'}`);
    }
  }
}
