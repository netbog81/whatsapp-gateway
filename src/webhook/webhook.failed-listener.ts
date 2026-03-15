import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, QueueEvents } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';

/**
 * Intercetta i job callback-webhook che hanno esaurito tutti i tentativi.
 * Logga un audit ERROR e scrive un warning visibile per la segreteria/operatori.
 *
 * In produzione questo è il punto in cui integrare:
 * - Email/Slack alert
 * - Dashboard notifica per la segreteria
 * - Pub su una coda "dead-letter" separata
 */
@Injectable()
export class WebhookFailedListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('WebhookFailedListener');
  private queueEvents: QueueEvents;

  constructor(
    @InjectQueue('callback-webhook') private readonly callbackQueue: Queue,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit() {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.queueEvents = new QueueEvents('callback-webhook', { connection: { url: redisUrl } });

    this.queueEvents.on('failed', async ({ jobId, failedReason }) => {
      const job = await this.callbackQueue.getJob(jobId);

      if (!job) return;

      const maxAttempts = job.opts?.attempts ?? 15;
      const isFinalFailure = job.attemptsMade >= maxAttempts;

      if (!isFinalFailure) return; // non è l'ultimo tentativo, BullMQ riproverà

      this.logger.error(
        `[ALERT] Job callback-webhook ${jobId} fallito definitivamente dopo ${job.attemptsMade} tentativi. ` +
        `Motivo: ${failedReason}. ` +
        `Tenant: ${job.data?.tenantId}. Evento: ${job.data?.event?.event || 'sconosciuto'}. ` +
        `Il job rimane in stato "failed" nel BullBoard per intervento manuale.`,
      );

      await this.auditService.log({
        tenantId: job.data?.tenantId || 'UNKNOWN',
        correlationId: job.data?.correlationId || jobId,
        eventType: 'ERROR',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'WEBHOOK', id: job.data?.event?.event || 'EVOLUTION_EVENT' },
        status: 'FAILED',
        payload: { jobId, failedReason },
        metadata: {
          retry_count: job.attemptsMade,
          evolution_message_id: job.data?.event?.key?.id,
        },
      });
    });

    this.logger.log('WebhookFailedListener attivo — monitoraggio job falliti abilitato');
  }

  async onModuleDestroy() {
    await this.queueEvents?.close();
  }
}
