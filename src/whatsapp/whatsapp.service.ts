import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/encryption.service';

const RECAP_TTL_SECONDS = 300; // 5 minuti di safety-net TTL

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    @InjectQueue('whatsapp-queue') private whatsappQueue: Queue,
    @InjectQueue('callback-webhook') private callbackQueue: Queue,
    @InjectRedis() private readonly redis: Redis,
    private readonly auditService: AuditService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async dispatch(payload: any, tenantId: string, userId: string, ipAddress: string = 'unknown') {
    const correlationId = payload.correlationId || uuidv4();
    const actor = { user_id: userId, ip_address: ipAddress };

    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'REQUEST_RECEIVED',
      actor,
      resource: { entity: 'DISPATCH', id: payload.type },
      status: 'PENDING',
      payload,
    });

    switch (payload.type) {
      case 'APPOINTMENT_BOOKING':
        return this.handleBooking(payload, tenantId, correlationId, actor);
      case 'INTERNAL_TASK':
        return this.handleInternalTask(payload, tenantId, correlationId, actor);
      default:
        this.logger.warn(`Tipo dispatch non gestito: ${payload.type}`);
        throw new Error(`Tipo dispatch non supportato: ${payload.type}`);
    }
  }

  async cancel(payload: any, tenantId: string, userId: string, ipAddress: string = 'unknown') {
    const correlationId = payload.correlationId || uuidv4();
    const actor = { user_id: userId, ip_address: ipAddress };

    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'REQUEST_RECEIVED',
      actor,
      resource: { entity: 'DISPATCH', id: 'APPOINTMENT_CANCEL' },
      status: 'PENDING',
      payload,
    });

    return this.handleCancellation({ data: payload }, tenantId, correlationId, actor);
  }

  async cancelBooking(appointmentId: string, tenantId: string, userId: string, ipAddress: string = 'unknown') {
    const correlationId = uuidv4();
    const actor = { user_id: userId, ip_address: ipAddress };

    const jobId = `reminder:${tenantId}:${appointmentId}`;
    const job = await this.whatsappQueue.getJob(jobId);

    if (job) {
      await job.remove();
      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'REMINDER_CANCELLED',
        actor,
        resource: { entity: 'APPOINTMENT', id: appointmentId },
        status: 'SUCCESS',
        payload: { jobId },
      });
      return { status: 'cancelled' };
    }

    return { status: 'not_found' };
  }

  /**
   * Invia un webhook diretto alla main app (per stati PENDING e CANCELLED
   * che non passano da Evolution/RabbitMQ)
   */
  private async sendDirectWebhook(params: {
    tenantId: string;
    correlationId: string;
    pazienteId: string;
    appointmentIds: string[];
    messageType: string;
    status: string;
  }): Promise<void> {
    await this.callbackQueue.add('send-callback', {
      correlationId: params.correlationId,
      tenantId: params.tenantId,
      event: {},
      gateway_metadata_override: {
        message_type: params.messageType,
        correlation_id: params.correlationId,
        tenant_id: params.tenantId,
        patient_id: params.pazienteId,
        appointment_ids: params.appointmentIds,
        status: params.status,
        timestamp: new Date().toISOString(),
      },
    }, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  private async handleBooking(payload: any, tenantId: string, correlationId: string, actor: { user_id: string; ip_address: string }) {
    const { pazienteId, appointmentId, date, recapMessage, reminderMessage } = payload.data;

    // 1. LOGICA RECAP (Buffer 60s) — dati cifrati con AES-256
    const recapKey = `pending:${tenantId}:${pazienteId}`;
    const encryptedData = this.encryptionService.encrypt(JSON.stringify(payload.data));
    await this.redis.rpush(recapKey, encryptedData);
    await this.redis.expire(recapKey, RECAP_TTL_SECONDS);

    await this.whatsappQueue.add(
      'process-recap',
      { tenantId, pazienteId, phone: payload.data.phone, correlationId, recapMessage },
      {
        delay: 60000,
        jobId: `timer-recap:${tenantId}:${pazienteId}`,
        removeOnComplete: true,
      },
    );

    // 2. LOGICA REMINDER 24H
    const appointmentDt = DateTime.fromISO(date, { zone: 'Europe/Rome' });
    const sendTime = appointmentDt.minus({ hours: 24 });
    const delay = sendTime.diffNow().as('milliseconds');

    if (delay > 0) {
      const timeFormatted = appointmentDt.toFormat('HH:mm');
      const content = reminderMessage ?? `Promemoria: Appuntamento domani alle ${timeFormatted}`;

      await this.whatsappQueue.add(
        'send-reminder',
        {
          tenantId,
          phone: payload.data.phone,
          content,
          correlationId,
          pazienteId,
          originalAppointmentId: appointmentId,
          appointmentIds: [appointmentId],
          message_type: 'reminder',
        },
        {
          delay,
          jobId: `reminder:${tenantId}:${appointmentId}`,
          removeOnComplete: true,
        },
      );

      // Webhook PENDING immediato: conferma alla main app che il reminder è schedulato
      await this.sendDirectWebhook({
        tenantId,
        correlationId,
        pazienteId,
        appointmentIds: [appointmentId],
        messageType: 'reminder',
        status: 'PENDING',
      });

      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'REMINDER_SCHEDULED',
        actor,
        resource: { entity: 'APPOINTMENT', id: appointmentId },
        status: 'SUCCESS',
        payload: { sendTime: sendTime.toISO() },
      });
    }
  }

  private async handleCancellation(payload: any, tenantId: string, correlationId: string, actor: { user_id: string; ip_address: string }) {
    const { appointmentId, phone, name, date, sendCancelNotification, cancelNotificationMessage, pazienteId } = payload.data;
    const jobId = `reminder:${tenantId}:${appointmentId}`;
    const job = await this.whatsappQueue.getJob(jobId);

    let reminderStatus = 'not_found';
    if (job) {
      await job.remove();
      reminderStatus = 'cancelled';
      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'REMINDER_CANCELLED',
        actor,
        resource: { entity: 'APPOINTMENT', id: appointmentId },
        status: 'SUCCESS',
        payload: { jobId },
      });
    }

    // Notifica cancellazione opzionale (default: false)
    if (sendCancelNotification === true) {
      let content = cancelNotificationMessage;
      if (!content) {
        if (date && name) {
          const dt = DateTime.fromISO(date, { zone: 'Europe/Rome' });
          content = `Gentile ${name}, il suo appuntamento del ${dt.toFormat('dd/MM/yyyy')} alle ${dt.toFormat('HH:mm')} è stato cancellato.`;
        } else {
          content = `Il suo appuntamento è stato cancellato.`;
        }
      }

      await this.whatsappQueue.add(
        'send-reminder',
        {
          tenantId,
          phone,
          content,
          correlationId,
          pazienteId,
          originalAppointmentId: appointmentId,
          appointmentIds: [appointmentId],
          message_type: 'cancel_notification',
        },
        { removeOnComplete: true },
      );

      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'CANCEL_NOTIFICATION_QUEUED',
        actor,
        resource: { entity: 'APPOINTMENT', id: appointmentId },
        status: 'SUCCESS',
        payload: { phone },
      });

      return { status: reminderStatus, cancelNotification: 'queued' };
    }

    // Nessuna notifica WhatsApp: invia webhook CANCELLED diretto
    await this.sendDirectWebhook({
      tenantId,
      correlationId,
      pazienteId: pazienteId || 'unknown',
      appointmentIds: [appointmentId],
      messageType: 'cancel_notification',
      status: 'CANCELLED',
    });

    return { status: reminderStatus, cancelNotification: 'disabled' };
  }

  private async handleInternalTask(payload: any, tenantId: string, correlationId: string, actor: { user_id: string; ip_address: string }) {
    const taskId = payload.data?.taskId || uuidv4();

    await this.whatsappQueue.add(
      'process-internal-task',
      { tenantId, correlationId, ...payload.data },
      {
        jobId: `internal-task:${tenantId}:${taskId}`,
        removeOnComplete: true,
      },
    );

    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'INTERNAL_TASK_QUEUED',
      actor,
      resource: { entity: 'INTERNAL_TASK', id: taskId },
      status: 'PENDING',
      payload: { taskId },
    });

    return { status: 'queued', taskId };
  }
}
