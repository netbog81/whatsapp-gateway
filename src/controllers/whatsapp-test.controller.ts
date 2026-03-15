import {
  Controller,
  Post,
  Body,
  Headers,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiHeader, ApiResponse, ApiExcludeEndpoint } from '@nestjs/swagger';
import { WhatsappTestService } from '../whatsapp/whatsapp-test.service';
import { TenantAuthGuard } from '../auth/tenant-auth.guard';
import { TestMessageDto } from '../dto/test.dto';

@ApiTags('WhatsApp Test')
@Controller('whatsapp/test')
export class WhatsappTestController {
  private readonly logger = new Logger(WhatsappTestController.name);

  constructor(private readonly testService: WhatsappTestService) {}

  @Post('direct')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantAuthGuard)
  @ApiHeader({ name: 'X-Tenant-ID', description: 'ID tenant', required: true })
  @ApiHeader({ name: 'X-Tenant-API-Key', description: 'API key tenant', required: true })
  @ApiOperation({
    summary: 'Test invio diretto',
    description: 'Invia un messaggio WhatsApp immediatamente, bypass coda BullMQ. Risponde con l\'esito da Evolution API.',
  })
  @ApiResponse({ status: 200, description: 'Messaggio inviato o errore dettagliato da Evolution API.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  async testDirect(
    @Body() dto: TestMessageDto,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.testService.testDirect(tenantId, dto.phone, dto.name || 'Test', dto.message);
  }

  @Post('recap')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantAuthGuard)
  @ApiHeader({ name: 'X-Tenant-ID', description: 'ID tenant', required: true })
  @ApiHeader({ name: 'X-Tenant-API-Key', description: 'API key tenant', required: true })
  @ApiOperation({
    summary: 'Test recap + reminder singolo',
    description: 'Simula 1 appuntamento: recap aggregato dopo 60s (delay produzione), reminder simulato dopo 5 minuti.',
  })
  @ApiResponse({ status: 200, description: 'Job schedulati. Risponde con gli ID e i delay previsti.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  async testRecap(
    @Body() dto: TestMessageDto,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.testService.testRecap(tenantId, dto.phone, dto.name || 'Test');
  }

  @Post('full-flow')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TenantAuthGuard)
  @ApiHeader({ name: 'X-Tenant-ID', description: 'ID tenant', required: true })
  @ApiHeader({ name: 'X-Tenant-API-Key', description: 'API key tenant', required: true })
  @ApiOperation({
    summary: 'Test flusso completo (3 appuntamenti)',
    description: 'Simula 3 appuntamenti per lo stesso paziente: recap aggregato dopo 60s, 3 reminder a 5/6/7 minuti.',
  })
  @ApiResponse({ status: 200, description: 'Job schedulati. Risponde con gli ID e i delay previsti.' })
  @ApiResponse({ status: 401, description: 'Non autorizzato.' })
  async testFullFlow(
    @Body() dto: TestMessageDto,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    return this.testService.testFullFlow(tenantId, dto.phone, dto.name || 'Test');
  }

  /**
   * Webhook sink: riceve i callback del gateway e risponde sempre 200.
   * Usare come MAIN_APP_WEBHOOK_URL in sviluppo/staging quando la main-app non è disponibile.
   * Non richiede autenticazione — simula il comportamento dell'endpoint main-app.
   */
  @Post('webhook-sink')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  webhookSink(
    @Body() body: any,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-correlation-id') correlationId: string,
    @Headers('x-webhook-signature') signature: string,
  ) {
    this.logger.log(
      `[WEBHOOK-SINK] tenant=${tenantId} correlationId=${correlationId} ` +
      `event=${body?.event || 'unknown'} signature=${signature ? 'present' : 'missing'}`,
    );
    return { received: true };
  }
}
