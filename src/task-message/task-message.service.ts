import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/encryption.service';
import { TaskMessageStatus } from './enums/task-message-status.enum';
import { CreateTaskMessageDto } from './dto/create-task-message.dto';
import { UpdateTaskMessageDto } from './dto/update-task-message.dto';

/** Chiave Redis per metadata messaggio task */
const taskMetaKey = (tenantId: string, messageId: string) =>
  `task_meta:${tenantId}:${messageId}`;

/** Chiave Redis per indice inbox destinatario */
const inboxIndexKey = (tenantId: string, userId: string) =>
  `task_inbox:${tenantId}:${userId}`;

/** Chiave Redis per indice inbox di gruppo (es. "secretary") */
const groupInboxIndexKey = (tenantId: string, group: string) =>
  `task_inbox:${tenantId}:group:${group}`;

/** Chiave Redis per indice sent mittente */
const sentIndexKey = (tenantId: string, userId: string) =>
  `task_sent:${tenantId}:${userId}`;

/** TTL 24h dopo transizione terminale (COMPLETED/DELETED) */
const TERMINAL_TTL_SECONDS = 86400;

interface TaskMessageMeta {
  message_id: string;
  tenant_id: string;
  sender_user_id: string;
  recipient_user_id: string | null;
  recipient_group: string | null;
  content_encrypted: string;
  status: TaskMessageStatus;
  available_from: string | null;
  bullmq_job_id: string | null;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  completed_at: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

@Injectable()
export class TaskMessageService {
  private readonly logger = new Logger(TaskMessageService.name);

  constructor(
    @InjectQueue('task-message-queue') private taskQueue: Queue,
    @InjectQueue('callback-webhook') private callbackQueue: Queue,
    @InjectRedis() private readonly redis: Redis,
    private readonly auditService: AuditService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Crea un nuovo messaggio/task
   */
  async create(
    dto: CreateTaskMessageDto,
    tenantId: string,
    ipAddress: string,
  ): Promise<{ messageId: string; status: TaskMessageStatus }> {
    // Esattamente uno tra destinatario singolo e gruppo
    if (!dto.recipientUserId === !dto.recipientGroup) {
      throw new BadRequestException(
        'Specificare esattamente uno tra recipientUserId e recipientGroup',
      );
    }

    const messageId = uuidv4();
    const correlationId = dto.correlationId || uuidv4();
    const now = new Date().toISOString();

    // Determina se il messaggio è immediatamente disponibile o schedulato
    const availableFrom = dto.availableFrom ? new Date(dto.availableFrom) : null;
    const isScheduled = availableFrom && availableFrom.getTime() > Date.now();
    const status = isScheduled ? TaskMessageStatus.SCHEDULED : TaskMessageStatus.AVAILABLE;

    // Cifra il contenuto
    const contentEncrypted = this.encryptionService.encrypt(dto.content);

    let bullmqJobId: string | null = null;

    // Se schedulato, crea job BullMQ delayed
    if (isScheduled) {
      const delay = availableFrom.getTime() - Date.now();
      bullmqJobId = `scheduled-msg:${tenantId}:${messageId}`;

      await this.taskQueue.add(
        'activate-scheduled-message',
        { messageId, tenantId },
        {
          delay,
          jobId: bullmqJobId,
          removeOnComplete: true,
        },
      );
    }

    // Salva metadata in Redis
    const meta: TaskMessageMeta = {
      message_id: messageId,
      tenant_id: tenantId,
      sender_user_id: dto.senderUserId,
      recipient_user_id: dto.recipientUserId || null,
      recipient_group: dto.recipientGroup || null,
      content_encrypted: contentEncrypted,
      status,
      available_from: dto.availableFrom || null,
      bullmq_job_id: bullmqJobId,
      created_at: now,
      updated_at: now,
      read_at: null,
      completed_at: null,
      deleted_at: null,
      deleted_by: null,
    };

    await this.redis.set(taskMetaKey(tenantId, messageId), JSON.stringify(meta));

    // Aggiungi agli indici
    await this.redis.sadd(sentIndexKey(tenantId, dto.senderUserId), messageId);
    if (status === TaskMessageStatus.AVAILABLE) {
      await this.redis.sadd(this.inboxKeyFor(tenantId, meta), messageId);
    }

    // Audit
    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'TASK_MESSAGE_CREATED',
      actor: { user_id: dto.senderUserId, ip_address: ipAddress },
      resource: { entity: 'TASK_MESSAGE', id: messageId },
      status: 'SUCCESS',
      payload: {
        recipientUserId: dto.recipientUserId || null,
        recipientGroup: dto.recipientGroup || null,
        status,
        availableFrom: dto.availableFrom,
      },
    });

