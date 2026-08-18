import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

export type AuditEventType =
  | 'REQUEST_RECEIVED'
  | 'MESSAGE_DISPATCHED'
  | 'RECAP_GENERATED'
  /** Recap tolto dal buffer perché l'appuntamento è stato disdetto prima dell'invio. */
  | 'RECAP_SUPPRESSED'
  | 'REMINDER_SCHEDULED'
  | 'REMINDER_CANCELLED'
  | 'APPOINTMENT_UPDATED'
  | 'CANCEL_NOTIFICATION_QUEUED'
  | 'SCHEDULED_MESSAGE_CANCELLED'
  | 'WEBHOOK_RETRY'
  | 'INTERNAL_TASK_QUEUED'
  | 'TASK_MESSAGE_CREATED'
  | 'TASK_MESSAGE_UPDATED'
  | 'TASK_MESSAGE_ACTIVATED'
  | 'TASK_MESSAGE_READ'
  | 'TASK_MESSAGE_COMPLETED'
  | 'TASK_MESSAGE_DELETED'
  | 'OTP_DISPATCHED'
  | 'OTP_FALLBACK'
  | 'EVOLUTION_KEY_UPDATED'
  | 'ERROR';

export type AuditStatus = 'SUCCESS' | 'FAILED' | 'PENDING';

export interface AuditActor {
  user_id: string;
  ip_address: string;
}

export interface AuditResource {
  entity: string;
  id: string;
}

export interface AuditMetadata {
  retry_count?: number;
  processing_time_ms?: number;
  evolution_message_id?: string;
  [key: string]: any;
}

export interface AuditLog {
  audit_version: string;
  timestamp: string;
  tenant_id: string;
  correlation_id: string;
  event_type: AuditEventType;
  actor: AuditActor;
  resource: AuditResource;
  status: AuditStatus;
  integrity_check: {
    payload_hash: string;
  };
  metadata: AuditMetadata;
}

export interface AuditParams {
  tenantId: string;
  correlationId: string;
  eventType: AuditEventType;
  actor: AuditActor;
  resource: AuditResource;
  status: AuditStatus;
  payload: any;
  metadata?: AuditMetadata;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger('AuditTrail');

  async log(params: AuditParams): Promise<void> {
    const payloadString = JSON.stringify(params.payload);
    const payloadHash = crypto.createHash('sha256').update(payloadString).digest('hex');

    const logEntry: AuditLog = {
      audit_version: '1.0',
      timestamp: new Date().toISOString(),
      tenant_id: params.tenantId,
      correlation_id: params.correlationId,
      event_type: params.eventType,
      actor: params.actor,
      resource: params.resource,
      status: params.status,
      integrity_check: {
        payload_hash: payloadHash,
      },
      metadata: params.metadata ?? {},
    };

    this.logger.log(JSON.stringify(logEntry));
  }
}
