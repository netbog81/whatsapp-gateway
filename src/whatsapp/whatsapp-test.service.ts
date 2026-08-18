import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { BaoService } from '../auth/bao.service';
import { EncryptionService } from '../common/encryption.service';

const RECAP_TTL_SECONDS = 300;

@Injectable()
export class WhatsappTestService {
  private readonly logger = new Logger(WhatsappTestService.name);

  constructor(
    @InjectQueue('whatsapp-queue') private whatsappQueue: Queue,
    @InjectRedis() private readonly redis: Redis,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly baoService: BaoService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * TEST 1 — Invio diretto sincrono, bypass coda BullMQ.
   * Risponde con l'esito immediato da Evolution API.
   */
  async testDirect(tenantId: string, phone: string, name: string, message: string) {
    const evolutionToken = await this.getEvolutionToken(tenantId);
    const evolutionUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const text = message || `[TEST DIRETTO] Ciao ${name}, questo è un messaggio di test dal gateway WhatsApp. ${new Date().toISOString()}`;

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${evolutionUrl}/message/sendText/${tenantId}`,
          { number: phone, text },
          { headers: { apikey: evolutionToken } },
        ),
      );

      this.logger.log(`[TEST/DIRECT] Messaggio inviato a ${phone} via ${tenantId}`);
      return {
        mode: 'direct',
        status: 'sent',
        evolutionMessageId: response.data?.key?.id,
        phone,
        text,
      };
    } catch (error: any) {
      const evolutionError = error.response?.data;
      this.logger.error(`[TEST/DIRECT] Errore Evolution API: ${JSON.stringify(evolutionError || error.message)}`);
      return {
        mode: 'direct',
        status: 'error',
        phone,
        text,
        error: {
          statusCode: error.response?.status,
          evolutionResponse: evolutionError,
          message: error.message,
        },
      };
    }
  }

  /**
   * TEST 2 — Recap reale (60s di produzione) + reminder simulato a 5 minuti.
   * 1 appuntamento nel buffer → recap dopo 60s → reminder dopo 5 min.
   */
  async testRecap(tenantId: string, phone: string, name: string) {
    const correlationId = uuidv4();
    const pazienteId = `test-patient-${uuidv4().substring(0, 8)}`;
    const appointmentId = `test-appt-${uuidv4().substring(0, 8)}`;

    // Appuntamento simulato: domani alle 10:30 (per avere una data sensata nel messaggio)
    const appointmentDate = DateTime.now().setZone('Europe/Rome').plus({ days: 1 }).set({ hour: 10, minute: 30, second: 0, millisecond: 0 });

    const appointmentData = {
      appointmentId,
      pazienteId,
      phone,
      date: appointmentDate.toISO(),
      name: name || 'Paziente Test',
    };

    // 1. Inserisce nel buffer Redis (cifrato, come in produzione).
    // Chiave per numero di telefono: stessa di WhatsappService/WhatsappProcessor.
    const recapKey = `pending:${tenantId}:${phone}`;
    const encryptedData = this.encryptionService.encrypt(JSON.stringify(appointmentData));
    await this.redis.rpush(recapKey, encryptedData);
    await this.redis.expire(recapKey, RECAP_TTL_SECONDS);

    // 2. Recap dopo 60s (delay reale di produzione)
    await this.whatsappQueue.add(
      'process-recap',
      { tenantId, pazienteId, phone, correlationId, recapMessage: null },
      {
        delay: 60000,
        jobId: `test-recap:${tenantId}:${pazienteId}`,
        removeOnComplete: true,
      },
    );

    // 3. Reminder simulato dopo 5 minuti (invece di 24h prima)
    const reminderText = `[TEST REMINDER] ${name || 'Paziente Test'}, promemoria: appuntamento domani alle ${appointmentDate.toFormat('HH:mm')}.`;
    await this.whatsappQueue.add(
      'send-reminder',
      {
        tenantId,
        phone,
        content: reminderText,
        correlationId: uuidv4(),
        originalAppointmentId: appointmentId,
      },
      {
        delay: 5 * 60 * 1000, // 5 minuti
        jobId: `test-reminder:${tenantId}:${appointmentId}`,
        removeOnComplete: true,
      },
    );

    this.logger.log(`[TEST/RECAP] Schedulati recap (60s) e reminder (5min) per tenant ${tenantId}, paziente ${pazienteId}`);

    return {
      mode: 'recap',
      correlationId,
      pazienteId,
      appointmentId,
      appointmentDate: appointmentDate.toISO(),
      scheduled: {
        recap: { delaySeconds: 60, jobId: `test-recap:${tenantId}:${pazienteId}` },
        reminder: { delayMinutes: 5, jobId: `test-reminder:${tenantId}:${appointmentId}` },
      },
    };
  }

  /**
   * TEST 3 — Flusso completo: 3 appuntamenti → recap aggregato (60s) + 3 reminder a 5/6/7 minuti.
   */
  async testFullFlow(tenantId: string, phone: string, name: string) {
    const correlationId = uuidv4();
    const pazienteId = `test-patient-${uuidv4().substring(0, 8)}`;
    const patientName = name || 'Paziente Test';

    // 3 appuntamenti simulati in giorni consecutivi
    const appointments = [
      { offsetDays: 1, hour: 9,  minute: 0,  label: '1' },
      { offsetDays: 2, hour: 14, minute: 30, label: '2' },
      { offsetDays: 3, hour: 11, minute: 0,  label: '3' },
    ];

    const recapKey = `pending:${tenantId}:${phone}`;
    const scheduledReminders = [];

    for (const appt of appointments) {
      const appointmentId = `test-appt-${uuidv4().substring(0, 8)}`;
      const appointmentDate = DateTime.now()
        .setZone('Europe/Rome')
        .plus({ days: appt.offsetDays })
        .set({ hour: appt.hour, minute: appt.minute, second: 0, millisecond: 0 });

      const appointmentData = {
        appointmentId,
        pazienteId,
        phone,
        date: appointmentDate.toISO(),
        name: patientName,
      };

      // Inserisce nel buffer Redis cifrato
      const encryptedData = this.encryptionService.encrypt(JSON.stringify(appointmentData));
      await this.redis.rpush(recapKey, encryptedData);

      // Reminder simulato: appuntamento 1 → 5 min, 2 → 6 min, 3 → 7 min
      const reminderDelayMs = (4 + appt.offsetDays) * 60 * 1000;
      const reminderText = `[TEST REMINDER ${appt.label}/3] ${patientName}, promemoria: appuntamento tra ${appt.offsetDays} giorno/i alle ${appointmentDate.toFormat('HH:mm')}.`;

      await this.whatsappQueue.add(
        'send-reminder',
        {
          tenantId,
          phone,
          content: reminderText,
          correlationId: uuidv4(),
          originalAppointmentId: appointmentId,
        },
        {
          delay: reminderDelayMs,
          jobId: `test-reminder:${tenantId}:${appointmentId}`,
          removeOnComplete: true,
        },
      );

      scheduledReminders.push({
        label: appt.label,
        appointmentId,
        appointmentDate: appointmentDate.toISO(),
        reminderDelayMinutes: reminderDelayMs / 60000,
        jobId: `test-reminder:${tenantId}:${appointmentId}`,
      });
    }

    await this.redis.expire(recapKey, RECAP_TTL_SECONDS);

    // Recap aggregato dopo 60s (delay reale di produzione)
    await this.whatsappQueue.add(
      'process-recap',
      { tenantId, pazienteId, phone, correlationId, recapMessage: null },
      {
        delay: 60000,
        jobId: `test-recap:${tenantId}:${pazienteId}`,
        removeOnComplete: true,
      },
    );

    this.logger.log(`[TEST/FULL-FLOW] Schedulati recap (60s) e 3 reminder (5/6/7min) per tenant ${tenantId}, paziente ${pazienteId}`);

    return {
      mode: 'full-flow',
      correlationId,
      pazienteId,
      appointmentCount: 3,
      scheduled: {
        recap: { delaySeconds: 60, jobId: `test-recap:${tenantId}:${pazienteId}` },
        reminders: scheduledReminders,
      },
    };
  }

  private async getEvolutionToken(tenantId: string): Promise<string> {
    const cacheKey = `evolution:token:${tenantId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const secret = await this.baoService.getSecret(`whatsapp/${tenantId}/evolution_apikey`);
    if (secret?.api_key) {
      await this.redis.set(cacheKey, secret.api_key, 'EX', 3600);
      return secret.api_key;
    }
    throw new Error(`Nessun token Evolution trovato per il tenant ${tenantId}`);
  }
}
