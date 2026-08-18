import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import { BaoService } from '../auth/bao.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/encryption.service';

const RATE_LIMIT_KEY = (tenantId: string) => `ratelimit:evolution:${tenantId}`;
const MIN_INTERVAL_MS = 10000; // 10 secondi per tenant
/**
 * I messaggi di chat sono scritti a mano da un operatore: sono già ritmati da
 * una persona, e imporre i 10s dei messaggi automatici renderebbe la
 * conversazione inutilizzabile. Resta comunque una distanza minima verso
 * Evolution per non finire in flood.
 */
const MIN_INTERVAL_CHAT_MS = 1500;

@Processor('whatsapp-queue', {
  concurrency: 1,
})
export class WhatsappProcessor extends WorkerHost {
  private readonly logger = new Logger(WhatsappProcessor.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectRedis() private readonly redis: Redis,
    private readonly baoService: BaoService,
    private readonly auditService: AuditService,
    private readonly encryptionService: EncryptionService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    // Jitter anti-ban (1-3 secondi) sul solo traffico automatico: su una chat
    // interattiva si tradurrebbe in un ritardo percepito a ogni riga scritta.
    if (job.name !== 'send-chat') {
      const jitter = Math.floor(Math.random() * 2000) + 1000;
      await new Promise(resolve => setTimeout(resolve, jitter));
    }

    const { tenantId } = job.data;

    if (job.name === 'process-internal-task') {
      return this.handleInternalTask(job.data);
    }

    const evolutionToken = await this.getTenantEvolutionToken(tenantId);
    if (!evolutionToken) {
      throw new Error(`Nessun token Evolution trovato per il tenant ${tenantId}`);
    }

    switch (job.name) {
      case 'process-recap':
        return this.sendRecap(job.data, evolutionToken);
      case 'send-reminder':
        return this.sendToEvolution(job.data, evolutionToken);
      case 'send-chat':
        return this.sendToEvolution(job.data, evolutionToken);
      default:
        this.logger.warn(`Job type sconosciuto: ${job.name}`);
    }
  }

  private async getTenantEvolutionToken(tenantId: string): Promise<string> {
    const cacheKey = `evolution:token:${tenantId}`;

    const cachedToken = await this.redis.get(cacheKey);
    if (cachedToken) return cachedToken;

    const secret = await this.baoService.getSecret(`whatsapp/${tenantId}/evolution_apikey`);

    if (secret && secret.api_key) {
      await this.redis.set(cacheKey, secret.api_key, 'EX', 3600);
      return secret.api_key;
    }

    return null;
  }

  /**
   * Rate limiter per-tenant: garantisce una distanza minima tra due messaggi
   * dello stesso tenant verso Evolution. L'intervallo dipende dal tipo di
   * traffico (vedi MIN_INTERVAL_CHAT_MS).
   */
  private async applyPerTenantRateLimit(
    tenantId: string,
    minIntervalMs: number = MIN_INTERVAL_MS,
  ): Promise<void> {
    const rateLimitKey = RATE_LIMIT_KEY(tenantId);
    const lastSentStr = await this.redis.get(rateLimitKey);

    if (lastSentStr) {
      const elapsed = Date.now() - parseInt(lastSentStr, 10);
      if (elapsed < minIntervalMs) {
        const wait = minIntervalMs - elapsed;
        this.logger.debug(`Rate limit tenant ${tenantId}: attendo ${wait}ms`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
    }

    await this.redis.set(rateLimitKey, Date.now().toString(), 'EX', 60);
  }

  private async sendRecap(data: any, token: string) {
    const { tenantId, pazienteId, phone, recapMessage } = data;
    // Chiave allineata a WhatsappService.handleBooking: si raggruppa per numero
    // di telefono, non per pazienteId (vale anche per i walk-in senza anagrafica).
    const recapKey = `pending:${tenantId}:${phone}`;
    const startTime = Date.now();

    const encryptedItems = await this.redis.lrange(recapKey, 0, -1);

    if (encryptedItems.length === 0) {
      this.logger.warn(`Nessun appuntamento in buffer per ${recapKey}`);
      return;
    }

    // Chiude anche la finestra scorrevole: il prossimo appuntamento per questo
    // numero deve poter aprire un gruppo nuovo con il conteggio pieno.
    await this.redis.del(recapKey, `recap_start:${tenantId}:${phone}`);

    // Decifrare i dati prima dell'uso
    const appointments = encryptedItems.map(item => {
      try {
        return JSON.parse(this.encryptionService.decrypt(item));
      } catch {
        return JSON.parse(item); // fallback per dati non cifrati (migrazione)
      }
    });

    const messageType = appointments.length === 1 ? 'single_recap' : 'multiple_recap';
    const text = this.buildRecapText(appointments, recapMessage);

    const appointmentIds = appointments.map((appt: any) => appt.appointmentId).filter(Boolean);
    const recapCorrelationId = uuidv4();

    try {
      const result = await this.sendToEvolution({
        tenantId,
        phone,
        content: text,
        message_type: messageType,
        correlationId: recapCorrelationId,
        pazienteId,
        appointmentIds,
      }, token);
      const processingTime = Date.now() - startTime;

      await this.auditService.log({
        tenantId,
        correlationId: recapCorrelationId,
        eventType: 'RECAP_GENERATED',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'PATIENT', id: pazienteId },
        status: 'SUCCESS',
        payload: { appointmentCount: appointments.length, appointmentIds },
        metadata: {
          processing_time_ms: processingTime,
          evolution_message_id: result?.key?.id,
        },
      });

      return result;
    } catch (error: any) {
      await this.auditService.log({
        tenantId,
        correlationId: recapCorrelationId,
        eventType: 'ERROR',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'PATIENT', id: pazienteId },
        status: 'FAILED',
        payload: { errorMessage: error.message },
        metadata: { processing_time_ms: Date.now() - startTime },
      });
      throw error;
    }
  }

