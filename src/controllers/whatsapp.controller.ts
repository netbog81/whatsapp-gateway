import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { DispatchDto } from '../dto/dispatch.dto';
import { CancelDto } from '../dto/cancel.dto';

@ApiTags('WhatsApp Dispatcher')
@ApiHeader({
  name: 'X-Tenant-ID',
  description: 'Identificativo univoco dello studio medico (Tenant)',
  required: true,
})
@ApiHeader({
  name: 'X-Tenant-API-Key',
  description: 'Chiave segreta per l\'autenticazione del Tenant',
  required: true,
})
@UseGuards(TenantAuthGuard)
@Controller('whatsapp')
export class WhatsappController {
  constructor(private readonly whatsappService: WhatsappService) {}

  @Post('dispatch')
  @ApiOperation({
    summary: 'Invia un messaggio o pianifica un task',
    description: 'Gestisce prenotazioni (con logica recap/reminder) e task interni.',
  })
  @ApiResponse({ status: 201, description: 'Richiesta presa in carico (Queued).' })
  @ApiResponse({ status: 401, description: 'Non autorizzato (API Key mancante o errata).' })
  @ApiResponse({ status: 400, description: 'Payload non valido.' })
  @HttpCode(HttpStatus.CREATED)
  async dispatch(
    @Body() payload: DispatchDto,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string = 'SYSTEM',
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return await this.whatsappService.dispatch(payload, tenantId, userId, ipAddress);
  }

  @Get('health')
  @ApiOperation({
    summary: 'Verifica connettività gateway',
    description: 'Conferma che il gateway è operativo e l\'API key del tenant è valida.',
  })
  @ApiResponse({ status: 200, description: 'Gateway operativo.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  health(@Headers('x-tenant-id') tenantId: string) {
    return { status: 'ok', tenantId, timestamp: new Date().toISOString() };
  }

  @Post('cancel')
  @ApiOperation({
    summary: 'Cancella un appuntamento',
    description: 'Rimuove il reminder programmato e, se richiesto, invia una notifica WhatsApp al paziente.',
  })
  @ApiResponse({ status: 201, description: 'Cancellazione elaborata.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  @ApiResponse({ status: 400, description: 'Payload non valido.' })
  async cancel(
    @Body() dto: CancelDto,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string = 'SYSTEM',
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return await this.whatsappService.cancel(dto, tenantId, userId, ipAddress);
  }

  @Delete('booking/:appointmentId')
  @ApiOperation({
    summary: 'Annulla un reminder programmato',
    description: 'Rimuove dalla coda il messaggio programmato per un appuntamento specifico.',
  })
  @ApiResponse({ status: 200, description: 'Reminder cancellato con successo.' })
  @ApiResponse({ status: 404, description: 'Reminder non trovato o già inviato.' })
  async cancelBooking(
    @Param('appointmentId') appointmentId: string,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string = 'SYSTEM',
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return await this.whatsappService.cancelBooking(appointmentId, tenantId, userId, ipAddress);
  }
}
