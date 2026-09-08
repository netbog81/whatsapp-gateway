import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
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
import {
  ChannelDeliveryService,
  DeliveryChannel,
  NoUsableChannelError,
} from '../delivery/channel-delivery.service';
import {
  RecapKind,
  recapKeys,
  recapKindOfJob,
  recapMessageType,
  earlierKinds,
  RECAP_DEFER_MARGIN_MS,
  RECAP_MAX_DEFERRALS,
} from './recap-buffer';

const RATE_LIMIT_KEY = (tenantId: string) => `ratelimit:evolution:${tenantId}`;
const MIN_INTERVAL_MS = 10000; // 10 secondi per tenant
/**
 * I messaggi di chat sono scritti a mano da un operatore: sono già ritmati da
 * una persona, e imporre i 10s dei messaggi automatici renderebbe la
 * conversazione inutilizzabile. Resta comunque una distanza minima verso
 * Evolution per non finire in flood.
 */
const MIN_INTERVAL_CHAT_MS = 1500;

/**
 * Data e ora di un appuntamento in ora locale italiana.
 *
 * Le date arrivano SENZA offset proprio perché vanno lette in Europe/Rome:
 * un offset fisso sballerebbe di un'ora tutti i messaggi da fine marzo a fine
 * ottobre.
 */
const fmtLong = (iso: string) => {
  const dt = DateTime.fromISO(iso, { zone: 'Europe/Rome' });
  return dt.isValid ? `${dt.toFormat('dd/MM/yyyy')} alle ${dt.toFormat('HH:mm')}` : '';
};

/** Forma compatta, per le righe che affiancano due orari con una freccia. */
const fmtShort = (iso: string) => {
  const dt = DateTime.fromISO(iso, { zone: 'Europe/Rome' });
  return dt.isValid ? dt.toFormat('dd/MM/yyyy HH:mm') : '';
};

/**
 * Da dove pescare i testi di un raggruppamento, e cosa scrivere se la main-app
 * non ne ha mandato nessuno.
 *
 * I fallback non sono decorazione: se il tenant disattiva un template il
 * paziente deve comunque ricevere una frase sensata, non un messaggio vuoto.
 */
interface RecapTextSpec {
  /** Campo col messaggio già renderizzato, usato quando l'appuntamento è uno solo. */
  singleField: string;
  /** Campo con la riga di questo appuntamento dentro l'elenco. */
  lineField: string;
  /** Campo col template dell'elenco, grezzo: `{name}` e `{appointments}`. */
  multiField: string;
  fallbackSingle(appt: any): string;
  fallbackLine(appt: any): string;
  fallbackMulti(first: any, lines: string[]): string;
}