    // Webhook alla main app
    await this.sendWebhook({
      event: 'task_message.created',
      tenantId,
      correlationId,
      messageId,
      senderUserId: dto.senderUserId,
      recipientUserId: dto.recipientUserId || null,
      recipientGroup: dto.recipientGroup || null,
      content: dto.content,
      status,
      availableFrom: dto.availableFrom || null,
      createdAt: now,
    });

    return { messageId, status };
  }

  /**
   * Modifica un messaggio schedulato (solo se SCHEDULED e solo il mittente)
   */
  async update(
    messageId: string,
    dto: UpdateTaskMessageDto,
    tenantId: string,
    senderUserId: string,
    ipAddress: string,
  ): Promise<{ status: string }> {
    const meta = await this.getMeta(tenantId, messageId);

    if (meta.sender_user_id !== senderUserId) {
      throw new ForbiddenException('Solo il mittente può modificare il messaggio');
    }
    if (meta.status !== TaskMessageStatus.SCHEDULED) {
      throw new BadRequestException('Solo i messaggi SCHEDULED possono essere modificati');
    }

    const correlationId = uuidv4();

    // Aggiorna contenuto se presente
    if (dto.content) {
      meta.content_encrypted = this.encryptionService.encrypt(dto.content);
    }

    // Aggiorna data se presente
    if (dto.availableFrom) {
      const newAvailableFrom = new Date(dto.availableFrom);
      if (newAvailableFrom.getTime() <= Date.now()) {
        throw new BadRequestException('La data di disponibilità deve essere nel futuro');
      }

      meta.available_from = dto.availableFrom;

      // Rimuovi vecchio job e crea nuovo
      if (meta.bullmq_job_id) {
        const oldJob = await this.taskQueue.getJob(meta.bullmq_job_id);
        if (oldJob) await oldJob.remove();
      }

      const delay = newAvailableFrom.getTime() - Date.now();
      const newJobId = `scheduled-msg:${tenantId}:${messageId}`;

      await this.taskQueue.add(
        'activate-scheduled-message',
        { messageId, tenantId },
        {
          delay,
          jobId: newJobId,
          removeOnComplete: true,
        },
      );

      meta.bullmq_job_id = newJobId;
    }

    meta.updated_at = new Date().toISOString();
    await this.redis.set(taskMetaKey(tenantId, messageId), JSON.stringify(meta));

    // Audit
    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'TASK_MESSAGE_UPDATED',
      actor: { user_id: senderUserId, ip_address: ipAddress },
      resource: { entity: 'TASK_MESSAGE', id: messageId },
      status: 'SUCCESS',
      payload: { content: !!dto.content, availableFrom: dto.availableFrom },
    });

    // Webhook
    await this.sendWebhook({
      event: 'task_message.updated',
      tenantId,
      correlationId,
      messageId,
      senderUserId: meta.sender_user_id,
      recipientUserId: meta.recipient_user_id,
      recipientGroup: meta.recipient_group,
      content: dto.content || this.encryptionService.decrypt(meta.content_encrypted),
      status: meta.status,
      availableFrom: meta.available_from,
      createdAt: meta.created_at,
    });

    return { status: 'updated' };
  }

  /**
   * Cancella un messaggio (solo SCHEDULED o AVAILABLE, solo il mittente)
   */
  async delete(
    messageId: string,
    tenantId: string,
    senderUserId: string,
    ipAddress: string,
  ): Promise<{ status: string }> {
    const meta = await this.getMeta(tenantId, messageId);

    if (meta.sender_user_id !== senderUserId) {
      throw new ForbiddenException('Solo il mittente può cancellare il messaggio');
    }
    if (meta.status !== TaskMessageStatus.SCHEDULED && meta.status !== TaskMessageStatus.AVAILABLE) {
      throw new BadRequestException('Il messaggio può essere cancellato solo se SCHEDULED o AVAILABLE');
    }

    const correlationId = uuidv4();

    // Rimuovi job BullMQ se schedulato
    if (meta.bullmq_job_id) {
      const job = await this.taskQueue.getJob(meta.bullmq_job_id);
      if (job) await job.remove();
    }

    const previousStatus = meta.status;
    meta.status = TaskMessageStatus.DELETED;
    meta.deleted_at = new Date().toISOString();
    meta.deleted_by = senderUserId;
    meta.bullmq_job_id = null;
    meta.updated_at = new Date().toISOString();

    await this.redis.set(
      taskMetaKey(tenantId, messageId),
      JSON.stringify(meta),
      'EX',
      TERMINAL_TTL_SECONDS,
    );

    // Rimuovi dagli indici inbox se era AVAILABLE
    if (previousStatus === TaskMessageStatus.AVAILABLE) {
      await this.redis.srem(this.inboxKeyFor(tenantId, meta), messageId);
    }

    // Audit
    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'TASK_MESSAGE_DELETED',
      actor: { user_id: senderUserId, ip_address: ipAddress },
      resource: { entity: 'TASK_MESSAGE', id: messageId },
      status: 'SUCCESS',
      payload: { previousStatus },
    });

    // Webhook
    await this.sendWebhook({
      event: 'task_message.deleted',
      tenantId,
      correlationId,
      messageId,
      senderUserId: meta.sender_user_id,
      recipientUserId: meta.recipient_user_id,
      recipientGroup: meta.recipient_group,
      content: null,
      status: TaskMessageStatus.DELETED,
      availableFrom: meta.available_from,
      createdAt: meta.created_at,
    });

    return { status: 'deleted' };
  }

  /**
   * Segna come letto (chiamato dalla main app quando utente B apre il messaggio)
   */
  async markAsRead(
    messageId: string,
    tenantId: string,
    recipientUserId: string,
    ipAddress: string,
  ): Promise<{ status: string }> {
    const meta = await this.getMeta(tenantId, messageId);

    // Per i messaggi di gruppo l'appartenenza al gruppo è verificata dalla
    // Main App (il gateway non conosce gli utenti del tenant).
    if (!meta.recipient_group && meta.recipient_user_id !== recipientUserId) {
      throw new ForbiddenException('Solo il destinatario può segnare il messaggio come letto');
    }
    if (meta.status !== TaskMessageStatus.AVAILABLE) {
      throw new BadRequestException('Il messaggio può essere segnato come letto solo se AVAILABLE');
    }

    const correlationId = uuidv4();
    const now = new Date().toISOString();

    meta.status = TaskMessageStatus.READ;
    meta.read_at = now;
    meta.updated_at = now;

    await this.redis.set(taskMetaKey(tenantId, messageId), JSON.stringify(meta));

    // Audit
    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'TASK_MESSAGE_READ',
      actor: { user_id: recipientUserId, ip_address: ipAddress },
      resource: { entity: 'TASK_MESSAGE', id: messageId },
      status: 'SUCCESS',
      payload: { senderUserId: meta.sender_user_id },
    });

    // Webhook
    await this.sendWebhook({
      event: 'task_message.read',
      tenantId,
      correlationId,
      messageId,
      senderUserId: meta.sender_user_id,
      recipientUserId: meta.recipient_user_id,
      recipientGroup: meta.recipient_group,
      content: this.encryptionService.decrypt(meta.content_encrypted),
      status: TaskMessageStatus.READ,
      availableFrom: meta.available_from,
      createdAt: meta.created_at,
    });

    return { status: 'read' };
  }

  /**
   * Segna come completato (chiamato dalla main app quando utente B completa il task)
   */
  async markAsCompleted(
    messageId: string,
    tenantId: string,
    recipientUserId: string,
    ipAddress: string,
  ): Promise<{ status: string }> {
    const meta = await this.getMeta(tenantId, messageId);

    // Per i messaggi di gruppo l'appartenenza al gruppo è verificata dalla
    // Main App (il gateway non conosce gli utenti del tenant).
    if (!meta.recipient_group && meta.recipient_user_id !== recipientUserId) {
      throw new ForbiddenException('Solo il destinatario può completare il task');
    }
    if (meta.status !== TaskMessageStatus.READ) {
      throw new BadRequestException('Il task può essere completato solo se in stato READ');
    }

    const correlationId = uuidv4();
    const now = new Date().toISOString();

    meta.status = TaskMessageStatus.COMPLETED;
    meta.completed_at = now;
    meta.updated_at = now;

    // Imposta TTL per cleanup dopo transizione terminale
    await this.redis.set(
      taskMetaKey(tenantId, messageId),
      JSON.stringify(meta),
      'EX',
      TERMINAL_TTL_SECONDS,
    );

    // Rimuovi dagli indici
    await this.redis.srem(this.inboxKeyFor(tenantId, meta), messageId);

    // Audit
    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'TASK_MESSAGE_COMPLETED',
      actor: { user_id: recipientUserId, ip_address: ipAddress },
      resource: { entity: 'TASK_MESSAGE', id: messageId },
      status: 'SUCCESS',
      payload: { senderUserId: meta.sender_user_id },
    });

    // Webhook
    await this.sendWebhook({
      event: 'task_message.completed',
      tenantId,
      correlationId,
      messageId,
      senderUserId: meta.sender_user_id,
      recipientUserId: meta.recipient_user_id,
      recipientGroup: meta.recipient_group,
      content: this.encryptionService.decrypt(meta.content_encrypted),
      status: TaskMessageStatus.COMPLETED,
      availableFrom: meta.available_from,
      createdAt: meta.created_at,
    });

    return { status: 'completed' };
  }

  /**
   * Attiva un messaggio schedulato (chiamato dal BullMQ processor)
   */
  async activateScheduledMessage(
    messageId: string,
    tenantId: string,
  ): Promise<void> {
    const key = taskMetaKey(tenantId, messageId);
    const raw = await this.redis.get(key);

    if (!raw) {
      this.logger.warn(`Messaggio ${messageId} non trovato in Redis, skip attivazione`);
      return;
    }

    const meta: TaskMessageMeta = JSON.parse(raw);

    // Idempotenza: skip se non è più SCHEDULED
    if (meta.status !== TaskMessageStatus.SCHEDULED) {
      this.logger.log(`Messaggio ${messageId} non è SCHEDULED (${meta.status}), skip`);
      return;
    }

    const correlationId = uuidv4();
    const now = new Date().toISOString();

    meta.status = TaskMessageStatus.AVAILABLE;
    meta.bullmq_job_id = null;
    meta.updated_at = now;

    await this.redis.set(key, JSON.stringify(meta));

    // Aggiungi all'indice inbox del destinatario (o del gruppo)
    await this.redis.sadd(this.inboxKeyFor(tenantId, meta), messageId);

    // Audit
    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'TASK_MESSAGE_ACTIVATED',
      actor: { user_id: 'SYSTEM', ip_address: 'internal' },
      resource: { entity: 'TASK_MESSAGE', id: messageId },
      status: 'SUCCESS',
      payload: { recipientUserId: meta.recipient_user_id, recipientGroup: meta.recipient_group },
    });

    // Webhook: notifica che il messaggio è ora disponibile
    await this.sendWebhook({
      event: 'task_message.available',
      tenantId,
      correlationId,
      messageId,
      senderUserId: meta.sender_user_id,
      recipientUserId: meta.recipient_user_id,
      recipientGroup: meta.recipient_group,
      content: this.encryptionService.decrypt(meta.content_encrypted),
      status: TaskMessageStatus.AVAILABLE,
      availableFrom: meta.available_from,
      createdAt: meta.created_at,
    });
  }

  /**
   * Conta messaggi AVAILABLE non letti per un destinatario
   */
  async countPendingNotifications(
    tenantId: string,
    recipientUserId: string,
  ): Promise<{ count: number }> {
    const messageIds = await this.redis.smembers(inboxIndexKey(tenantId, recipientUserId));
    let count = 0;

    for (const msgId of messageIds) {
      const raw = await this.redis.get(taskMetaKey(tenantId, msgId));
      if (raw) {
        const meta: TaskMessageMeta = JSON.parse(raw);
        if (meta.status === TaskMessageStatus.AVAILABLE) {
          count++;
        }
      }
    }

    return { count };
  }

  /**
   * Lista messaggi inviati dal mittente
   */
  async listSent(
    tenantId: string,
    senderUserId: string,
  ): Promise<any[]> {
    const messageIds = await this.redis.smembers(sentIndexKey(tenantId, senderUserId));
    return this.loadMessages(tenantId, messageIds);
  }

  // --- Helpers privati ---

  /** Indice inbox corretto: per-utente o per-gruppo. */
  private inboxKeyFor(tenantId: string, meta: TaskMessageMeta): string {
    return meta.recipient_group
      ? groupInboxIndexKey(tenantId, meta.recipient_group)
      : inboxIndexKey(tenantId, meta.recipient_user_id as string);
  }

  private async getMeta(tenantId: string, messageId: string): Promise<TaskMessageMeta> {
    const raw = await this.redis.get(taskMetaKey(tenantId, messageId));
    if (!raw) {
      throw new NotFoundException(`Messaggio ${messageId} non trovato`);
    }
    return JSON.parse(raw);
  }

  private async loadMessages(tenantId: string, messageIds: string[]): Promise<any[]> {
    const messages: any[] = [];

    for (const msgId of messageIds) {
      const raw = await this.redis.get(taskMetaKey(tenantId, msgId));
      if (!raw) continue;

      const meta: TaskMessageMeta = JSON.parse(raw);
      // Non mostrare i DELETED
      if (meta.status === TaskMessageStatus.DELETED) continue;

      messages.push({
        messageId: meta.message_id,
        senderUserId: meta.sender_user_id,
        recipientUserId: meta.recipient_user_id,
        recipientGroup: meta.recipient_group ?? null,
        content: this.encryptionService.decrypt(meta.content_encrypted),
        status: meta.status,
        availableFrom: meta.available_from,
        createdAt: meta.created_at,
        updatedAt: meta.updated_at,
        readAt: meta.read_at,
        completedAt: meta.completed_at,
      });
    }

    // Ordina per data creazione decrescente
    messages.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return messages;
  }

  /**
   * Invia webhook alla main app tramite la coda callback-webhook esistente
   */
  private async sendWebhook(params: {
    event: string;
    tenantId: string;
    correlationId: string;
    messageId: string;
    senderUserId: string;
    recipientUserId: string | null;
    recipientGroup: string | null;
    content: string | null;
    status: TaskMessageStatus;
    availableFrom: string | null;
    createdAt: string;
  }): Promise<void> {
    await this.callbackQueue.add('send-callback', {
      correlationId: params.correlationId,
      tenantId: params.tenantId,
      event: {},
      gateway_metadata_override: {
        source: 'task-message-service',
        event: params.event,
        message_id: params.messageId,
        correlation_id: params.correlationId,
        tenant_id: params.tenantId,
        sender_user_id: params.senderUserId,
        recipient_user_id: params.recipientUserId,
        recipient_group: params.recipientGroup,
        content: params.content,
        status: params.status,
        available_from: params.availableFrom,
        created_at: params.createdAt,
        timestamp: new Date().toISOString(),
      },
    }, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
