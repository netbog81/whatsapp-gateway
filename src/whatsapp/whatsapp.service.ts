import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { DateTime } from 'luxon';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/encryption.service';
import { BaoService } from '../auth/bao.service';
import { ReminderEarlyPolicy } from '../dto/dispatch.dto';

/** Margine sul TTL della lista di buffer oltre la finestra di recap (safety-net). */
const RECAP_TTL_MARGIN_SECONDS = 300;

/**
 * Distanza minima che il processor impone fra due messaggi automatici dello
 * stesso tenant (MIN_INTERVAL_MS). Qui serve solo a stimare quanti promemoria
 * stanno in una fascia prima di sforarla, e ad avvisare quando non ci stanno.
 */
const REMINDER_MIN_SPACING_SECONDS = 10;

/** Margine sul TTL del contatore di slot oltre la fine della fascia. */
const REMINDER_SLOT_TTL_MARGIN_SECONDS = 3600;

/**
 * Scarto con cui la notifica di cancellazione si mette in fila DOPO un recap
 * ancora in attesa per lo stesso numero. Basta che i due job diventino
 * eseguibili in ordine: alla distanza vera fra i due invii pensa poi il rate
 * limit del processor.
 */
const CANCEL_AFTER_RECAP_MARGIN_MS = 2000;

/**
 * Stati con cui WhatsApp marca un messaggio in arrivo già visto. `PLAYED` è
 * quello degli audio ascoltati: per noi vale come letto.
 */
const READ_STATUSES = ['READ', 'PLAYED'];

/**
 * Tetto di conversazioni controllate in una singola richiesta: lo stato di
 * lettura si può chiedere a Evolution solo una chat per volta.
 */
const READ_STATE_MAX_CHATS = 60;

/** Verdetto sullo stato di lettura di una conversazione secondo WhatsApp. */
export type ChatReadState = 'read' | 'unread' | 'unknown';

/** Orari di una fascia di invio, in ora locale Europe/Rome. */
interface ReminderWindow {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
}

/** Quando e come è stato collocato un promemoria. */
interface ReminderPlan {
  sendTime: DateTime;
  /** `window` = distribuito nella fascia, `exact_24h` = alle 24h esatte. */
  mode: 'window' | 'exact_24h';
  /** Progressivo del messaggio nella fascia di quel giorno (solo mode=window). */
  slot?: number;
  /** Giorno della fascia usata, YYYY-MM-DD (solo mode=window). */
  windowDay?: string;
}

/** Finestra di raggruppamento recap, se la main-app non ne indica una. */
const RECAP_DEFAULT_DELAY_SECONDS = 60;
const RECAP_MIN_DELAY_SECONDS = 30;
const RECAP_MAX_DELAY_SECONDS = 600;

/**
 * Tetto assoluto allo slittamento della finestra: la finestra riparte a ogni
 * nuovo appuntamento, ma il recap non può essere rimandato all'infinito da una
 * sequenza continua di prenotazioni.
 */
const RECAP_MAX_WINDOW_MS = 15 * 60 * 1000;

/** Messaggio in coda non ancora inviato, esposto alla main-app. */
export interface ScheduledMessage {
  jobId: string;
  jobName: string;
  /** reminder | update_notification | cancel_notification | recap */
  type: string;
  phone: string;
  pazienteId?: string;
  appointmentIds: string[];
  /** Testo già composto. Assente per i recap: si compone allo scadere della finestra. */
  content?: string;
  /** Solo per i recap: appuntamenti già accumulati nel buffer. */
  bufferedCount?: number;
  /** Istante di invio previsto (ISO 8601). */
  scheduledFor: string;
  state: 'delayed' | 'waiting';
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    @InjectQueue('whatsapp-queue') private whatsappQueue: Queue,
    @InjectQueue('callback-webhook') private callbackQueue: Queue,
    @InjectRedis() private readonly redis: Redis,
    private readonly auditService: AuditService,
    private readonly encryptionService: EncryptionService,
    private readonly baoService: BaoService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Token Evolution del tenant, con la stessa cache Redis usata dal processor
   * (`evolution:token:{tenant}`, TTL 1h): la rotazione della chiave invalida
   * quella cache e vale quindi anche per questa via.
   */
  private async getTenantEvolutionToken(tenantId: string): Promise<string | null> {
    const cacheKey = `evolution:token:${tenantId}`;

    const cached = await this.redis.get(cacheKey);
    if (cached) return cached;

    const secret = await this.baoService.getSecret(`whatsapp/${tenantId}/evolution_apikey`);
    if (secret?.api_key) {
      await this.redis.set(cacheKey, secret.api_key, 'EX', 3600);
      return secret.api_key;
    }

    return null;
  }

  /**
   * Ruota la API key Evolution del tenant: scrive il nuovo valore in OpenBao
   * (kv/whatsapp/{tenantId}/evolution_apikey, campo api_key) e invalida subito
   * la cache Redis (evolution:token:{tenantId}, TTL 1h) così processor e test
   * service usano la chiave nuova dal messaggio successivo.
   * La chiave NON viene mai loggata né inclusa nell'audit (solo la lunghezza).
   */
  async updateEvolutionApiKey(
    apiKey: string,
    tenantId: string,
    userId: string,
    ipAddress: string = 'unknown',
  ) {
    const correlationId = uuidv4();
    const actor = { user_id: userId, ip_address: ipAddress };

    try {
      await this.baoService.writeSecret(`whatsapp/${tenantId}/evolution_apikey`, {
        api_key: apiKey,
      });
      await this.redis.del(`evolution:token:${tenantId}`);

      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'EVOLUTION_KEY_UPDATED',
        actor,
        resource: { entity: 'CONFIG', id: 'EVOLUTION_APIKEY' },
        status: 'SUCCESS',
        payload: { keyLength: apiKey.length },
      });