const RECAP_TEXT_SPEC: Record<RecapKind, RecapTextSpec> = {
  booking: {
    singleField: 'recapMessage',
    lineField: 'recapLine',
    multiField: 'recapMultiTemplate',
    fallbackSingle: appt =>
      `Gentile ${appt.name}, confermiamo il suo appuntamento per il ${fmtLong(appt.date)}.`,
    fallbackLine: appt => `- ${fmtLong(appt.date)}`,
    fallbackMulti: (first, lines) =>
      `Gentile ${first.name}, confermiamo i seguenti appuntamenti:\n${lines.join('\n')}`,
  },
  update: {
    singleField: 'updateMessage',
    lineField: 'updateLine',
    multiField: 'updateMultiTemplate',
    fallbackSingle: appt =>
      `Gentile ${appt.name}, il suo appuntamento è stato spostato al ${fmtLong(appt.date)}.`,
    // Con più spostamenti insieme il solo orario nuovo non basta: il paziente
    // deve poter riconoscere QUALE dei suoi appuntamenti si è mosso.
    fallbackLine: appt =>
      appt.previousDate
        ? `- ${fmtShort(appt.previousDate)} → ${fmtShort(appt.date)}`
        : `- ${fmtLong(appt.date)}`,
    fallbackMulti: (first, lines) =>
      `Gentile ${first.name}, i suoi appuntamenti sono stati spostati:\n${lines.join('\n')}`,
  },
  cancel: {
    singleField: 'cancelNotificationMessage',
    lineField: 'cancelLine',
    multiField: 'cancelMultiTemplate',
    fallbackSingle: appt =>
      appt.date && appt.name
        ? `Gentile ${appt.name}, il suo appuntamento del ${fmtLong(appt.date)} è stato cancellato.`
        : 'Il suo appuntamento è stato cancellato.',
    fallbackLine: appt => `- ${fmtLong(appt.date)}`,
    fallbackMulti: (first, lines) =>
      `Gentile ${first.name}, i seguenti appuntamenti sono stati cancellati:\n${lines.join('\n')}`,
  },
};

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
    // Consegna multicanale: usata solo dai job che portano un piano di canali.
    // Senza piano il percorso resta quello di sempre, solo WhatsApp.
    private readonly channelDelivery: ChannelDeliveryService,
    // Serve a rimettersi in coda: un raggruppamento che scade mentre uno che
    // deve precederlo è ancora in attesa si fa da parte invece di scavalcarlo.
    @InjectQueue('whatsapp-queue') private readonly whatsappQueue: Queue,
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

    // Il token serve solo a chi passa da WhatsApp. Pretenderlo per ogni job
    // impedirebbe a un tenant che usa solo SMS o email di mandare qualsiasi
    // cosa: il canale sarebbe configurato e la coda fallirebbe lo stesso.
    const usesWhatsapp = !Array.isArray(job.data.channels)
      || job.data.channels.includes('whatsapp');
    const evolutionToken = usesWhatsapp ? await this.getTenantEvolutionToken(tenantId) : null;
    if (usesWhatsapp && !evolutionToken) {
      throw new Error(`Nessun token Evolution trovato per il tenant ${tenantId}`);
    }

    // Prenotazioni, spostamenti e disdette hanno tre timer distinti ma un solo
    // percorso: cambia solo da quale buffer si pesca e con quali testi.
    const recapKind = recapKindOfJob(job.name);
    if (recapKind) {
      return this.sendRecap(recapKind, job, evolutionToken);
    }

    switch (job.name) {
      case 'send-reminder':
        // Un promemoria puo' viaggiare su piu' canali; la chat no, per
        // definizione: e' una conversazione WhatsApp.
        return Array.isArray(job.data.channels) && job.data.channels.length
          ? this.deliverMultichannel(job.data)
          : this.sendToEvolution(job.data, evolutionToken);
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

  private async sendRecap(kind: RecapKind, job: Job, token: string) {
    const data = job.data ?? {};
    const { tenantId, pazienteId, phone, recapMessage } = data;
    // Chiavi allineate a quelle che riempie WhatsappService: si raggruppa per
    // numero di telefono, non per pazienteId (vale anche per i walk-in senza
    // anagrafica, che avrebbero un id diverso per ogni appuntamento).
    const { listKey, startKey } = recapKeys(kind, tenantId, phone);
    const startTime = Date.now();

    const encryptedItems = await this.redis.lrange(listKey, 0, -1);

    if (encryptedItems.length === 0) {
      this.logger.warn(`Nessun appuntamento in buffer per ${listKey}`);
      return;
    }

    // Se per lo stesso numero deve ancora uscire un raggruppamento che viene
    // prima, questo si rimette in coda: leggere "disdetto" prima di
    // "confermiamo" è incomprensibile.
    if (await this.deferBehindEarlierKinds(kind, job)) {
      return { deferred: true };
    }

    // Chiude anche la finestra scorrevole: il prossimo appuntamento per questo
    // numero deve poter aprire un gruppo nuovo con il conteggio pieno.
    await this.redis.del(listKey, startKey);

    // Decifrare i dati prima dell'uso
    const appointments = encryptedItems.map(item => {
      try {
        return JSON.parse(this.encryptionService.decrypt(item));
      } catch {
        return JSON.parse(item); // fallback per dati non cifrati (migrazione)
      }
    });

    // Il buffer conserva l'ordine di CREAZIONE, che non e' quello in cui il
    // paziente vivra' gli appuntamenti: chi prenota per ultimo l'8 gennaio e
    // per primo il 20 gennaio si vedrebbe l'elenco al contrario.
    const ordered = this.sortChronologically(appointments);

    const messageType = recapMessageType(kind, ordered.length);
    const text = this.buildRecapText(kind, ordered, recapMessage);

    const appointmentIds = ordered.map((appt: any) => appt.appointmentId).filter(Boolean);

    // Con un solo appuntamento si riusa il correlationId con cui la main-app
    // ha già aperto il proprio log, così la riconciliazione resta esatta.
    // Nell'elenco multiplo non si può: gli id sarebbero più d'uno e nessuno
    // rappresenterebbe il messaggio davvero inviato.
    const recapCorrelationId =
      ordered.length === 1 && ordered[0]?.correlationId ? ordered[0].correlationId : uuidv4();

    try {
      // Il raggruppamento resta per numero di telefono anche quando il
      // messaggio uscira' via email o SMS: raggruppare e' una questione di
      // "quante prenotazioni ha fatto questa persona adesso", non di come le
      // verra' recapitato l'elenco.
      const outgoing: Record<string, any> = {
        tenantId,
        phone,
        content: text,
        message_type: messageType,
        correlationId: recapCorrelationId,
        pazienteId,
        appointmentIds,
        ...this.deliveryFieldsOf(data, messageType),
      };
      const result = Array.isArray(outgoing.channels) && outgoing.channels.length
        ? await this.deliverMultichannel(outgoing)
        : await this.sendToEvolution(outgoing, token);
      const processingTime = Date.now() - startTime;

      await this.auditService.log({
        tenantId,
        correlationId: recapCorrelationId,
        eventType: 'RECAP_GENERATED',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'PATIENT', id: pazienteId },
        status: 'SUCCESS',
        payload: { kind, appointmentCount: ordered.length, appointmentIds },
        metadata: {
          processing_time_ms: processingTime,
          // Due forme possibili: Evolution risponde annidato, il motore
          // multicanale restituisce l'id gia' estratto.
          evolution_message_id: result?.key?.id ?? result?.providerMessageId,
          ...(result?.channel ? { channel: result.channel, used_fallback: result.usedFallback } : {}),
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
   * Rimette in coda questo raggruppamento se per lo stesso numero ne deve
   * ancora uscire uno che viene prima (prenotazioni → spostamenti → disdette).
   *
   * Il controllo si fa QUI e non al momento di programmare il timer perché la
   * finestra è scorrevole: una prenotazione che arriva dopo sposta in avanti
   * il proprio recap, e un ordine deciso in anticipo sarebbe già scaduto.
   *
   * Non può girare a vuoto: la finestra che precede ha un tetto proprio (15
   * minuti), e comunque dopo `RECAP_MAX_DEFERRALS` rinvii si parte comunque.
   */
  private async deferBehindEarlierKinds(kind: RecapKind, job: Job): Promise<boolean> {
    const earlier = earlierKinds(kind);
    if (earlier.length === 0) return false;

    const { tenantId, phone } = job.data ?? {};
    if (!phone) return false;

    const deferCount = job.data?.deferCount ?? 0;
    if (deferCount >= RECAP_MAX_DEFERRALS) {
      this.logger.warn(
        `Recap ${kind} ${tenantId}/${phone}: ${deferCount} rinvii, parte comunque`,
      );
      return false;
    }

    let waitMs = 0;
    for (const other of earlier) {
      const timer = await this.whatsappQueue.getJob(recapKeys(other, tenantId, phone).jobId);
      if (!timer) continue;
      const remaining = timer.timestamp + (timer.delay ?? 0) - Date.now();
      if (remaining > waitMs) waitMs = remaining;
    }

    // Nessuno davanti, o sta già partendo: alla distanza fra i due invii pensa
    // la coda, che ha un solo worker e li serve in ordine.
    if (waitMs <= 0) return false;

    const next = deferCount + 1;
    await this.whatsappQueue.add(
      job.name,
      { ...job.data, deferCount: next },
      {
        delay: waitMs + RECAP_DEFER_MARGIN_MS,
        // Id distinto: quello canonico appartiene a QUESTO job, che è ancora
        // attivo e quindi non riutilizzabile finché non completa.
        jobId: `${recapKeys(kind, tenantId, phone).jobId}:defer:${next}`,
        removeOnComplete: true,
      },
    );

    this.logger.log(
      `Recap ${kind} ${tenantId}/${phone} rinviato di ${waitMs + RECAP_DEFER_MARGIN_MS}ms: c'è un raggruppamento che deve uscire prima`,
    );
    return true;
  }

  /**
   * Ordina gli appuntamenti bufferizzati dal piu' prossimo al piu' lontano.
   *
   * Le date arrivano come ISO (`2026-02-15T10:30:00`), quindi il confronto
   * fra stringhe e' gia' cronologico e non paga la costruzione di un Date per
   * ogni elemento. Chi non ha `date` finisce in fondo invece di far esplodere
   * il confronto.
   */
  private sortChronologically(appointments: any[]): any[] {
    return [...appointments].sort((a, b) =>
      String(a?.date ?? '\uffff').localeCompare(String(b?.date ?? '\uffff')),
    );
  }

  /**
   * Compone il testo di un raggruppamento a partire dagli appuntamenti
   * bufferizzati.
   *
   * I testi arrivano dalla main-app, che è l'unica a conoscere i template del
   * tenant: ogni appuntamento porta con sé il proprio messaggio singolo già
   * renderizzato e la propria riga per l'elenco. Il template multiplo viaggia
   * invece GREZZO, perché l'elenco è noto solo qui, alla chiusura della
   * finestra di buffer.
   *
   * `jobMessage` è il testo presente sul job: appartiene al PRIMO appuntamento
   * della finestra (BullMQ ignora gli add successivi con lo stesso jobId),
   * quindi vale solo come fallback per il messaggio singolo.
   */
  private buildRecapText(kind: RecapKind, appointments: any[], jobMessage?: string): string {
    const spec = RECAP_TEXT_SPEC[kind];
    const first = appointments[0];

    if (appointments.length === 1) {
      const custom = first[spec.singleField] ?? jobMessage;
      if (custom) return custom;
      return spec.fallbackSingle(first);
    }

    const lines = appointments.map(appt => appt[spec.lineField] ?? spec.fallbackLine(appt));

    const multiTemplate = appointments.find(appt => appt[spec.multiField])?.[spec.multiField];
    if (multiTemplate) {
      return multiTemplate
        .replace(/\{name\}/g, first.name ?? '')
        .replace(/\{appointments\}/g, lines.join('\n'));
    }

    return spec.fallbackMulti(first, lines);
  }

  /**
   * Consegna un messaggio programmato provando i canali nell'ordine indicato.
   *
   * Il piano viaggia DENTRO il job: un promemoria messo in coda oggi per
   * domani deve partire con le regole di oggi. Rileggere le impostazioni al
   * momento dell'invio farebbe cambiare canale a messaggi gia' accettati,
   * e nessuno saprebbe perche'.
   *
   * L'esito non fa fallire il job quando semplicemente non c'e' un recapito
   * utilizzabile: non e' un guasto da ritentare, e' un paziente di cui non
   * abbiamo l'indirizzo giusto.
   */
  /**
   * Campi di consegna che il job si porta dietro, se la main-app ne ha indicati.
   *
   * `messageType` serve ai raggruppamenti: quando il job e' stato accodato non
   * si sapeva ancora se il paziente avrebbe ricevuto un appuntamento o un
   * elenco, quindi i testi di tutti i tipi sono viaggiati insieme e la scelta
   * si fa qui, dove il tipo finalmente si conosce.
   */
  private deliveryFieldsOf(data: any, messageType?: string): Record<string, any> {
    if (!Array.isArray(data?.channels) || !data.channels.length) return {};

    const texts = messageType ? data?.channelTexts?.[messageType] : undefined;

    return {
      channels: data.channels,
      ...(data.email ? { email: data.email } : {}),
      ...(data.smsDriver ? { smsDriver: data.smsDriver } : {}),
      ...(data.emailFromName ? { emailFromName: data.emailFromName } : {}),
      // Il testo del tipo scelto vince su quello gia' presente nel job.
      ...(data.emailSubject ? { emailSubject: data.emailSubject } : {}),
      ...(data.emailBody ? { emailBody: data.emailBody } : {}),
      ...(data.smsText ? { smsText: data.smsText } : {}),
      ...(texts?.sms ? { smsText: texts.sms } : {}),
      ...(texts?.emailSubject ? { emailSubject: texts.emailSubject } : {}),
      ...(texts?.emailBody ? { emailBody: texts.emailBody } : {}),
    };
  }

  private async deliverMultichannel(data: any) {
    const startTime = Date.now();
    const channels = data.channels as DeliveryChannel[];

    try {
      const outcome = await this.channelDelivery.deliver({
        tenantId: data.tenantId,
        channels,
        phone: data.phone,
        email: data.email,
        smsDriver: data.smsDriver,
        content: {
          text: data.content,
          subject: data.emailSubject,
          smsText: data.smsText,
          emailBody: data.emailBody,
          emailFromName: data.emailFromName,
        },
        whatsappMinIntervalMs: MIN_INTERVAL_MS,
        rateLimitKey: 'notify',
      });

      this.logger.log(
        `Promemoria consegnato a ${outcome.recipientMasked} via ${outcome.channel}` +
          `${outcome.usedFallback ? ' (canale di riserva)' : ''} per ${data.tenantId}`,
      );

      // Gli stati di consegna WhatsApp arrivano dal webhook e vanno attribuiti
      // al messaggio giusto: stessi metadati del percorso a canale singolo.
      if (outcome.channel === 'whatsapp' && outcome.providerMessageId && data.message_type) {
        await this.redis.set(
          `msg_meta:${data.tenantId}:${outcome.providerMessageId}`,
          JSON.stringify({
            message_type: data.message_type,
            correlation_id: data.correlationId || 'unknown',
            patient_id: data.pazienteId || 'unknown',
            appointment_ids: data.appointmentIds || [],
          }),
          'EX',
          172800,
        );
      }

      await this.auditService.log({
        tenantId: data.tenantId,
        correlationId: data.correlationId || 'PROCESSOR',
        eventType: outcome.usedFallback ? 'MESSAGE_FALLBACK' : 'MESSAGE_DISPATCHED',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'APPOINTMENT', id: data.originalAppointmentId || 'N/A' },
        status: 'SUCCESS',
        payload: {
          recipient: outcome.recipientMasked,
          message_type: data.message_type || 'unknown',
          channel: outcome.channel,
          driver: outcome.driver,
        },
        metadata: {
          processing_time_ms: Date.now() - startTime,
          channel: outcome.channel,
          driver: outcome.driver,
          used_fallback: outcome.usedFallback,
          skipped_channels: outcome.skipped,
          provider_message_id: outcome.providerMessageId,
        },
      });

      return {
        channel: outcome.channel,
        driver: outcome.driver,
        providerMessageId: outcome.providerMessageId,
        usedFallback: outcome.usedFallback,
        message_type: data.message_type,
      };
    } catch (error: any) {
      const noRecipient = error instanceof NoUsableChannelError;

      await this.auditService.log({
        tenantId: data.tenantId,
        correlationId: data.correlationId || 'PROCESSOR',
        eventType: 'ERROR',
        actor: { user_id: 'SYSTEM', ip_address: 'internal' },
        resource: { entity: 'APPOINTMENT', id: data.originalAppointmentId || 'N/A' },
        status: 'FAILED',
        payload: {
          message_type: data.message_type || 'unknown',
          channels,
          skipped: error.skipped ?? [],
          errorMessage: error.message,
        },
        metadata: { processing_time_ms: Date.now() - startTime, no_recipient: noRecipient },
      });

      if (noRecipient) {
        // Ritentare non cambierebbe nulla: il recapito manca in anagrafica.
        this.logger.warn(
          `Promemoria non inviabile per ${data.tenantId}: ${error.message} — nessun ritentativo`,
        );
        return { skipped: true, reason: error.message, message_type: data.message_type };
      }

      throw error;
    }
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
