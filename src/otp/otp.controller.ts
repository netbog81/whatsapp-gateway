import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { OtpDeliveryService } from './otp-delivery.service';
import { SendOtpDto, SendOtpResult, TestEmailDto } from './dto/send-otp.dto';

@ApiTags('OTP Delivery')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Identificativo del tenant', required: true })
@ApiHeader({ name: 'X-Tenant-API-Key', description: 'Chiave segreta del tenant', required: true })
@UseGuards(TenantAuthGuard)
@Controller('otp')
export class OtpController {
  constructor(private readonly otpDeliveryService: OtpDeliveryService) {}

  @Post('send')
  @ApiOperation({
    summary: 'Consegna un OTP (canale primario + fallback)',
    description:
      'Endpoint interno per il modulo firma FEA. Il testo arriva già renderizzato ' +
      '(include il codice) e non viene mai loggato: il gateway è solo il vettore di consegna. ' +
      'Risponde in modo sincrono con canale/driver effettivamente usati (finiscono nelle evidence della ceremony).',
  })
  @ApiResponse({ status: 200, description: 'OTP consegnato al canale (con eventuale fallback).' })
  @ApiResponse({ status: 502, description: 'Consegna fallita su tutti i canali.' })
  @HttpCode(HttpStatus.OK)
  async send(
    @Body() dto: SendOtpDto,
    @Headers('x-tenant-id') tenantId: string,
    @Req() req: Request,
  ): Promise<SendOtpResult> {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return this.otpDeliveryService.send(tenantId, dto, ipAddress);
  }

  @Get('delivery/:messageId')
  @ApiOperation({
    summary: 'Esito di consegna di un OTP WhatsApp',
    description:
      'null se non risulta ancora consegnato (o se il canale non sa dirlo, come SMS ed email). ' +
      'Non blocca nulla: il codice scade per conto suo.',
  })
  async delivery(
    @Param('messageId') messageId: string,
    @Headers('x-tenant-id') tenantId: string,
  ): Promise<{ status: string; at: string } | null> {
    return this.otpDeliveryService.deliveryStatus(tenantId, messageId);
  }

  @Post('email/test')
  @ApiOperation({
    summary: 'Verifica il canale email del tenant',
    description:
      'Senza `to` controlla solo la raggiungibilità dell\'SMTP risolto (relay comune ' +
      'oppure SMTP proprio del tenant). Con `to` invia un messaggio di prova a quell\'indirizzo. ' +
      'Nessun codice OTP è coinvolto.',
  })
  @HttpCode(HttpStatus.OK)
  async testEmail(
    @Body() dto: TestEmailDto,
    @Headers('x-tenant-id') tenantId: string,
  ): Promise<{ ok: boolean; detail: string; source: string }> {
    return this.otpDeliveryService.testEmail(tenantId, dto.to);
  }
}