  /**
   * Compone il testo del recap a partire dagli appuntamenti bufferizzati.
   *
   * I testi arrivano dalla main-app, che è l'unica a conoscere i template del
   * tenant: ogni appuntamento porta con sé il proprio `recapMessage` (recap
   * singolo già renderizzato) e la propria `recapLine` (riga per il recap
   * multiplo). Il template multiplo (`recapMultiTemplate`) viaggia grezzo,
   * perché l'elenco è noto solo qui alla chiusura della finestra di buffer.
   *
   * `jobRecapMessage` è il testo presente sul job `process-recap`: appartiene
   * al PRIMO appuntamento della finestra (BullMQ ignora gli add successivi con
   * lo stesso jobId), quindi vale solo come fallback per il recap singolo.
   */
  private buildRecapText(appointments: any[], jobRecapMessage?: string): string {
    const first = appointments[0];
    const fmt = (iso: string) => DateTime.fromISO(iso, { zone: 'Europe/Rome' });

    if (appointments.length === 1) {
      const custom = first.recapMessage ?? jobRecapMessage;
      if (custom) return custom;
      const dt = fmt(first.date);
      return `Gentile ${first.name}, confermiamo il suo appuntamento per il ${dt.toFormat('dd/MM/yyyy')} alle ${dt.toFormat('HH:mm')}.`;
    }

    const lines = appointments.map(appt => {
      if (appt.recapLine) return appt.recapLine;
      const dt = fmt(appt.date);
      return `- ${dt.toFormat('dd/MM/yyyy')} alle ${dt.toFormat('HH:mm')}`;
    });

    const multiTemplate = appointments.find(appt => appt.recapMultiTemplate)?.recapMultiTemplate;
    if (multiTemplate) {
      return multiTemplate
        .replace(/\{name\}/g, first.name ?? '')
        .replace(/\{appointments\}/g, lines.join('\n'));
    }

    return `Gentile ${first.name}, confermiamo i seguenti appuntamenti:\n${lines.join('\n')}`;
  }

  private async sendToEvolution(data: any, token: string) {
    const instanceName = data.tenantId;
    const evolutionUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const startTime = Date.now();

    const isChat = data.message_type === 'chat_outbound';

    try {
      await this.applyPerTenantRateLimit(
        instanceName,
        isChat ? MIN_INTERVAL_CHAT_MS : MIN_INTERVAL_MS,
      );
      const response = await firstValueFrom(
        this.httpService.post(
          `${evolutionUrl}/message/sendText/${instanceName}`,
          { number: data.phone, text: data.content },
          { headers: { apikey: token } },
        ),
      );
      const processingTime = Date.now() - startTime;

      this.logger.log(`Messaggio inviato a ${data.phone} via ${instanceName}`);

      // Salva i metadati completi in Redis per 48h, indicizzati per evolution_message_id
      // Il webhook consumer li recupera quando arriva messages.upsert da Evolution
      const evolutionMsgId = response.data?.key?.id;
      if (evolutionMsgId && data.message_type) {
        const metadata = {
          message_type: data.message_type,
          correlation_id: data.correlationId || 'unknown',
          patient_id: data.pazienteId || 'unknown',
          appointment_ids: data.appointmentIds || [],
          // Solo per la chat: permette alla Main App di attribuire gli stati di
          // consegna alla conversazione giusta senza cercare per numero.
          ...(data.conversationId ? { conversation_id: data.conversationId } : {}),
        };
        await this.redis.set(
          `msg_meta:${data.tenantId}:${evolutionMsgId}`,
          JSON.stringify(metadata),
          'EX',
          172800, // 48h
        );
      }

      await this.auditService.log({
        tenantId: data.tenantId,
        correlationId: data.correlationId || 'PROCESSOR',
        eventType: 'MESSAGE_DISPATCHED',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'APPOINTMENT', id: data.originalAppointmentId || 'N/A' },
        status: 'SUCCESS',
        payload: { phone: data.phone, message_type: data.message_type || 'unknown' },
        metadata: {
          processing_time_ms: processingTime,
          evolution_message_id: response.data?.key?.id,
        },
      });

      return { ...response.data, message_type: data.message_type };
    } catch (error: any) {
      await this.auditService.log({
        tenantId: data.tenantId,
        correlationId: data.correlationId || 'PROCESSOR',
        eventType: 'ERROR',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'APPOINTMENT', id: data.originalAppointmentId || 'N/A' },
        status: 'FAILED',
        payload: { errorMessage: error.message, phone: data.phone },
        metadata: { processing_time_ms: Date.now() - startTime },
      });
      this.logger.error(`Errore invio per ${instanceName}: ${error.message}`);
      throw error;
    }
  }

  private async handleInternalTask(data: any) {
    this.logger.log(`Elaborazione task interno per tenant ${data.tenantId}: ${JSON.stringify(data)}`);
    // I task interni vengono gestiti dal WebhookProcessor via RabbitMQ publish
    // oppure tramite altri meccanismi specifici del sistema
    return { status: 'processed', tenantId: data.tenantId };
  }
}
