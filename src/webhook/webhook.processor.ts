import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as crypto from 'crypto';
import { BaoService } from '../auth/bao.service';
import { AuditService } from '../audit/audit.service';

@Processor('callback-webhook')
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
    private readonly baoService: BaoService,
    private readonly auditService: AuditService,
  ) {
    super();
  }

  private async getTenantWebhookSecret(tenantId: string): Promise<string | null> {
    const cacheKey = `webhook:secret:${tenantId}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const secret = await this.baoService.getSecret(`whatsapp/${tenantId}/webhook_secret`);

    if (secret?.secret) {
      await this.redis.set(cacheKey, secret.secret, 'EX', 3600);
      return secret.secret;
    }

    return null;
  }

  private computeHmac(secret: string, body: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  /**
   * Normalizza lo status Evolution: può arrivare come stringa ("READ") o numero (4, protobuf enum)
   */
  private normalizeStatus(status: any): string | null {
    if (status == null) return null;
    if (typeof status === 'string') return status;
    const numericMap: Record<number, string> = {
      0: 'ERROR',
      1: 'PENDING',
      2: 'SERVER_ACK',
      3: 'DELIVERY_ACK',
      4: 'READ',
      5: 'PLAYED',
    };
    return numericMap[status] ?? String(status);
  }

  /**
   * Mappa gli eventi Evolution agli stati del gateway
   */
  private mapEvolutionStatus(event: any): string {
    const eventType = event?.event;
    // Evolution mette lo status in posizioni diverse a seconda della versione/evento:
    // - messages.update (nested): event.data.update.status
    // - messages.update (flat): event.data.status
    // Lo status può essere stringa ("READ") o numero (4)
    const rawStatus = event?.data?.update?.status ?? event?.data?.status;
    const updateStatus = this.normalizeStatus(rawStatus);

    if (updateStatus === 'READ' || updateStatus === 'PLAYED') return 'READ';
    if (updateStatus === 'DELIVERY_ACK' || updateStatus === 'DELIVERED') return 'DELIVERED';
    if (updateStatus === 'SERVER_ACK') return 'SENT';
    if (updateStatus === 'ERROR' || updateStatus === 'FAILED') return 'FAILED';
    if (eventType === 'messages.upsert') return 'SENT';
    if (eventType === 'send.message') return 'SENT';

    return updateStatus || 'SENT';
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { correlationId, tenantId, event, msg_metadata, gateway_metadata_override } = job.data;
    const webhookUrl = this.configService.get<string>('MAIN_APP_WEBHOOK_URL');
    const startTime = Date.now();

    this.logger.log(`Invio callback webhook per tenant ${tenantId}, attempt ${job.attemptsMade + 1}`);

    // Costruisce gateway_metadata
    let gatewayMetadata: any;

    if (gateway_metadata_override) {
      // Webhook diretto (PENDING, CANCELLED) — metadata già formato dal service
      gatewayMetadata = gateway_metadata_override;
    } else {
      // Webhook da Evolution/RabbitMQ — costruisce da msg_metadata + evento
      gatewayMetadata = {
        message_type: msg_metadata?.message_type ?? null,
        correlation_id: msg_metadata?.correlation_id ?? correlationId,
        tenant_id: tenantId,
        patient_id: msg_metadata?.patient_id ?? null,
        appointment_ids: msg_metadata?.appointment_ids ?? [],
        status: this.mapEvolutionStatus(event),
        timestamp: new Date().toISOString(),
      };
    }

    const enrichedEvent = {
      ...event,
      gateway_metadata: gatewayMetadata,
    };

    const body = JSON.stringify(enrichedEvent);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Tenant-ID': tenantId,
      'X-Correlation-ID': gatewayMetadata.correlation_id || correlationId,
    };

    const webhookSecret = await this.getTenantWebhookSecret(tenantId);
    if (webhookSecret) {
      headers['X-Webhook-Signature'] = this.computeHmac(webhookSecret, body);
    } else {
      this.logger.warn(`Nessun webhook_secret trovato per tenant ${tenantId}: invio senza firma HMAC`);
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post(webhookUrl, enrichedEvent, {
          headers,
          timeout: 10000,
        }),
      );

      await this.auditService.log({
        tenantId,
        correlationId: gatewayMetadata.correlation_id || correlationId,
        eventType: 'WEBHOOK_RETRY',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'WEBHOOK', id: gatewayMetadata.message_type || event?.type || 'EVOLUTION_EVENT' },
        status: 'SUCCESS',
        payload: { statusCode: response.status, gatewayStatus: gatewayMetadata.status },
        metadata: {
          retry_count: job.attemptsMade,
          processing_time_ms: Date.now() - startTime,
        },
      });

      return { status: 'delivered', statusCode: response.status };
    } catch (error: any) {
      const isFinalAttempt = job.attemptsMade + 1 >= job.opts.attempts;

      await this.auditService.log({
        tenantId,
        correlationId: gatewayMetadata.correlation_id || correlationId,
        eventType: 'WEBHOOK_RETRY',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'WEBHOOK', id: gatewayMetadata.message_type || event?.type || 'EVOLUTION_EVENT' },
        status: isFinalAttempt ? 'FAILED' : 'PENDING',
        payload: { errorMessage: error.message },
        metadata: {
          retry_count: job.attemptsMade,
          processing_time_ms: Date.now() - startTime,
        },
      });

      this.logger.warn(`Callback fallito (attempt ${job.attemptsMade + 1}): ${error.message}`);
      throw error; // BullMQ riproverà con backoff esponenziale
    }
  }
}
