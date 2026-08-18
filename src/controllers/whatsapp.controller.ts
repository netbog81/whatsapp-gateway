import {
  BadGatewayException,
  NotFoundException,
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
import { UpdateEvolutionKeyDto } from '../dto/update-evolution-key.dto';
import { ChatSendDto } from '../dto/chat-send.dto';
import { ChatReadStateDto } from '../dto/chat-read-state.dto';

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

  @Post('chat/send')
  @ApiOperation({
    summary: 'Invia un messaggio di testo libero (chat)',
    description:
      'Conversazione manuale con il paziente: nessuna logica di appuntamento, il testo parte così com\'è. ' +
      'L\'invio resta accodato e soggetto al rate limit per tenant, più corto di quello dei messaggi automatici.',
  })
  @ApiResponse({ status: 201, description: 'Messaggio accodato.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  @ApiResponse({ status: 400, description: 'Payload non valido.' })
  @HttpCode(HttpStatus.CREATED)
  async chatSend(
    @Body() dto: ChatSendDto,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string = 'SYSTEM',
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return await this.whatsappService.sendChatMessage(dto, tenantId, userId, ipAddress);
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

  @Post('config/evolution-key')
  @ApiOperation({
    summary: 'Ruota la API key Evolution del tenant',
    description:
      'Scrive la nuova chiave in OpenBao (kv/whatsapp/{tenant}/evolution_apikey) e invalida la cache Redis. ' +
      'Da usare quando si rigenera l\'istanza Evolution.',
  })
  @ApiResponse({ status: 200, description: 'Chiave aggiornata e cache invalidata.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  @ApiResponse({ status: 400, description: 'Chiave non valida.' })
  @ApiResponse({ status: 502, description: 'Scrittura su OpenBao fallita (verificare policy AppRole).' })
  @HttpCode(HttpStatus.OK)
  async updateEvolutionKey(
    @Body() dto: UpdateEvolutionKeyDto,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string = 'SYSTEM',
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    try {
      return await this.whatsappService.updateEvolutionApiKey(dto.apiKey.trim(), tenantId, userId, ipAddress);
    } catch (error: any) {
      throw new BadGatewayException(
        `Scrittura chiave Evolution su OpenBao fallita: ${error?.message ?? 'errore sconosciuto'}`,
      );
    }
  }

  @Get('scheduled')
  @ApiOperation({
    summary: 'Elenca i messaggi programmati non ancora inviati',
    description:
      'Reminder 24h, notifiche di spostamento/cancellazione in attesa e recap ancora dentro la finestra ' +
      'di raggruppamento. Filtrati per tenant.',
  })
  @ApiResponse({ status: 200, description: 'Elenco dei messaggi in coda.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  async listScheduled(@Headers('x-tenant-id') tenantId: string) {
    return await this.whatsappService.listScheduled(tenantId);
  }

  @Get('chats/unread')
  @ApiOperation({
    summary: 'Non letti per numero secondo WhatsApp',
    description:
      'Mappa numero → messaggi non letti, letta da Evolution. Serve alla main-app per allineare le ' +
      'conversazioni quando la segreteria le apre da WhatsApp Web: in quel caso il contatore si azzera su ' +
      "WhatsApp ma nessun evento lo comunica. Include solo i numeri veri: gruppi e identificativi " +
      'mascherati non hanno una conversazione corrispondente.',
  })
  @ApiResponse({ status: 200, description: 'Mappa numero → non letti.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  async getUnreadCounts(@Headers('x-tenant-id') tenantId: string) {
    try {
      return await this.whatsappService.getUnreadCounts(tenantId);
    } catch (error: any) {
      throw new BadGatewayException(
        `Lettura dei non letti da Evolution fallita: ${error?.message ?? 'errore sconosciuto'}`,
      );
    }
  }

  @Post('chats/read-state')
  @ApiOperation({
    summary: 'Stato di lettura delle conversazioni secondo WhatsApp',
    description:
      'Per ogni numero indica se la conversazione risulta letta. Copre il caso che il contatore da solo ' +
      'non copre — messaggio letto dalla segreteria su WhatsApp Web senza rispondere — perché guarda anche ' +
      "lo storico di stato dei messaggi in arrivo. Torna 'unknown' quando WhatsApp non sa dire: in quel " +
      'caso la main-app non deve toccare nulla.',
  })
  @ApiResponse({ status: 200, description: "Mappa numero → 'read' | 'unread' | 'unknown'." })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  @HttpCode(HttpStatus.OK)
  async getChatReadStates(
    @Body() dto: ChatReadStateDto,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    try {
      return await this.whatsappService.getChatReadStates(tenantId, dto.items ?? []);
    } catch (error: any) {
      throw new BadGatewayException(
        `Lettura dello stato conversazioni da Evolution fallita: ${error?.message ?? 'errore sconosciuto'}`,
      );
    }
  }

  @Delete('scheduled/:jobId')
  @ApiOperation({
    summary: 'Annulla un singolo invio programmato',
    description:
      'Rimuove dalla coda il messaggio indicato. Per i recap svuota anche il buffer degli appuntamenti ' +
      'accumulati. Restituisce 404 se il job non esiste o non appartiene al tenant.',
  })
  @ApiResponse({ status: 200, description: 'Invio annullato.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  @ApiResponse({ status: 404, description: 'Messaggio programmato non trovato.' })
  @HttpCode(HttpStatus.OK)
  async cancelScheduled(
    @Param('jobId') jobId: string,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-user-id') userId: string = 'SYSTEM',
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    const result = await this.whatsappService.cancelScheduled(jobId, tenantId, userId, ipAddress);
    if (result.status === 'not_found') {
      throw new NotFoundException('Messaggio programmato non trovato');
    }
    return result;
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
