import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { Request } from 'express';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { TaskMessageService } from './task-message.service';
import { CreateTaskMessageDto } from './dto/create-task-message.dto';
import { UpdateTaskMessageDto } from './dto/update-task-message.dto';
import { TransitionTaskMessageDto } from './dto/transition-task-message.dto';

@ApiTags('Task Messages')
@ApiHeader({
  name: 'X-Tenant-ID',
  description: 'Identificativo univoco del Tenant',
  required: true,
})
@ApiHeader({
  name: 'X-Tenant-API-Key',
  description: 'Chiave segreta per l\'autenticazione del Tenant',
  required: true,
})
@UseGuards(TenantAuthGuard)
@Controller('task-messages')
export class TaskMessageController {
  constructor(private readonly taskMessageService: TaskMessageService) {}

  // --- Operazioni Mittente (User A) ---

  @Post()
  @ApiOperation({
    summary: 'Crea un nuovo messaggio/task',
    description: 'Crea un messaggio per un destinatario. Se availableFrom è impostato nel futuro, il messaggio sarà SCHEDULED; altrimenti sarà AVAILABLE immediatamente.',
  })
  @ApiResponse({ status: 201, description: 'Messaggio creato.' })
  @ApiResponse({ status: 400, description: 'Payload non valido.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateTaskMessageDto,
    @Headers('x-tenant-id') tenantId: string,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return this.taskMessageService.create(dto, tenantId, ipAddress);
  }

  @Get('sent')
  @ApiOperation({
    summary: 'Lista messaggi inviati',
    description: 'Restituisce tutti i messaggi inviati dal mittente specificato.',
  })
  @ApiQuery({ name: 'senderUserId', required: true, description: 'UUID del mittente' })
  @ApiResponse({ status: 200, description: 'Lista messaggi inviati.' })
  async listSent(
    @Headers('x-tenant-id') tenantId: string,
    @Query('senderUserId') senderUserId: string,
  ) {
    return this.taskMessageService.listSent(tenantId, senderUserId);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Modifica messaggio schedulato',
    description: 'Modifica contenuto e/o data di disponibilità. Solo messaggi SCHEDULED, solo il mittente.',
  })
  @ApiQuery({ name: 'senderUserId', required: true, description: 'UUID del mittente' })
  @ApiResponse({ status: 200, description: 'Messaggio aggiornato.' })
  @ApiResponse({ status: 400, description: 'Messaggio non modificabile.' })
  @ApiResponse({ status: 403, description: 'Non autorizzato (non sei il mittente).' })
  @ApiResponse({ status: 404, description: 'Messaggio non trovato.' })
  async update(
    @Param('id') messageId: string,
    @Body() dto: UpdateTaskMessageDto,
    @Headers('x-tenant-id') tenantId: string,
    @Query('senderUserId') senderUserId: string,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return this.taskMessageService.update(messageId, dto, tenantId, senderUserId, ipAddress);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancella messaggio',
    description: 'Cancella un messaggio SCHEDULED o AVAILABLE. Solo il mittente.',
  })
  @ApiQuery({ name: 'senderUserId', required: true, description: 'UUID del mittente' })
  @ApiResponse({ status: 200, description: 'Messaggio cancellato.' })
  @ApiResponse({ status: 400, description: 'Messaggio non cancellabile.' })
  @ApiResponse({ status: 403, description: 'Non autorizzato (non sei il mittente).' })
  @ApiResponse({ status: 404, description: 'Messaggio non trovato.' })
  async delete(
    @Param('id') messageId: string,
    @Headers('x-tenant-id') tenantId: string,
    @Query('senderUserId') senderUserId: string,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return this.taskMessageService.delete(messageId, tenantId, senderUserId, ipAddress);
  }

  // --- Operazioni Destinatario / Main App (User B) ---

  @Post(':id/read')
  @ApiOperation({
    summary: 'Segna come letto',
    description: 'Chiamato dalla main app quando il destinatario apre il messaggio. Transizione AVAILABLE → READ.',
  })
  @ApiResponse({ status: 200, description: 'Messaggio segnato come letto.' })
  @ApiResponse({ status: 400, description: 'Transizione non valida.' })
  @ApiResponse({ status: 403, description: 'Non autorizzato (non sei il destinatario).' })
  @ApiResponse({ status: 404, description: 'Messaggio non trovato.' })
  @HttpCode(HttpStatus.OK)
  async markAsRead(
    @Param('id') messageId: string,
    @Body() dto: TransitionTaskMessageDto,
    @Headers('x-tenant-id') tenantId: string,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return this.taskMessageService.markAsRead(messageId, tenantId, dto.userId, ipAddress);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'Segna task come completato',
    description: 'Chiamato dalla main app quando il destinatario completa il task. Transizione READ → COMPLETED.',
  })
  @ApiResponse({ status: 200, description: 'Task completato.' })
  @ApiResponse({ status: 400, description: 'Transizione non valida.' })
  @ApiResponse({ status: 403, description: 'Non autorizzato (non sei il destinatario).' })
  @ApiResponse({ status: 404, description: 'Messaggio non trovato.' })
  @HttpCode(HttpStatus.OK)
  async markAsCompleted(
    @Param('id') messageId: string,
    @Body() dto: TransitionTaskMessageDto,
    @Headers('x-tenant-id') tenantId: string,
    @Req() req: Request,
  ) {
    const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || 'unknown';
    return this.taskMessageService.markAsCompleted(messageId, tenantId, dto.userId, ipAddress);
  }

  // --- Query ---

  @Get('notifications/pending')
  @ApiOperation({
    summary: 'Conteggio notifiche non lette',
    description: 'Restituisce il numero di messaggi AVAILABLE per un destinatario.',
  })
  @ApiQuery({ name: 'recipientUserId', required: true, description: 'UUID del destinatario' })
  @ApiResponse({ status: 200, description: 'Conteggio notifiche.' })
  async countPendingNotifications(
    @Headers('x-tenant-id') tenantId: string,
    @Query('recipientUserId') recipientUserId: string,
  ) {
    return this.taskMessageService.countPendingNotifications(tenantId, recipientUserId);
  }

  // --- Health ---

  @Get('health')
  @ApiOperation({
    summary: 'Health check modulo Task Messages',
    description: 'Verifica che il modulo task-messages sia operativo.',
  })
  @ApiResponse({ status: 200, description: 'Modulo operativo.' })
  health(@Headers('x-tenant-id') tenantId: string) {
    return { status: 'ok', module: 'task-messages', tenantId, timestamp: new Date().toISOString() };
  }
}