      this.logger.log(`API key Evolution aggiornata per tenant ${tenantId} (cache invalidata)`);
      return { status: 'ok', cacheCleared: true, correlationId };
    } catch (error: any) {
      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'EVOLUTION_KEY_UPDATED',
        actor,
        resource: { entity: 'CONFIG', id: 'EVOLUTION_APIKEY' },
        status: 'FAILED',
        payload: { error: error?.message },
      });
      this.logger.error(`Aggiornamento API key Evolution fallito per tenant ${tenantId}: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Invio di un messaggio di chat scritto a mano dalla segreteria.
   *
   * Percorso volutamente separato da `dispatch`: niente buffer di recap, niente
   * reminder programmati, nessuna nozione di appuntamento. Il job entra nella
   * stessa coda (così resta valido il rate limit per tenant verso Evolution) ma
   * con nome `send-chat`, che il processor tratta come traffico interattivo.
   */
  async sendChatMessage(
    payload: { phone: string; text: string; correlationId?: string; conversationId?: string },
    tenantId: string,
    userId: string,
    ipAddress: string = 'unknown',
  ) {
    const correlationId = payload.correlationId || uuidv4();
    const actor = { user_id: userId, ip_address: ipAddress };

    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'REQUEST_RECEIVED',
      actor,
      resource: { entity: 'DISPATCH', id: 'CHAT_MESSAGE' },
      status: 'PENDING',
      // Il testo NON entra nell'audit: è contenuto sanitario libero, e l'audit
      // ha una retention diversa da quella dei messaggi.
      payload: { phone: payload.phone, textLength: payload.text.length },
    });

    const job = await this.whatsappQueue.add(
      'send-chat',
      {
        tenantId,
        phone: payload.phone,
        content: payload.text,
        correlationId,
        conversationId: payload.conversationId,
        message_type: 'chat_outbound',
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );

    this.logger.log(
      `[CHAT] Messaggio accodato per tenant ${tenantId} → ${payload.phone} (job ${job.id})`,
    );

    return { status: 'queued', jobId: job.id, correlationId };
  }

  /**
   * Non letti per numero secondo WhatsApp, letti da Evolution.
   *
   * Serve ad allineare l'applicativo quando la segreteria lavora da WhatsApp
   * Web: aprendo lì una conversazione il contatore si azzera su WhatsApp, ma
   * nessun evento lo comunica. L'evento `chats.update` di Evolution 2.3.7
   * trasporta solo `remoteJid` e `instanceId` — verificato sulla coda reale —
   * quindi l'unica fonte del dato è questa interrogazione.
   *
   * Il numero non si legge solo dal `remoteJid`: WhatsApp sta migrando agli
   * identificativi mascherati e su questa istanza 1239 chat su 2107 sono già
   * `@lid`. Per quelle il numero vero sta in `lastMessage.key.remoteJidAlt`.
   * Senza questa risoluzione la mappa copriva meno di metà delle chat, e le
   * conversazioni non si allineavano mai.
   *
   * Un numero può comparire due volte, come chat `@lid` e come chat legacy
   * `@s.whatsapp.net`: vince quella aggiornata più di recente, perché la vecchia
   * porta contatori fermi (vista una a 108 su una conversazione già evasa).
   *
   * I contatori `null` NON entrano nella mappa: significano "non lo so", non
   * "zero", e 345 chat su 1151 sono in quello stato. Trattarli come zero
   * spegnerebbe il pallino su conversazioni davvero non lette.
   */
  async getUnreadCounts(tenantId: string): Promise<Record<string, number>> {
    const chats = await this.fetchChats(tenantId);

    const freshest = new Map<string, any>();
    for (const chat of chats) {
      const phone = this.resolveChatPhone(chat);
      if (!phone) continue;

      const current = freshest.get(phone);
      if (!current || (chat?.updatedAt ?? '') > (current?.updatedAt ?? '')) {
        freshest.set(phone, chat);
      }
    }

    const counts: Record<string, number> = {};
    for (const [phone, chat] of freshest) {
      const unread = chat?.unreadCount;
      if (typeof unread !== 'number') continue;
      counts[phone] = unread;
    }

    return counts;
  }

  /**
   * Stato di lettura delle conversazioni indicate, secondo WhatsApp.
   *
   * Due fonti, in ordine di attendibilità:
   *  1. `unreadCount` della chat, quando è un numero. Spesso è `null` — su
   *     questa istanza per ~30% delle chat — e allora non dice nulla.
   *  2. lo storico di stato dei messaggi (`findStatusMessage`), che contiene
   *     anche record sui messaggi IN ARRIVO: quando la segreteria ne legge uno,
   *     da WhatsApp Web o dal telefono, compare `fromMe: false, status: READ`.
   *     È l'unico segnale che copre il caso "letto ma non risposto".
   *
   * Vincoli dell'API, verificati sull'istanza: si può filtrare SOLO per
   * `remoteJid` (i filtri su `fromMe`/`status` vengono ignorati), e il
   * `remoteJid` da usare è quello corrente — interrogare col numero quando la
   * chat è passata a `@lid` non restituisce niente.
   */
  async getChatReadStates(
    tenantId: string,
    items: { phone: string; messageId?: string }[],
  ): Promise<Record<string, ChatReadState>> {
    const chats = await this.fetchChats(tenantId);

    const freshest = new Map<string, any>();
    for (const chat of chats) {
      const phone = this.resolveChatPhone(chat);
      if (!phone) continue;
      const current = freshest.get(phone);
      if (!current || (chat?.updatedAt ?? '') > (current?.updatedAt ?? '')) {
        freshest.set(phone, chat);
      }
    }

    const wanted = items.slice(0, READ_STATE_MAX_CHATS);
    if (items.length > wanted.length) {
      this.logger.warn(
        `[READ-STATE] ${items.length} conversazioni richieste, ne controllo ${wanted.length}: ` +
          'le altre restano da controllare al giro successivo.',
      );
    }

    const states: Record<string, ChatReadState> = {};

    for (const item of wanted) {
      const chat = freshest.get(item.phone);
      if (!chat) {
        states[item.phone] = 'unknown';
        continue;
      }

      if (chat.unreadCount === 0) {
        states[item.phone] = 'read';
        continue;
      }

      if (!item.messageId) {
        states[item.phone] = typeof chat.unreadCount === 'number' ? 'unread' : 'unknown';
        continue;
      }

      const read = await this.isInboundMessageRead(
        tenantId,
        chat.remoteJid,
        item.messageId,
      );
      states[item.phone] = read
        ? 'read'
        : typeof chat.unreadCount === 'number'
          ? 'unread'
          : 'unknown';
    }

    return states;
  }

  /** Chat del tenant secondo Evolution. */
  private async fetchChats(tenantId: string): Promise<any[]> {
    const evolutionUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const token = await this.getTenantEvolutionToken(tenantId);
    if (!token) {
      throw new Error(`Nessun token Evolution trovato per il tenant ${tenantId}`);
    }

    const response = await firstValueFrom(
      this.httpService.post(
        `${evolutionUrl}/chat/findChats/${tenantId}`,
        {},
        { headers: { apikey: token }, timeout: 15000 },
      ),
    );

    const data = response.data;
    return Array.isArray(data) ? data : (data?.chats ?? data?.data ?? []);
  }

  /**
   * True se quel messaggio in arrivo risulta letto su WhatsApp.
   *
   * `PLAYED` vale quanto `READ`: è lo stato degli audio ascoltati, che per il
   * paziente e per noi significa comunque "visto".
   */
  private async isInboundMessageRead(
    tenantId: string,
    remoteJid: string | undefined,
    messageId: string,
  ): Promise<boolean> {
    if (!remoteJid) return false;

    const evolutionUrl = this.configService.get<string>('EVOLUTION_API_URL');
    const token = await this.getTenantEvolutionToken(tenantId);
    if (!token) return false;

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${evolutionUrl}/chat/findStatusMessage/${tenantId}`,
          { where: { remoteJid } },
          { headers: { apikey: token }, timeout: 15000 },
        ),
      );

      const data = response.data;
      const records: any[] = Array.isArray(data) ? data : (data?.records ?? []);

      return records.some(
        (record) =>
          record?.fromMe === false &&
          READ_STATUSES.includes(String(record?.status)) &&
          String(record?.keyId) === String(messageId),
      );
    } catch (error: any) {
      this.logger.warn(
        `[READ-STATE] Lettura stato messaggi fallita per ${remoteJid}: ${error?.message}`,
      );
      return false;
    }
  }

  /**
   * Numero di telefono di una chat, sia che WhatsApp la indirizzi col numero
   * sia con un identificativo mascherato. Gruppi (`@g.us`) e chat senza un
   * numero risolvibile restano fuori: non hanno una conversazione
   * corrispondente nell'applicativo.
   */
  private resolveChatPhone(chat: any): string | null {
    const candidates = [chat?.remoteJid, chat?.lastMessage?.key?.remoteJidAlt];

    for (const jid of candidates) {
      if (typeof jid !== 'string' || !jid.endsWith('@s.whatsapp.net')) continue;
      const phone = jid.split('@')[0];
      if (/^\d+$/.test(phone)) return phone;
    }

    return null;
  }

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
      case 'APPOINTMENT_UPDATE':
        return this.handleUpdate(payload, tenantId, correlationId, actor);
      case 'INTERNAL_TASK':
        return this.handleInternalTask(payload, tenantId, correlationId, actor);
      default:
        this.logger.warn(`Tipo dispatch non gestito: ${payload.type}`);
        throw new Error(`Tipo dispatch non supportato: ${payload.type}`);
    }
  }

  /**
   * Messaggi programmati e non ancora inviati per il tenant: reminder 24h,
   * notifiche di spostamento/cancellazione in attesa e recap ancora dentro la
   * finestra di raggruppamento.
   *
   * Le code sono condivise fra i tenant, quindi si filtra sempre per
   * `data.tenantId`: un tenant non deve mai vedere i messaggi di un altro.
   */
  async listScheduled(tenantId: string): Promise<ScheduledMessage[]> {
    const [delayed, waiting] = await Promise.all([
      this.whatsappQueue.getDelayed(0, 500),
      this.whatsappQueue.getWaiting(0, 500),
    ]);

    const mine = [
      ...delayed.map(job => ({ job, state: 'delayed' as const })),
      ...waiting.map(job => ({ job, state: 'waiting' as const })),
    ].filter(({ job }) => job.data?.tenantId === tenantId);

    const messages = await Promise.all(
      mine.map(({ job, state }) => this.toScheduledMessage(job, state)),
    );

    return messages
      .filter((m): m is ScheduledMessage => m !== null)
      .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  }

  private async toScheduledMessage(
    job: Job,
    state: 'delayed' | 'waiting',
  ): Promise<ScheduledMessage | null> {
    if (!job.id) return null;
    const data = job.data ?? {};
    const scheduledFor = new Date(job.timestamp + (job.delay ?? 0)).toISOString();

    if (job.name === 'process-recap') {
      // Il testo non esiste ancora: viene composto allo scadere della finestra,
      // con gli appuntamenti accumulati fino a quel momento.
      const bufferedCount = await this.redis.llen(`pending:${data.tenantId}:${data.phone}`);
      return {
        jobId: job.id,
        jobName: job.name,
        type: 'recap',
        phone: data.phone,
        pazienteId: data.pazienteId,
        appointmentIds: [],
        bufferedCount,
        scheduledFor,
        state,
      };
    }

    return {
      jobId: job.id,
      jobName: job.name,
      type: data.message_type ?? 'reminder',
      phone: data.phone,
      pazienteId: data.pazienteId,
      appointmentIds: data.appointmentIds ?? [],
      content: data.content,
      scheduledFor,
      state,
    };
  }

  /**
   * Annulla un singolo invio programmato. Il job resta identificato dal suo id
   * BullMQ, ma prima di rimuoverlo si verifica che appartenga al tenant che lo
   * sta chiedendo.
   */
  async cancelScheduled(
    jobId: string,
    tenantId: string,
    userId: string,
    ipAddress: string = 'unknown',
  ): Promise<{ status: 'cancelled' | 'not_found'; message?: ScheduledMessage }> {
    const correlationId = uuidv4();
    const actor = { user_id: userId, ip_address: ipAddress };

    const job = await this.whatsappQueue.getJob(jobId);
    if (!job || job.data?.tenantId !== tenantId) {
      // Stessa risposta per "non esiste" e "non è tuo": non si conferma a un
      // tenant l'esistenza di un job altrui.
      return { status: 'not_found' };
    }

    const snapshot = await this.toScheduledMessage(job, 'delayed');
    await job.remove();

    if (job.name === 'process-recap') {
      // Il timer se ne va: senza buffer non resta nulla da inviare.
      await this.redis.del(
        `pending:${tenantId}:${job.data.phone}`,
        `recap_start:${tenantId}:${job.data.phone}`,
      );
    }

    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'SCHEDULED_MESSAGE_CANCELLED',
      actor,
      resource: {
        entity: 'APPOINTMENT',
        id: job.data?.originalAppointmentId ?? job.data?.pazienteId ?? 'N/A',
      },
      status: 'SUCCESS',
      payload: { jobId, jobName: job.name, messageType: job.data?.message_type },
    });

    this.logger.log(`Invio programmato ${jobId} annullato dal tenant ${tenantId}`);
    return { status: 'cancelled', message: snapshot ?? undefined };
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
    const { pazienteId, phone, recapMessage, recapDelaySeconds } = payload.data;
    const delaySeconds = this.resolveRecapDelaySeconds(recapDelaySeconds);

    // Recap chiesto a mano dalla segreteria: parte subito, senza passare dal
    // buffer. Chi preme il pulsante guarda il telefono del paziente aspettando
    // che arrivi; farlo aspettare la finestra di raggruppamento (fino a 10
    // minuti col valore massimo) equivale, per lui, a un pulsante rotto.
    if (payload.data.recapImmediate === true) {
      await this.sendRecapNow(payload.data, tenantId, correlationId);
      await this.scheduleReminder(payload.data, tenantId, correlationId, actor);
      return;
    }

    // 1. LOGICA RECAP (buffer configurabile dal tenant) — dati cifrati AES-256.
    // La chiave di raggruppamento è il NUMERO DI TELEFONO, non il pazienteId:
    // è il destinatario reale del messaggio e resta stabile anche per i walk-in
    // senza anagrafica, che altrimenti avrebbero un id diverso per ogni
    // appuntamento e non verrebbero mai raggruppati in un recap multiplo.
    const recapKey = `pending:${tenantId}:${phone}`;
    const encryptedData = this.encryptionService.encrypt(JSON.stringify(payload.data));
    await this.redis.rpush(recapKey, encryptedData);
    await this.redis.expire(recapKey, delaySeconds + RECAP_TTL_MARGIN_SECONDS);

    await this.scheduleRecap({
      tenantId,
      phone,
      pazienteId,
      correlationId,
      recapMessage,
      delayMs: delaySeconds * 1000,
    });

    // 2. LOGICA REMINDER 24H
    await this.scheduleReminder(payload.data, tenantId, correlationId, actor);
  }

  /**
   * Ritardo con cui accodare la notifica di cancellazione perché non scavalchi
   * un recap ancora in attesa per lo stesso numero.
   *
   * Il recap è un job ritardato: parte alla fine della finestra. La
   * cancellazione invece parte subito, e senza questo correttivo arriverebbe
   * al paziente prima della conferma di appuntamenti che aveva preso PRIMA di
   * disdire. Torna 0 quando non c'è nulla in attesa, o quando il recap sta già
   * partendo: in quel caso ci pensa la coda, che è FIFO con un solo worker.
   */
  private async delayBehindPendingRecap(tenantId: string, phone: string): Promise<number> {
    if (!phone) return 0;

    const timer = await this.whatsappQueue.getJob(`timer-recap:${tenantId}:${phone}`);
    if (!timer) return 0;

    const remaining = timer.timestamp + (timer.delay ?? 0) - Date.now();
    return remaining > 0 ? remaining + CANCEL_AFTER_RECAP_MARGIN_MS : 0;
  }

  /**
   * Toglie un appuntamento dal buffer di recap non ancora partito.
   *
   * Torna true solo se l'appuntamento c'era davvero: significa che il recap
   * non è mai uscito e quindi il paziente non sa nulla di quella prenotazione.
   *
   * Se il buffer resta vuoto sparisce anche il timer, altrimenti scatterebbe
   * a vuoto; se invece restano altri appuntamenti dello stesso numero il recap
   * parte regolarmente, con i soli appuntamenti ancora validi.
   */
  private async dropFromRecapBuffer(
    tenantId: string,
    phone: string,
    appointmentId: string,
  ): Promise<boolean> {
    if (!phone || !appointmentId) return false;

    const recapKey = `pending:${tenantId}:${phone}`;
    const buffered = await this.redis.lrange(recapKey, 0, -1);
    if (buffered.length === 0) return false;

    let removed = 0;
    for (const raw of buffered) {
      let parsed: any;
      try {
        parsed = JSON.parse(this.encryptionService.decrypt(raw));
      } catch {
        try {
          parsed = JSON.parse(raw); // dati non cifrati (migrazione)
        } catch {
          continue;
        }
      }

      if (String(parsed?.appointmentId) !== String(appointmentId)) continue;
      // LREM per valore esatto: la stringa cifrata è quella che sta nella
      // lista, quindi identifica la voce senza ambiguità.
      removed += await this.redis.lrem(recapKey, 1, raw);
    }

    if (removed === 0) return false;

    if ((await this.redis.llen(recapKey)) === 0) {
      await this.redis.del(recapKey, `recap_start:${tenantId}:${phone}`);
      const timer = await this.whatsappQueue.getJob(`timer-recap:${tenantId}:${phone}`);
      if (timer) {
        // Può essere già in esecuzione: in quel caso il buffer è appena stato
        // svuotato dal processor e non c'è nulla da rimuovere.
        await timer.remove().catch(() => undefined);
      }
    }

    return true;
  }

  /**
   * Accoda subito il recap di un singolo appuntamento, senza buffer.
   *
   * Non tocca `pending:{tenant}:{phone}`: un recap immediato non deve né
   * finire dentro un raggruppamento in corso né farne partire uno, altrimenti
   * il messaggio manuale si fonderebbe con le prenotazioni di quel momento.
   */
  private async sendRecapNow(
    data: any,
    tenantId: string,
    correlationId: string,
  ): Promise<void> {
    const { pazienteId, phone, appointmentId, recapMessage, name, date } = data;

    const content = recapMessage ?? this.buildSingleRecapFallback(name, date);

    await this.whatsappQueue.add(
      'send-reminder',
      {
        tenantId,
        phone,
        content,
        correlationId,
        pazienteId,
        originalAppointmentId: appointmentId,
        appointmentIds: appointmentId ? [appointmentId] : [],
        // Stesso tipo del recap singolo prodotto dal buffer: la main-app
        // riconcilia i propri log per message_type e non deve vedere una
        // categoria nuova solo perché l'invio è partito da un pulsante.
        message_type: 'single_recap',
      },
      { removeOnComplete: true },
    );

    this.logger.log(`[RECAP] Invio immediato richiesto per ${phone} (tenant ${tenantId})`);
  }

  /** Testo di ripiego se la main-app non ha mandato il proprio template. */
  private buildSingleRecapFallback(name?: string, date?: string): string {
    const dt = date ? DateTime.fromISO(date, { zone: 'Europe/Rome' }) : null;

    return dt?.isValid
      ? `Gentile ${name ?? ''}, confermiamo il suo appuntamento per il ${dt.toFormat('dd/MM/yyyy')} alle ${dt.toFormat('HH:mm')}.`.replace(
          'Gentile , ',
          'Gentile paziente, ',
        )
      : `Gentile ${name ?? 'paziente'}, confermiamo il suo appuntamento.`;
  }

  /** Finestra di recap richiesta dal tenant, normalizzata nei limiti ammessi. */
  private resolveRecapDelaySeconds(raw: unknown): number {
    const value = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return RECAP_DEFAULT_DELAY_SECONDS;
    }
    return Math.min(RECAP_MAX_DELAY_SECONDS, Math.max(RECAP_MIN_DELAY_SECONDS, Math.round(value)));
  }

  /**
   * Programma il flush del buffer di recap con finestra SCORREVOLE: ogni nuovo
   * appuntamento per lo stesso numero fa ripartire il conteggio, così
   * l'operatore non è costretto a chiudere la prenotazione entro la prima
   * finestra.
   *
   * Lo slittamento non è illimitato: `recap_start:{tenant}:{phone}` marca
   * l'istante del primo appuntamento del gruppo e oltre `min(5 × finestra,
   * 15 min)` il recap parte comunque, altrimenti una sequenza continua di
   * prenotazioni lo rimanderebbe per sempre.
   */
  private async scheduleRecap(params: {
    tenantId: string;
    phone: string;
    pazienteId: string;
    correlationId: string;
    recapMessage?: string;
    delayMs: number;
  }): Promise<void> {
    const { tenantId, phone, pazienteId, correlationId, recapMessage, delayMs } = params;
    const jobId = `timer-recap:${tenantId}:${phone}`;
    const jobData = { tenantId, pazienteId, phone, correlationId, recapMessage };

    const existing = await this.whatsappQueue.getJob(jobId);
    if (!existing) {
      // Primo appuntamento del gruppo: apre la finestra.
      await this.redis.set(
        `recap_start:${tenantId}:${phone}`,
        Date.now().toString(),
        'EX',
        Math.ceil((RECAP_MAX_WINDOW_MS + delayMs) / 1000),
      );
      await this.whatsappQueue.add('process-recap', jobData, {
        delay: delayMs,
        jobId,
        removeOnComplete: true,
      });
      return;
    }

    const now = Date.now();
    const startRaw = await this.redis.get(`recap_start:${tenantId}:${phone}`);
    const windowStart = startRaw ? parseInt(startRaw, 10) : now;
    const maxWindowMs = Math.min(delayMs * 5, RECAP_MAX_WINDOW_MS);
    const remainingMs = maxWindowMs - (now - windowStart);

    if (remainingMs <= 0) {
      // Tetto raggiunto: il job già programmato parte senza ulteriori rinvii.
      this.logger.debug(`Recap ${tenantId}/${phone}: tetto finestra raggiunto, nessun rinvio`);
      return;
    }

    const newDelay = Math.min(delayMs, remainingMs);
    try {
      await existing.remove();
      await this.whatsappQueue.add('process-recap', jobData, {
        delay: newDelay,
        jobId,
        removeOnComplete: true,
      });
    } catch (error: any) {
      // Il job era già in esecuzione (sta svuotando il buffer): non è
      // rimovibile. Ne accodo uno con id distinto così l'appuntamento appena
      // bufferizzato viene comunque recapitato.
      this.logger.warn(
        `Recap ${tenantId}/${phone} non riprogrammabile (${error?.message}): accodo un job separato`,
      );
      await this.whatsappQueue.add('process-recap', jobData, {
        delay: newDelay,
        jobId: `${jobId}:${now}`,
        removeOnComplete: true,
      });
    }
  }

  /**
   * Programma (o riprogramma) il promemoria per un appuntamento.
   * jobId deterministico `reminder:{tenant}:{appointment}`: prima di rischedulare
   * va rimosso il job esistente, altrimenti BullMQ ignora il nuovo inserimento.
   *
   * L'istante di invio lo decide `resolveReminderPlan`: alle 24h esatte se il
   * tenant non ha configurato una fascia, altrimenti distribuito dentro la
   * fascia del giorno prima. Se non resta nulla di programmabile (appuntamento
   * troppo vicino) non viene accodato niente.
   */
  private async scheduleReminder(
    data: any,
    tenantId: string,
    correlationId: string,
    actor: { user_id: string; ip_address: string },
  ): Promise<boolean> {
    const { pazienteId, appointmentId, phone, date, reminderMessage, reminderMessageEarly } = data;

    const appointmentDt = DateTime.fromISO(date, { zone: 'Europe/Rome' });
    const plan = await this.resolveReminderPlan(data, tenantId, appointmentDt);
    if (!plan) return false;

    const delay = plan.sendTime.diffNow().as('milliseconds');
    if (delay <= 0) return false;

    // Il testo dipende da QUANDO parte, non da quando è stato prenotato: due
    // giorni prima "domani" sarebbe falso, e il tenant per quel caso ha un
    // template dedicato (REMINDER_48H).
    const daysAhead = this.daysBetween(plan.sendTime, appointmentDt);
    const content =
      (daysAhead >= 2 ? reminderMessageEarly : undefined) ??
      reminderMessage ??
      this.buildDefaultReminderText(appointmentDt, plan.sendTime);

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
      // mode/slot/windowDay servono a ricostruire a posteriori PERCHÉ un
      // promemoria è partito a quell'ora: è il dato che regge la contestazione
      // di una disdetta fuori termine.
      payload: {
        sendTime: plan.sendTime.toISO(),
        appointmentTime: appointmentDt.toISO(),
        hoursBefore: Math.round(appointmentDt.diff(plan.sendTime).as('hours') * 10) / 10,
        mode: plan.mode,
        ...(plan.slot !== undefined ? { slot: plan.slot } : {}),
        ...(plan.windowDay ? { windowDay: plan.windowDay } : {}),
      },
    });

    return true;
  }

  /**
   * Decide l'istante di invio del promemoria.
   *
   * Senza fascia configurata resta il comportamento storico (24h esatte prima).
   * Con la fascia il promemoria parte il giorno prima dentro l'intervallo
   * indicato, in uno slot distribuito (vedi `allocateWindowSlot`).
   *
   * Il caso limite sono gli appuntamenti che iniziano PRIMA della fine della
   * fascia: per loro la fascia del giorno prima cadrebbe a meno di 24h
   * dall'appuntamento — cioè proprio sotto la soglia per cui la fascia esiste.
   * Lì decide `reminderEarlyPolicy`.
   *
   * Torna null quando non c'è più nulla da programmare (tutti gli istanti
   * candidati sono già passati), come già faceva la versione a 24h fisse.
   */
  private async resolveReminderPlan(
    data: any,
    tenantId: string,
    appointmentDt: DateTime,
  ): Promise<ReminderPlan | null> {
    const exact = appointmentDt.minus({ hours: 24 });
    const exactPlan = (): ReminderPlan | null =>
      exact > DateTime.now() ? { sendTime: exact, mode: 'exact_24h' } : null;

    const window = this.parseReminderWindow(
      data.reminderWindowStart,
      data.reminderWindowEnd,
    );
    if (!window) return exactPlan();

    let dayOffset = 1;

    // La fascia del giorno prima garantisce le 24h solo se la sua FINE cade
    // almeno 24h prima dell'appuntamento.
    if (this.windowBoundOn(appointmentDt, 1, window, 'end') > exact) {
      switch (this.resolveEarlyPolicy(data.reminderEarlyPolicy)) {
        case ReminderEarlyPolicy.EXACT_24H:
          return exactPlan();
        case ReminderEarlyPolicy.FORCE_WINDOW:
          break; // resta la fascia del giorno prima, sotto le 24h di preavviso
        case ReminderEarlyPolicy.SHIFT_PREVIOUS_DAY:
        default:
          dayOffset = 2; // arretra di un giorno: le 24h restano garantite
      }
    }

    const windowStart = this.windowBoundOn(appointmentDt, dayOffset, window, 'start');
    const windowEnd = this.windowBoundOn(appointmentDt, dayOffset, window, 'end');

    // Fascia già aperta o già passata al momento della prenotazione: la
    // distribuzione di quel giorno è ormai in corso e infilarcisi dentro
    // sposterebbe il messaggio a ridosso del recap appena inviato. Si ripiega
    // sulle 24h esatte, e se anche quelle sono passate non si programma nulla
    // (come già oggi per le prenotazioni sotto le 24h).
    if (windowStart <= DateTime.now()) return exactPlan();

    const { sendTime, slot } = await this.allocateWindowSlot(tenantId, windowStart, windowEnd);
    return { sendTime, mode: 'window', slot, windowDay: windowStart.toISODate() ?? undefined };
  }

  /** Politica richiesta dal tenant, con fallback sulla più prudente. */
  private resolveEarlyPolicy(raw: unknown): ReminderEarlyPolicy {
    return Object.values(ReminderEarlyPolicy).includes(raw as ReminderEarlyPolicy)
      ? (raw as ReminderEarlyPolicy)
      : ReminderEarlyPolicy.SHIFT_PREVIOUS_DAY;
  }

  /** Estremo della fascia sul giorno `dayOffset` giorni prima dell'appuntamento. */
  private windowBoundOn(
    appointmentDt: DateTime,
    dayOffset: number,
    window: ReminderWindow,
    bound: 'start' | 'end',
  ): DateTime {
    // minus({days}) è aritmetica di calendario: attraversando il cambio di ora
    // legale resta lo stesso orario di parete, che è quello che il tenant ha
    // configurato.
    return appointmentDt.minus({ days: dayOffset }).set({
      hour: bound === 'start' ? window.startHour : window.endHour,
      minute: bound === 'start' ? window.startMinute : window.endMinute,
      second: 0,
      millisecond: 0,
    });
  }

  /** Fascia valida, o null per ricadere sulle 24h esatte. */
  private parseReminderWindow(rawStart: unknown, rawEnd: unknown): ReminderWindow | null {
    const start = this.parseHhMm(rawStart);
    const end = this.parseHhMm(rawEnd);
    if (!start || !end) return null;

    if (end.hour * 60 + end.minute <= start.hour * 60 + start.minute) {
      this.logger.warn(
        `Fascia promemoria incoerente (${rawStart}-${rawEnd}): ignorata, uso le 24h esatte`,
      );
      return null;
    }

    return {
      startHour: start.hour,
      startMinute: start.minute,
      endHour: end.hour,
      endMinute: end.minute,
    };
  }

  private parseHhMm(value: unknown): { hour: number; minute: number } | null {
    const match = typeof value === 'string' ? value.match(/^([01]\d|2[0-3]):([0-5]\d)$/) : null;
    return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
  }

  /**
   * Assegna al promemoria un istante dentro la fascia, distribuendo gli invii.
   *
   * Il contatore `wa:rem-slot:{tenant}:{giorno}` dà il progressivo del messaggio
   * in quella fascia. L'istante viene calcolato QUI, alla prenotazione, e non da
   * un job che smista all'apertura della fascia: così ogni promemoria resta un
   * delayed job con un orario reale, visibile e annullabile dalla segreteria
   * nella vista "Programmati" anche settimane prima.
   */
  private async allocateWindowSlot(
    tenantId: string,
    windowStart: DateTime,
    windowEnd: DateTime,
  ): Promise<{ sendTime: DateTime; slot: number }> {
    const day = windowStart.toISODate();
    const key = `wa:rem-slot:${tenantId}:${day}`;

    const slot = await this.redis.incr(key);
    await this.redis.expire(
      key,
      Math.max(60, Math.ceil(windowEnd.diffNow().as('seconds')) + REMINDER_SLOT_TTL_MARGIN_SECONDS),
    );

    const durationMs = windowEnd.diff(windowStart).as('milliseconds');

    if (slot * REMINDER_MIN_SPACING_SECONDS * 1000 > durationMs) {
      this.logger.warn(
        `Fascia promemoria ${day} di ${tenantId}: ${slot} messaggi non stanno in ` +
          `${Math.round(durationMs / 60000)} minuti alla distanza minima di ` +
          `${REMINDER_MIN_SPACING_SECONDS}s. Gli ultimi usciranno dopo la fine della fascia: allargala.`,
      );
    }

    return {
      slot,
      sendTime: windowStart.plus({
        milliseconds: Math.round(this.spreadOffsetMs(slot - 1, durationMs)),
      }),
    };
  }

  /**
   * Posizione dell'n-esimo promemoria (0-based) dentro una fascia lunga
   * `durationMs`.
   *
   * Quante prenotazioni arriveranno per quel giorno non è noto adesso: la
   * fascia viene quindi suddivisa progressivamente (sequenza di van der Corput
   * in base 2), così che i primi messaggi cadano nelle metà, poi nei quarti,
   * poi negli ottavi. Comunque si fermi il conteggio, gli invii restano sparsi
   * su tutta la fascia invece di addensarsi all'inizio.
   *
   * Dentro la cella assegnata l'istante è casuale: l'intervallo fra un invio e
   * l'altro non è mai costante, che è ciò che evita il pattern da bot (stessa
   * logica del jitter già applicato dal processor).
   */
  private spreadOffsetMs(slotIndex: number, durationMs: number): number {
    if (slotIndex <= 0) return Math.random() * durationMs;

    const level = Math.floor(Math.log2(slotIndex)) + 1;
    const cellWidth = durationMs / 2 ** level;
    return this.reverseBits(slotIndex, level) * cellWidth + Math.random() * cellWidth;
  }

  private reverseBits(value: number, bits: number): number {
    let out = 0;
    for (let i = 0; i < bits; i++) {
      out = (out << 1) | ((value >> i) & 1);
    }
    return out;
  }

  /**
   * Testo di ripiego, usato solo se la main-app non ha mandato il template del
   * tenant. Con la politica SHIFT_PREVIOUS_DAY il promemoria può partire due
   * giorni prima, quindi "domani" va scritto solo quando è davvero domani.
   */
  private buildDefaultReminderText(appointmentDt: DateTime, sendTime: DateTime): string {
    const time = appointmentDt.toFormat('HH:mm');

    return this.daysBetween(sendTime, appointmentDt) === 1
      ? `Promemoria: Appuntamento domani alle ${time}`
      : `Promemoria: Appuntamento il ${appointmentDt.toFormat('dd/MM/yyyy')} alle ${time}`;
  }

  /** Giorni di calendario fra due istanti: 1 = "domani", 2 = "dopodomani". */
  private daysBetween(from: DateTime, to: DateTime): number {
    return Math.round(to.startOf('day').diff(from.startOf('day'), 'days').days);
  }

  /**
   * Modifica di un appuntamento già prenotato: annulla il reminder sul vecchio
   * orario, invia (se richiesto) la notifica di spostamento e riprogramma il
   * reminder 24h sul nuovo orario.
   *
   * La notifica NON passa dal buffer recap: una modifica è un evento singolo e
   * accorparla ad altre prenotazioni renderebbe il messaggio incomprensibile.
   */
  private async handleUpdate(payload: any, tenantId: string, correlationId: string, actor: { user_id: string; ip_address: string }) {
    const { appointmentId, pazienteId, phone, name, date, updateMessage, sendUpdateNotification } = payload.data;

    // 1. Il reminder programmato punta al vecchio orario: va sempre rimosso.
    const jobId = `reminder:${tenantId}:${appointmentId}`;
    const oldJob = await this.whatsappQueue.getJob(jobId);
    if (oldJob) {
      await oldJob.remove();
      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'REMINDER_CANCELLED',
        actor,
        resource: { entity: 'APPOINTMENT', id: appointmentId },
        status: 'SUCCESS',
        payload: { jobId, reason: 'APPOINTMENT_UPDATE' },
      });
    }

    // 2. Notifica di modifica al paziente (default: sì, salvo esplicito false)
    let notification: 'queued' | 'disabled' = 'disabled';
    if (sendUpdateNotification !== false) {
      let content = updateMessage;
      if (!content) {
        const dt = DateTime.fromISO(date, { zone: 'Europe/Rome' });
        content = `Gentile ${name}, il suo appuntamento è stato spostato al ${dt.toFormat('dd/MM/yyyy')} alle ${dt.toFormat('HH:mm')}.`;
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
          message_type: 'update_notification',
        },
        { removeOnComplete: true },
      );
      notification = 'queued';
    }

    // 3. Reminder 24h riprogrammato sul nuovo orario
    const rescheduled = await this.scheduleReminder(payload.data, tenantId, correlationId, actor);

    await this.auditService.log({
      tenantId,
      correlationId,
      eventType: 'APPOINTMENT_UPDATED',
      actor,
      resource: { entity: 'APPOINTMENT', id: appointmentId },
      status: 'SUCCESS',
      payload: { notification, rescheduled, previousReminderRemoved: !!oldJob },
    });

    return {
      status: 'queued',
      updateNotification: notification,
      reminder: rescheduled ? 'rescheduled' : 'not_scheduled',
    };
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

    // Appuntamento disdetto mentre il recap è ancora nel buffer: il paziente
    // non ha ricevuto nulla, quindi non c'è nulla da smentire. Si toglie
    // l'appuntamento dal buffer e si tace — invece di mandargli conferma e
    // cancellazione a distanza di secondi.
    const recapSuppressed = await this.dropFromRecapBuffer(tenantId, phone, appointmentId);
    if (recapSuppressed) {
      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'RECAP_SUPPRESSED',
        actor,
        resource: { entity: 'APPOINTMENT', id: appointmentId },
        status: 'SUCCESS',
        payload: { phone, reason: 'CANCELLED_WITHIN_BUFFER' },
      });

      this.logger.log(
        `[RECAP] Appuntamento ${appointmentId} disdetto dentro la finestra: nessun messaggio inviato`,
      );

      return {
        status: reminderStatus,
        cancelNotification: 'suppressed',
        recapSuppressed: true,
      };
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

      // Se per lo stesso numero c'è ancora un recap in attesa, la cancellazione
      // gli va DOPO: quegli appuntamenti erano stati presi prima della disdetta
      // e leggere "cancellato" prima di "confermiamo" è incomprensibile.
      const delay = await this.delayBehindPendingRecap(tenantId, phone);

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
        { removeOnComplete: true, ...(delay > 0 ? { delay } : {}) },
      );

      await this.auditService.log({
        tenantId,
        correlationId,
        eventType: 'CANCEL_NOTIFICATION_QUEUED',
        actor,
        resource: { entity: 'APPOINTMENT', id: appointmentId },
        status: 'SUCCESS',
        payload: { phone, ...(delay > 0 ? { delayedBehindRecapMs: delay } : {}) },
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
