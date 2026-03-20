import {
  Controller,
  Post,
  Get,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiResponse } from '@nestjs/swagger';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { TaskMessageService } from './task-message.service';

const TEST_SENDER = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const TEST_RECIPIENT = 'f1e2d3c4-b5a6-4f7e-8d9c-0a1b2c3d4e5f';

@ApiTags('Task Messages Test')
@Controller('task-messages/test')
export class TaskMessageTestController {
  private readonly logger = new Logger(TaskMessageTestController.name);

  constructor(private readonly taskMessageService: TaskMessageService) {}

  @Post('immediate')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantAuthGuard)
  @ApiHeader({ name: 'X-Tenant-ID', description: 'ID tenant', required: true })
  @ApiHeader({ name: 'X-Tenant-API-Key', description: 'API key tenant', required: true })
  @ApiOperation({
    summary: 'Test: crea messaggio disponibile subito',
    description: 'Crea un messaggio di test con status AVAILABLE (senza availableFrom). Genera webhook task_message.created.',
  })
  @ApiResponse({ status: 201, description: 'Messaggio creato con status AVAILABLE.' })
  async testImmediate(@Headers('x-tenant-id') tenantId: string) {
    const result = await this.taskMessageService.create(
      {
        senderUserId: TEST_SENDER,
        recipientUserId: TEST_RECIPIENT,
        content: `[TEST] Messaggio immediato - ${new Date().toLocaleString('it-IT')}`,
      },
      tenantId,
      'test-endpoint',
    );

    this.logger.log(`[TEST] Messaggio immediato creato: ${result.messageId} status=${result.status}`);
    return {
      mode: 'immediate',
      ...result,
      senderUserId: TEST_SENDER,
      recipientUserId: TEST_RECIPIENT,
    };
  }

  @Post('scheduled')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(TenantAuthGuard)
  @ApiHeader({ name: 'X-Tenant-ID', description: 'ID tenant', required: true })
  @ApiHeader({ name: 'X-Tenant-API-Key', description: 'API key tenant', required: true })
  @ApiOperation({
    summary: 'Test: crea messaggio schedulato (2 minuti)',
    description: 'Crea un messaggio SCHEDULED che diventerà AVAILABLE dopo 2 minuti. Verifica il BullMQ delayed job.',
  })
  @ApiResponse({ status: 201, description: 'Messaggio schedulato. Diventerà AVAILABLE dopo 2 minuti.' })
  async testScheduled(@Headers('x-tenant-id') tenantId: string) {
    const availableFrom = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // +2 minuti

    const result = await this.taskMessageService.create(
      {
        senderUserId: TEST_SENDER,
        recipientUserId: TEST_RECIPIENT,
        content: `[TEST] Messaggio schedulato - disponibile tra 2 minuti`,
        availableFrom,
      },
      tenantId,
      'test-endpoint',
    );

    this.logger.log(`[TEST] Messaggio schedulato creato: ${result.messageId} availableFrom=${availableFrom}`);
    return {
      mode: 'scheduled',
      ...result,
      senderUserId: TEST_SENDER,
      recipientUserId: TEST_RECIPIENT,
      availableFrom,
      activatesIn: '~2 minuti',
    };
  }

  @Post('full-cycle/:messageId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantAuthGuard)
  @ApiHeader({ name: 'X-Tenant-ID', description: 'ID tenant', required: true })
  @ApiHeader({ name: 'X-Tenant-API-Key', description: 'API key tenant', required: true })
  @ApiOperation({
    summary: 'Test: ciclo completo read → complete',
    description: 'Prende un messageId AVAILABLE e lo porta attraverso READ → COMPLETED. Simula il flusso utente B.',
  })
  @ApiResponse({ status: 200, description: 'Ciclo read → complete eseguito.' })
  async testFullCycle(
    @Param('messageId') messageId: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    // Step 1: Mark as read
    const readResult = await this.taskMessageService.markAsRead(
      messageId,
      tenantId,
      TEST_RECIPIENT,
      'test-endpoint',
    );
    this.logger.log(`[TEST] Messaggio ${messageId} → READ`);

    // Step 2: Mark as completed
    const completeResult = await this.taskMessageService.markAsCompleted(
      messageId,
      tenantId,
      TEST_RECIPIENT,
      'test-endpoint',
    );
    this.logger.log(`[TEST] Messaggio ${messageId} → COMPLETED`);

    return {
      mode: 'full-cycle',
      messageId,
      steps: [
        { action: 'read', result: readResult },
        { action: 'complete', result: completeResult },
      ],
    };
  }

  @Get('list')
  @UseGuards(TenantAuthGuard)
  @ApiHeader({ name: 'X-Tenant-ID', description: 'ID tenant', required: true })
  @ApiHeader({ name: 'X-Tenant-API-Key', description: 'API key tenant', required: true })
  @ApiOperation({
    summary: 'Test: lista messaggi inviati dal test sender',
    description: 'Mostra tutti i messaggi di test creati dal sender di test.',
  })
  @ApiResponse({ status: 200, description: 'Lista messaggi di test.' })
  async testList(@Headers('x-tenant-id') tenantId: string) {
    const messages = await this.taskMessageService.listSent(tenantId, TEST_SENDER);
    return {
      count: messages.length,
      testSenderId: TEST_SENDER,
      testRecipientId: TEST_RECIPIENT,
      messages,
    };
  }
}
