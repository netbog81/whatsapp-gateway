import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import { DateTime } from 'luxon';
import { WhatsappService } from './whatsapp.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/encryption.service';
import { BaoService } from '../auth/bao.service';

describe('WhatsappService', () => {
  let service: WhatsappService;
  let mockQueue: any;
  let mockCallbackQueue: any;
  let mockRedis: any;
  let mockAuditService: any;
  let mockEncryptionService: any;
  let mockBaoService: any;
  let mockHttpService: any;
  let mockConfigService: any;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({}),
      getJob: jest.fn(),
    };

    mockCallbackQueue = {
      add: jest.fn().mockResolvedValue({}),
    };

    mockBaoService = {
      writeSecret: jest.fn().mockResolvedValue(undefined),
      getSecret: jest.fn().mockResolvedValue({ api_key: 'k' }),
    };

    // INCR con stato: il progressivo di slot dentro la fascia dei promemoria
    // deve crescere davvero, altrimenti tutti gli invii finirebbero nello
    // stesso punto e i test sulla distribuzione non direbbero nulla.
    const counters: Record<string, number> = {};

    mockRedis = {
      rpush: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      incr: jest.fn().mockImplementation(async (key: string) => (counters[key] = (counters[key] ?? 0) + 1)),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    // Usati solo da getUnreadCounts, che interroga Evolution.
    mockHttpService = {
      post: jest.fn().mockReturnValue(of({ data: [] })),
      get: jest.fn().mockReturnValue(of({ data: [] })),
    };

    mockConfigService = {
      get: jest.fn().mockReturnValue('http://evolution.test'),
    };

    mockEncryptionService = {
      encrypt: jest.fn().mockImplementation((s: string) => `encrypted:${s}`),
      decrypt: jest.fn().mockImplementation((s: string) => s.replace('encrypted:', '')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        { provide: getQueueToken('whatsapp-queue'), useValue: mockQueue },
        { provide: getQueueToken('callback-webhook'), useValue: mockCallbackQueue },
        { provide: 'default_IORedisModuleConnectionToken', useValue: mockRedis },
        { provide: AuditService, useValue: mockAuditService },
        { provide: EncryptionService, useValue: mockEncryptionService },
        { provide: BaoService, useValue: mockBaoService },
        { provide: HttpService, useValue: mockHttpService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<WhatsappService>(WhatsappService);
  });

  describe('dispatch', () => {
    it('dovrebbe loggare REQUEST_RECEIVED con schema audit completo', async () => {
      const payload = {
        type: 'APPOINTMENT_BOOKING',
        data: {
          appointmentId: '123',
          pazienteId: 'paz_1',
          phone: '393471234567',
          date: '2026-12-15T10:30:00Z',
          name: 'Mario Rossi',
        },
      };

      await service.dispatch(payload, 'tenant-1', 'user-1', '192.168.1.10');

      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          eventType: 'REQUEST_RECEIVED',
          actor: { user_id: 'user-1', ip_address: '192.168.1.10' },
          status: 'PENDING',
        }),
      );
    });

    it('dovrebbe cifrare i dati del paziente prima di rpush', async () => {
      const payload = {
        type: 'APPOINTMENT_BOOKING',
        data: {
          appointmentId: '123',
          pazienteId: 'paz_1',
          phone: '393471234567',
          date: '2026-12-15T10:30:00Z',
          name: 'Mario Rossi',
        },
      };

      await service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1');

      expect(mockEncryptionService.encrypt).toHaveBeenCalled();
      expect(mockRedis.rpush).toHaveBeenCalledWith(
        'pending:tenant-1:393471234567',
        expect.stringContaining('encrypted:'),
      );
    });

    it('dovrebbe impostare TTL pari alla finestra + 5 minuti di margine', async () => {
      const payload = {
        type: 'APPOINTMENT_BOOKING',
        data: {
          appointmentId: '123',
          pazienteId: 'paz_1',
          phone: '393471234567',
          date: '2026-12-15T10:30:00Z',
          name: 'Mario Rossi',
        },
      };

      await service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1');

      expect(mockRedis.expire).toHaveBeenCalledWith('pending:tenant-1:393471234567', 360);
    });

    it('dovrebbe schedulare un reminder 24h prima con jobId corretto', async () => {
      const futureDate = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
      const payload = {
        type: 'APPOINTMENT_BOOKING',
        data: {
          appointmentId: '456',
          pazienteId: 'paz_2',
          phone: '393471234567',
          date: futureDate,
          name: 'Luigi Verdi',
        },
      };

      await service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1');

      expect(mockQueue.add).toHaveBeenCalledWith(
        'send-reminder',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        expect.objectContaining({ jobId: 'reminder:tenant-1:456' }),
      );
    });

    it('non dovrebbe schedulare reminder se appuntamento è tra meno di 24h', async () => {
      const soonDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      const payload = {
        type: 'APPOINTMENT_BOOKING',
        data: {
          appointmentId: '789',
          pazienteId: 'paz_3',
          phone: '393471234567',
          date: soonDate,
          name: 'Anna Bianchi',
        },
      };

      await service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1');

      expect(mockQueue.add).toHaveBeenCalledTimes(1);
      expect(mockQueue.add).toHaveBeenCalledWith('process-recap', expect.any(Object), expect.any(Object));
    });

    it('dovrebbe gestire INTERNAL_TASK senza errori', async () => {
      const payload = {
        type: 'INTERNAL_TASK',
        data: { taskId: 'task-1', action: 'notify' },
      };

      const result = await service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1');

      expect(result).toHaveProperty('status', 'queued');
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-internal-task',
        expect.objectContaining({ tenantId: 'tenant-1' }),
        expect.any(Object),
      );
    });

    it('dovrebbe usare il testo di recap fornito dalla main-app', async () => {
      const payload = {
        type: 'APPOINTMENT_BOOKING',
        data: {
          appointmentId: '123',
          pazienteId: 'paz_1',
          phone: '393471234567',
          date: '2026-12-15T10:30:00',
          name: 'Mario Rossi',
          recapMessage: 'Testo dal template del tenant',
        },
      };

      await service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1');

      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-recap',
        expect.objectContaining({ recapMessage: 'Testo dal template del tenant' }),
        expect.any(Object),
      );
    });

    it('dovrebbe lanciare errore per tipo non supportato', async () => {
      const payload = { type: 'INVALID_TYPE', data: {} };

      await expect(service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1')).rejects.toThrow(
        'Tipo dispatch non supportato: INVALID_TYPE',
      );
    });
  });

  describe('finestra di recap', () => {
    const booking = (extra: Record<string, any> = {}) => ({
      type: 'APPOINTMENT_BOOKING',
      data: {
        appointmentId: '123',
        pazienteId: 'paz_1',
        phone: '393471234567',
        date: '2026-12-15T10:30:00',
        name: 'Mario Rossi',
        ...extra,
      },
    });

    const recapCall = () =>
      mockQueue.add.mock.calls.filter((c: any[]) => c[0] === 'process-recap').pop();

    it('usa 60s se il tenant non indica una finestra', async () => {
      await service.dispatch(booking(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(recapCall()[2]).toEqual(expect.objectContaining({ delay: 60000 }));
      expect(mockRedis.expire).toHaveBeenCalledWith('pending:tenant-1:393471234567', 360);
    });

    it('rispetta la finestra configurata dal tenant', async () => {
      await service.dispatch(booking({ recapDelaySeconds: 180 }), 'tenant-1', 'user-1', '127.0.0.1');

      expect(recapCall()[2]).toEqual(expect.objectContaining({ delay: 180000 }));
      expect(mockRedis.expire).toHaveBeenCalledWith('pending:tenant-1:393471234567', 480);
    });

    it('normalizza valori fuori range', async () => {
      await service.dispatch(booking({ recapDelaySeconds: 5000 }), 'tenant-1', 'user-1', '127.0.0.1');
      expect(recapCall()[2]).toEqual(expect.objectContaining({ delay: 600000 }));

      await service.dispatch(booking({ recapDelaySeconds: 1 }), 'tenant-1', 'user-1', '127.0.0.1');
      expect(recapCall()[2]).toEqual(expect.objectContaining({ delay: 30000 }));
    });

    it('fa ripartire il conteggio a ogni nuovo appuntamento', async () => {
      const pendingJob = { remove: jest.fn().mockResolvedValue(undefined) };
      mockQueue.getJob.mockResolvedValue(pendingJob);
      // finestra aperta 10s fa: c'è ancora margine
      mockRedis.get.mockResolvedValue((Date.now() - 10_000).toString());

      await service.dispatch(booking(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(pendingJob.remove).toHaveBeenCalled();
      expect(recapCall()[2]).toEqual(
        expect.objectContaining({ delay: 60000, jobId: 'timer-recap:tenant-1:393471234567' }),
      );
    });

    it('non rinvia oltre il tetto massimo della finestra', async () => {
      const pendingJob = { remove: jest.fn().mockResolvedValue(undefined) };
      mockQueue.getJob.mockResolvedValue(pendingJob);
      // finestra aperta 6 minuti fa: oltre il tetto (5 × 60s = 5 min)
      mockRedis.get.mockResolvedValue((Date.now() - 6 * 60_000).toString());

      await service.dispatch(booking(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(pendingJob.remove).not.toHaveBeenCalled();
      expect(recapCall()).toBeUndefined();
    });

    it('accoda un job separato se il recap è già in esecuzione', async () => {
      const activeJob = {
        remove: jest.fn().mockRejectedValue(new Error('Job is locked')),
      };
      mockQueue.getJob.mockResolvedValue(activeJob);
      mockRedis.get.mockResolvedValue(Date.now().toString());

      await service.dispatch(booking(), 'tenant-1', 'user-1', '127.0.0.1');

      const jobId = recapCall()[2].jobId as string;
      expect(jobId).toMatch(/^timer-recap:tenant-1:393471234567:\d+$/);
    });
  });

  describe('disdetta dentro la finestra di raggruppamento', () => {
    const cancelPayload = (appointmentId = '123') => ({
      appointmentId,
      pazienteId: 'paz_1',
      phone: '393471234567',
      sendCancelNotification: true,
      cancelNotificationMessage: 'Appuntamento cancellato',
      name: 'Mario Rossi',
      date: '2026-12-15T10:30:00',
    });

    /** Simula un buffer che contiene gli appuntamenti indicati. */
    const bufferWith = (...appointmentIds: string[]) => {
      const rows = appointmentIds.map((id) => `encrypted:${JSON.stringify({ appointmentId: id })}`);
      mockRedis.lrange = jest.fn().mockResolvedValue(rows);
      mockRedis.lrem = jest.fn().mockResolvedValue(1);
      mockRedis.llen = jest.fn().mockResolvedValue(appointmentIds.length - 1);
      return rows;
    };

    it('toglie il recap dal buffer e non manda la cancellazione', async () => {
      bufferWith('123');
      mockRedis.llen = jest.fn().mockResolvedValue(0);

      const result = await service.cancel(cancelPayload(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(result).toEqual(expect.objectContaining({ recapSuppressed: true }));
      // Nessun messaggio verso il paziente: né recap né cancellazione.
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('rimuove anche il timer quando il buffer resta vuoto', async () => {
      bufferWith('123');
      mockRedis.llen = jest.fn().mockResolvedValue(0);
      const timer = { remove: jest.fn().mockResolvedValue(undefined) };
      mockQueue.getJob = jest.fn().mockImplementation((id: string) =>
        id.startsWith('timer-recap') ? timer : null,
      );

      await service.cancel(cancelPayload(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(timer.remove).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalledWith(
        'pending:tenant-1:393471234567',
        'recap_start:tenant-1:393471234567',
      );
    });

    it('lascia partire il recap se restano altri appuntamenti dello stesso numero', async () => {
      bufferWith('123', '456');
      mockRedis.llen = jest.fn().mockResolvedValue(1);
      const timer = { remove: jest.fn() };
      // Solo il timer del recap: il job del promemoria è un altro e viene
      // rimosso comunque, come per qualsiasi disdetta.
      mockQueue.getJob = jest.fn().mockImplementation((id: string) =>
        id.startsWith('timer-recap') ? timer : null,
      );

      await service.cancel(cancelPayload('123'), 'tenant-1', 'user-1', '127.0.0.1');

      expect(timer.remove).not.toHaveBeenCalled();
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('se il recap è già partito manda la cancellazione come prima', async () => {
      // Buffer vuoto: il messaggio al paziente è già uscito, tacere adesso
      // lo lascerebbe convinto di avere un appuntamento che non esiste più.
      mockRedis.lrange = jest.fn().mockResolvedValue([]);

      const result = await service.cancel(cancelPayload(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(result).toEqual(expect.objectContaining({ cancelNotification: 'queued' }));
      expect(mockQueue.add).toHaveBeenCalledWith(
        'send-reminder',
        expect.objectContaining({ message_type: 'cancel_notification' }),
        expect.any(Object),
      );
    });

    it('non tocca il buffer di un altro appuntamento', async () => {
      bufferWith('999');
      const result = await service.cancel(cancelPayload('123'), 'tenant-1', 'user-1', '127.0.0.1');

      expect(result).toEqual(expect.objectContaining({ cancelNotification: 'queued' }));
    });

    describe('ordine rispetto a un recap ancora in attesa', () => {
      const withPendingRecap = (remainingMs: number) => {
        mockRedis.lrange = jest.fn().mockResolvedValue([]); // recap di ALTRI appuntamenti
        mockQueue.getJob = jest.fn().mockImplementation((id: string) =>
          id.startsWith('timer-recap')
            ? { timestamp: Date.now() - 1000, delay: 1000 + remainingMs }
            : null,
        );
      };

      const cancelJob = () =>
        mockQueue.add.mock.calls.find(
          (c: any[]) => c[1]?.message_type === 'cancel_notification',
        );

      it('mette la cancellazione dopo la fine della finestra', async () => {
        withPendingRecap(60_000);

        await service.cancel(cancelPayload(), 'tenant-1', 'user-1', '127.0.0.1');

        // Il paziente aveva preso quegli appuntamenti PRIMA di disdire: la
        // conferma deve arrivargli prima della cancellazione.
        expect(cancelJob()[2].delay).toBeGreaterThan(60_000);
      });

      it('non ritarda nulla se non c\'è un recap in attesa', async () => {
        mockRedis.lrange = jest.fn().mockResolvedValue([]);
        mockQueue.getJob = jest.fn().mockResolvedValue(null);

        await service.cancel(cancelPayload(), 'tenant-1', 'user-1', '127.0.0.1');

        expect(cancelJob()[2].delay).toBeUndefined();
      });

      it('non ritarda se il recap sta già partendo', async () => {
        // Finestra già scaduta: alla sequenza pensa la coda, che ha un solo
        // worker e rispetta l'ordine di accodamento.
        withPendingRecap(-5_000);

        await service.cancel(cancelPayload(), 'tenant-1', 'user-1', '127.0.0.1');

        expect(cancelJob()[2].delay).toBeUndefined();
      });
    });
  });

  describe('recap immediato', () => {
    const booking = (extra: Record<string, any> = {}) => ({
      type: 'APPOINTMENT_BOOKING',
      data: {
        appointmentId: '123',
        pazienteId: 'paz_1',
        phone: '393471234567',
        date: '2026-12-15T10:30:00',
        name: 'Mario Rossi',
        recapMessage: 'Testo dal template del tenant',
        ...extra,
      },
    });

    const jobNames = () => mockQueue.add.mock.calls.map((c: any[]) => c[0]);

    it('con recapImmediate accoda il messaggio senza timer di recap', async () => {
      await service.dispatch(booking({ recapImmediate: true }), 'tenant-1', 'user-1', '127.0.0.1');

      expect(jobNames()).not.toContain('process-recap');
      const sent = mockQueue.add.mock.calls.find((c: any[]) => c[0] === 'send-reminder');
      expect(sent[1]).toEqual(
        expect.objectContaining({
          content: 'Testo dal template del tenant',
          message_type: 'single_recap',
          appointmentIds: ['123'],
        }),
      );
      // Nessun delay: deve partire appena la coda lo prende in carico.
      expect(sent[2]?.delay).toBeUndefined();
    });

    it('non tocca il buffer di raggruppamento', async () => {
      await service.dispatch(booking({ recapImmediate: true }), 'tenant-1', 'user-1', '127.0.0.1');

      // Infilarlo nel buffer lo farebbe ripartire insieme alle prenotazioni
      // in corso, fondendo il messaggio manuale con le altre.
      expect(mockRedis.rpush).not.toHaveBeenCalled();
    });

    it('senza il flag resta il comportamento con finestra di raggruppamento', async () => {
      await service.dispatch(booking(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(jobNames()).toContain('process-recap');
      expect(mockRedis.rpush).toHaveBeenCalled();
    });

    it('programma comunque il promemoria', async () => {
      await service.dispatch(booking({ recapImmediate: true }), 'tenant-1', 'user-1', '127.0.0.1');

      const reminder = mockQueue.add.mock.calls.find(
        (c: any[]) => c[0] === 'send-reminder' && c[1]?.message_type === 'reminder',
      );
      expect(reminder).toBeDefined();
    });
  });

  describe('non letti da WhatsApp', () => {
    const chats = (data: any[]) => {
      mockHttpService.post.mockReturnValueOnce(of({ data }));
      return service.getUnreadCounts('tenant-1');
    };

    it('mappa i numeri veri sul loro contatore', async () => {
      const counts = await chats([
        { remoteJid: '393471234567@s.whatsapp.net', unreadCount: 3 },
        { remoteJid: '393480000000@s.whatsapp.net', unreadCount: 0 },
      ]);

      expect(counts).toEqual({ '393471234567': 3, '393480000000': 0 });
    });

    it('risolve il numero delle chat @lid da remoteJidAlt', async () => {
      // WhatsApp indirizza ormai gran parte delle chat con un identificativo
      // mascherato: fermarsi al remoteJid lascerebbe fuori la maggioranza.
      const counts = await chats([
        {
          remoteJid: '154283865563301@lid',
          unreadCount: 3,
          lastMessage: { key: { remoteJidAlt: '393358320295@s.whatsapp.net' } },
        },
      ]);

      expect(counts).toEqual({ '393358320295': 3 });
    });

    it('scarta i gruppi e le chat senza numero risolvibile', async () => {
      const counts = await chats([
        { remoteJid: '393400928142-1629906443@g.us', unreadCount: 5 },
        { remoteJid: '226757110177900@lid', unreadCount: 1 },
        { remoteJid: '393471234567@s.whatsapp.net', unreadCount: 2 },
      ]);

      expect(counts).toEqual({ '393471234567': 2 });
    });

    it('omette i contatori null invece di trattarli come zero', async () => {
      // `null` significa "non lo so": spegnere il pallino su questa base
      // nasconderebbe messaggi davvero non letti.
      const counts = await chats([
        { remoteJid: '393471234567@s.whatsapp.net', unreadCount: null },
        { remoteJid: '393480000000@s.whatsapp.net' },
        { remoteJid: '393490000000@s.whatsapp.net', unreadCount: 0 },
      ]);

      expect(counts).toEqual({ '393490000000': 0 });
    });

    it('per un numero duplicato tiene la chat aggiornata più di recente', async () => {
      // La chat legacy porta contatori fermi: vista una a 108 su una
      // conversazione già evasa dalla segreteria.
      const counts = await chats([
        {
          remoteJid: '393426255115@s.whatsapp.net',
          unreadCount: 108,
          updatedAt: '2026-08-10T09:50:47.000Z',
        },
        {
          remoteJid: '169488184037562@lid',
          unreadCount: 0,
          updatedAt: '2026-08-10T09:52:15.000Z',
          lastMessage: { key: { remoteJidAlt: '393426255115@s.whatsapp.net' } },
        },
      ]);

      expect(counts).toEqual({ '393426255115': 0 });
    });
  });

  describe('stato di lettura delle conversazioni', () => {
    const CHAT_LID = {
      remoteJid: '62607788662868@lid',
      updatedAt: '2026-08-12T10:00:00.000Z',
      lastMessage: { key: { remoteJidAlt: '393357816989@s.whatsapp.net' } },
    };

    /** findChats poi findStatusMessage: due POST distinti, in quest'ordine. */
    const respond = (chats: any[], statuses: any[]) => {
      mockHttpService.post
        .mockReturnValueOnce(of({ data: chats }))
        .mockReturnValue(of({ data: statuses }));
    };

    it('riconosce come letta una chat il cui contatore è nullo ma il messaggio risulta READ', async () => {
      // È il caso che il solo contatore non copre: la segreteria ha letto su
      // WhatsApp Web senza rispondere.
      respond(
        [{ ...CHAT_LID, unreadCount: null }],
        [{ fromMe: false, status: 'READ', keyId: 'ABC123' }],
      );

      const states = await service.getChatReadStates('tenant-1', [
        { phone: '393357816989', messageId: 'ABC123' },
      ]);

      expect(states).toEqual({ '393357816989': 'read' });
    });

    it('accetta PLAYED come lettura', async () => {
      respond(
        [{ ...CHAT_LID, unreadCount: null }],
        [{ fromMe: false, status: 'PLAYED', keyId: 'ABC123' }],
      );

      const states = await service.getChatReadStates('tenant-1', [
        { phone: '393357816989', messageId: 'ABC123' },
      ]);

      expect(states).toEqual({ '393357816989': 'read' });
    });

    it('ignora i record dei messaggi che abbiamo inviato noi', async () => {
      // fromMe=true è la consegna dei NOSTRI messaggi al paziente: non dice
      // nulla su cosa abbia letto la segreteria.
      respond(
        [{ ...CHAT_LID, unreadCount: null }],
        [{ fromMe: true, status: 'READ', keyId: 'ABC123' }],
      );

      const states = await service.getChatReadStates('tenant-1', [
        { phone: '393357816989', messageId: 'ABC123' },
      ]);

      expect(states).toEqual({ '393357816989': 'unknown' });
    });

    it('con contatore a zero non serve interrogare lo storico', async () => {
      respond([{ ...CHAT_LID, unreadCount: 0 }], []);

      const states = await service.getChatReadStates('tenant-1', [
        { phone: '393357816989', messageId: 'ABC123' },
      ]);

      expect(states).toEqual({ '393357816989': 'read' });
      expect(mockHttpService.post).toHaveBeenCalledTimes(1);
    });

    it('resta unread se il contatore è positivo e non risulta letto', async () => {
      respond([{ ...CHAT_LID, unreadCount: 2 }], [{ fromMe: false, status: 'READ', keyId: 'ALTRO' }]);

      const states = await service.getChatReadStates('tenant-1', [
        { phone: '393357816989', messageId: 'ABC123' },
      ]);

      expect(states).toEqual({ '393357816989': 'unread' });
    });

    it('torna unknown per un numero che WhatsApp non conosce', async () => {
      respond([], []);

      const states = await service.getChatReadStates('tenant-1', [
        { phone: '393000000000', messageId: 'ABC123' },
      ]);

      expect(states).toEqual({ '393000000000': 'unknown' });
    });
  });

  describe('fascia oraria dei promemoria', () => {
    // Orario di riferimento: martedì 1 dicembre 2026, 12:00 a Roma (ora solare).
    // Tutti gli appuntamenti dei test sono a metà dicembre, quindi ampiamente
    // nel futuro rispetto a questo istante.
    const NOW = new Date('2026-12-01T11:00:00Z');

    const WINDOW = { reminderWindowStart: '08:30', reminderWindowEnd: '09:00' };

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(NOW);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    const booking = (extra: Record<string, any> = {}, appointmentId = '123') => ({
      type: 'APPOINTMENT_BOOKING',
      data: {
        appointmentId,
        pazienteId: 'paz_1',
        phone: '393471234567',
        name: 'Mario Rossi',
        ...extra,
      },
    });

    const reminderCalls = () =>
      mockQueue.add.mock.calls.filter((c: any[]) => c[0] === 'send-reminder');

    /** Istante di invio effettivo dell'ultimo promemoria accodato. */
    const sentAt = (index = -1): DateTime => {
      const calls = reminderCalls();
      const call = index < 0 ? calls[calls.length + index] : calls[index];
      return DateTime.fromMillis(Date.now() + call[2].delay).setZone('Europe/Rome');
    };

    const auditPayload = (eventType: string) =>
      mockAuditService.log.mock.calls
        .map((c: any[]) => c[0])
        .filter((e: any) => e.eventType === eventType)
        .pop()?.payload;

    it('colloca il promemoria nella fascia del giorno prima', async () => {
      await service.dispatch(
        booking({ date: '2026-12-15T16:00:00', ...WINDOW }),
        'tenant-1',
        'user-1',
        '127.0.0.1',
      );

      const at = sentAt();
      expect(at.toISODate()).toBe('2026-12-14');
      expect(at.hour * 60 + at.minute).toBeGreaterThanOrEqual(8 * 60 + 30);
      expect(at.hour * 60 + at.minute).toBeLessThan(9 * 60);
      expect(auditPayload('REMINDER_SCHEDULED')).toEqual(
        expect.objectContaining({ mode: 'window', windowDay: '2026-12-14', slot: 1 }),
      );
    });

    it('senza fascia configurata resta il comportamento a 24h esatte', async () => {
      await service.dispatch(
        booking({ date: '2026-12-15T16:00:00' }),
        'tenant-1',
        'user-1',
        '127.0.0.1',
      );

      expect(sentAt().toISO()).toBe(
        DateTime.fromISO('2026-12-14T16:00:00', { zone: 'Europe/Rome' }).toISO(),
      );
      expect(auditPayload('REMINDER_SCHEDULED')).toEqual(
        expect.objectContaining({ mode: 'exact_24h' }),
      );
    });

    it('ignora una fascia incoerente e ricade sulle 24h esatte', async () => {
      await service.dispatch(
        booking({
          date: '2026-12-15T16:00:00',
          reminderWindowStart: '09:00',
          reminderWindowEnd: '08:30',
        }),
        'tenant-1',
        'user-1',
        '127.0.0.1',
      );

      expect(sentAt().toISO()).toBe(
        DateTime.fromISO('2026-12-14T16:00:00', { zone: 'Europe/Rome' }).toISO(),
      );
    });

    describe('appuntamento che inizia prima della fine della fascia', () => {
      // Appuntamento alle 07:00: la fascia del giorno prima (che finisce alle
      // 09:00) cadrebbe a 22,5h dall'appuntamento, sotto la soglia delle 24h.
      const EARLY = { date: '2026-12-15T07:00:00', ...WINDOW };

      it('di default arretra alla fascia del giorno ancora precedente', async () => {
        await service.dispatch(booking(EARLY), 'tenant-1', 'user-1', '127.0.0.1');

        const at = sentAt();
        expect(at.toISODate()).toBe('2026-12-13');
        expect(at.hour * 60 + at.minute).toBeGreaterThanOrEqual(8 * 60 + 30);
        expect(at.hour * 60 + at.minute).toBeLessThan(9 * 60);
        expect(auditPayload('REMINDER_SCHEDULED').hoursBefore).toBeGreaterThan(24);
      });

      it('con EXACT_24H invia alle 24h esatte, fuori fascia', async () => {
        await service.dispatch(
          booking({ ...EARLY, reminderEarlyPolicy: 'EXACT_24H' }),
          'tenant-1',
          'user-1',
          '127.0.0.1',
        );

        expect(sentAt().toISO()).toBe(
          DateTime.fromISO('2026-12-14T07:00:00', { zone: 'Europe/Rome' }).toISO(),
        );
        expect(auditPayload('REMINDER_SCHEDULED')).toEqual(
          expect.objectContaining({ mode: 'exact_24h', hoursBefore: 24 }),
        );
      });

      it('usa il testo REMINDER_48H quando parte due giorni prima', async () => {
        await service.dispatch(
          booking({
            ...EARLY,
            reminderMessage: 'Il suo appuntamento è domani alle 07:00',
            reminderMessageEarly: 'Il suo appuntamento è dopodomani alle 07:00',
          }),
          'tenant-1',
          'user-1',
          '127.0.0.1',
        );

        expect(reminderCalls().pop()[1]).toEqual(
          expect.objectContaining({ content: 'Il suo appuntamento è dopodomani alle 07:00' }),
        );
      });

      it('ricade su REMINDER_24H se il testo a due giorni non è configurato', async () => {
        await service.dispatch(
          booking({ ...EARLY, reminderMessage: 'Il suo appuntamento è domani alle 07:00' }),
          'tenant-1',
          'user-1',
          '127.0.0.1',
        );

        expect(reminderCalls().pop()[1]).toEqual(
          expect.objectContaining({ content: 'Il suo appuntamento è domani alle 07:00' }),
        );
      });

      it('con FORCE_WINDOW resta in fascia accettando meno di 24h', async () => {
        await service.dispatch(
          booking({ ...EARLY, reminderEarlyPolicy: 'FORCE_WINDOW' }),
          'tenant-1',
          'user-1',
          '127.0.0.1',
        );

        expect(sentAt().toISODate()).toBe('2026-12-14');
        expect(auditPayload('REMINDER_SCHEDULED').hoursBefore).toBeLessThan(24);
      });

      it('un appuntamento dopo la fine della fascia non è un caso limite', async () => {
        await service.dispatch(
          booking({ date: '2026-12-15T09:30:00', ...WINDOW }),
          'tenant-1',
          'user-1',
          '127.0.0.1',
        );

        expect(sentAt().toISODate()).toBe('2026-12-14');
      });
    });

    describe('fascia già passata al momento della prenotazione', () => {
      it('ripiega sulle 24h esatte se sono ancora nel futuro', async () => {
        // Prenotazione lunedì 14 alle 12:00: la fascia di quel giorno (08:30)
        // è chiusa da un pezzo, ma -24h dall'appuntamento è ancora futuro.
        jest.setSystemTime(new Date('2026-12-14T11:00:00Z'));

        await service.dispatch(
          booking({ date: '2026-12-15T16:00:00', ...WINDOW }),
          'tenant-1',
          'user-1',
          '127.0.0.1',
        );

        expect(sentAt().toISO()).toBe(
          DateTime.fromISO('2026-12-14T16:00:00', { zone: 'Europe/Rome' }).toISO(),
        );
        expect(auditPayload('REMINDER_SCHEDULED')).toEqual(
          expect.objectContaining({ mode: 'exact_24h' }),
        );
      });

      it('non programma nulla se anche le 24h esatte sono passate', async () => {
        jest.setSystemTime(new Date('2026-12-14T17:00:00Z'));

        await service.dispatch(
          booking({ date: '2026-12-15T16:00:00', ...WINDOW }),
          'tenant-1',
          'user-1',
          '127.0.0.1',
        );

        expect(reminderCalls()).toHaveLength(0);
      });
    });

    describe('distribuzione nella fascia', () => {
      const bookMany = async (count: number) => {
        for (let i = 0; i < count; i++) {
          await service.dispatch(
            booking({ date: '2026-12-15T16:00:00', ...WINDOW }, `appt-${i}`),
            'tenant-1',
            'user-1',
            '127.0.0.1',
          );
        }
        return reminderCalls().map((_: any, i: number) =>
          sentAt(i).diff(
            DateTime.fromISO('2026-12-14T08:30:00', { zone: 'Europe/Rome' }),
          ).as('seconds'),
        );
      };

      it('tiene tutti gli invii dentro la fascia', async () => {
        const offsets = await bookMany(40);

        expect(offsets).toHaveLength(40);
        for (const offset of offsets) {
          expect(offset).toBeGreaterThanOrEqual(0);
          expect(offset).toBeLessThan(1800);
        }
      });

      it('copre la fascia invece di addensare gli invii all\'inizio', async () => {
        const offsets = (await bookMany(24)).sort((a, b) => a - b);

        // Ogni sesto della fascia (5 minuti) deve ricevere almeno un messaggio:
        // è la proprietà che la suddivisione progressiva garantisce e che un
        // semplice "tutti allo scoccare della fascia" non avrebbe.
        for (let sixth = 0; sixth < 6; sixth++) {
          const from = sixth * 300;
          expect(offsets.some((o) => o >= from && o < from + 300)).toBe(true);
        }
      });

      it('non produce due invii allo stesso istante né intervalli costanti', async () => {
        const offsets = (await bookMany(24)).sort((a, b) => a - b);
        const gaps = offsets.slice(1).map((o, i) => o - offsets[i]);

        expect(new Set(offsets).size).toBe(offsets.length);
        // Intervalli irregolari: con un passo fisso tutti i gap sarebbero uguali.
        expect(new Set(gaps.map((g) => Math.round(g))).size).toBeGreaterThan(1);
      });

      it('conta gli slot per tenant e per giorno di fascia', async () => {
        await bookMany(3);

        expect(mockRedis.incr).toHaveBeenCalledWith('wa:rem-slot:tenant-1:2026-12-14');
        expect(mockRedis.incr).toHaveBeenCalledTimes(3);
      });
    });
  });

  describe('APPOINTMENT_UPDATE', () => {
    const futureDate = () => new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const updatePayload = (extra: Record<string, any> = {}) => ({
      type: 'APPOINTMENT_UPDATE',
      data: {
        appointmentId: '456',
        pazienteId: 'paz_2',
        phone: '393471234567',
        date: futureDate(),
        name: 'Luigi Verdi',
        updateMessage: 'Spostato a domani',
        reminderMessage: 'Promemoria dal template',
        ...extra,
      },
    });

    it('dovrebbe rimuovere il reminder sul vecchio orario, notificare e riprogrammare', async () => {
      const oldJob = { remove: jest.fn().mockResolvedValue(undefined) };
      mockQueue.getJob.mockResolvedValue(oldJob);

      const result = await service.dispatch(updatePayload(), 'tenant-1', 'user-1', '127.0.0.1');

      expect(mockQueue.getJob).toHaveBeenCalledWith('reminder:tenant-1:456');
      expect(oldJob.remove).toHaveBeenCalled();

      expect(mockQueue.add).toHaveBeenCalledWith(
        'send-reminder',
        expect.objectContaining({
          content: 'Spostato a domani',
          message_type: 'update_notification',
        }),
        expect.any(Object),
      );

      expect(mockQueue.add).toHaveBeenCalledWith(
        'send-reminder',
        expect.objectContaining({
          content: 'Promemoria dal template',
          message_type: 'reminder',
        }),
        expect.objectContaining({ jobId: 'reminder:tenant-1:456' }),
      );

      expect(result).toEqual({
        status: 'queued',
        updateNotification: 'queued',
        reminder: 'rescheduled',
      });
    });

    it('con sendUpdateNotification=false dovrebbe solo riprogrammare il reminder', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      const result = await service.dispatch(
        updatePayload({ sendUpdateNotification: false }),
        'tenant-1',
        'user-1',
        '127.0.0.1',
      );

      const queuedTypes = mockQueue.add.mock.calls.map((c: any[]) => c[1]?.message_type);
      expect(queuedTypes).not.toContain('update_notification');
      expect(queuedTypes).toContain('reminder');
      expect(result).toEqual({
        status: 'queued',
        updateNotification: 'disabled',
        reminder: 'rescheduled',
      });
    });
  });

  describe('messaggi programmati', () => {
    const fakeJob = (over: Record<string, any> = {}) => ({
      id: over.id ?? 'reminder:tenant-1:apt-1',
      name: over.name ?? 'send-reminder',
      timestamp: 1_000_000,
      delay: 60_000,
      remove: jest.fn().mockResolvedValue(undefined),
      data: {
        tenantId: 'tenant-1',
        phone: '393471234567',
        pazienteId: 'paz_1',
        content: 'Promemoria dal template',
        message_type: 'reminder',
        appointmentIds: ['apt-1'],
        originalAppointmentId: 'apt-1',
        ...(over.data ?? {}),
      },
      ...over,
    });

    it('elenca solo i job del tenant richiesto', async () => {
      mockQueue.getDelayed = jest.fn().mockResolvedValue([
        fakeJob(),
        fakeJob({ id: 'reminder:tenant-2:apt-9', data: { tenantId: 'tenant-2' } }),
      ]);
      mockQueue.getWaiting = jest.fn().mockResolvedValue([]);

      const list = await service.listScheduled('tenant-1');

      expect(list).toHaveLength(1);
      expect(list[0]).toEqual(
        expect.objectContaining({
          jobId: 'reminder:tenant-1:apt-1',
          type: 'reminder',
          content: 'Promemoria dal template',
          appointmentIds: ['apt-1'],
          state: 'delayed',
        }),
      );
      expect(list[0].scheduledFor).toBe(new Date(1_060_000).toISOString());
    });

    it('per i recap espone il numero di appuntamenti in buffer e nessun testo', async () => {
      mockQueue.getDelayed = jest.fn().mockResolvedValue([
        fakeJob({ id: 'timer-recap:tenant-1:393471234567', name: 'process-recap' }),
      ]);
      mockQueue.getWaiting = jest.fn().mockResolvedValue([]);
      mockRedis.llen = jest.fn().mockResolvedValue(3);

      const [recap] = await service.listScheduled('tenant-1');

      expect(recap.type).toBe('recap');
      expect(recap.bufferedCount).toBe(3);
      expect(recap.content).toBeUndefined();
      expect(mockRedis.llen).toHaveBeenCalledWith('pending:tenant-1:393471234567');
    });

    it('non annulla un job di un altro tenant', async () => {
      const job = fakeJob({ data: { tenantId: 'tenant-2' } });
      mockQueue.getJob.mockResolvedValue(job);

      const result = await service.cancelScheduled('reminder:tenant-1:apt-1', 'tenant-1', 'user-1');

      expect(result.status).toBe('not_found');
      expect(job.remove).not.toHaveBeenCalled();
    });

    it('annulla il job e per i recap svuota il buffer', async () => {
      const job = fakeJob({ id: 'timer-recap:tenant-1:393471234567', name: 'process-recap' });
      mockQueue.getJob.mockResolvedValue(job);
      mockRedis.llen = jest.fn().mockResolvedValue(2);

      const result = await service.cancelScheduled(
        'timer-recap:tenant-1:393471234567', 'tenant-1', 'user-1',
      );

      expect(result.status).toBe('cancelled');
      expect(job.remove).toHaveBeenCalled();
      expect(mockRedis.del).toHaveBeenCalledWith(
        'pending:tenant-1:393471234567',
        'recap_start:tenant-1:393471234567',
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'SCHEDULED_MESSAGE_CANCELLED', status: 'SUCCESS' }),
      );
    });
  });

  describe('cancelBooking', () => {
    it('dovrebbe cancellare un job esistente e loggare SUCCESS', async () => {
      const mockJob = { remove: jest.fn().mockResolvedValue(undefined) };
      mockQueue.getJob.mockResolvedValue(mockJob);

      const result = await service.cancelBooking('123', 'tenant-1', 'user-1', '127.0.0.1');

      expect(result).toEqual({ status: 'cancelled' });
      expect(mockJob.remove).toHaveBeenCalled();
      expect(mockQueue.getJob).toHaveBeenCalledWith('reminder:tenant-1:123');
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'REMINDER_CANCELLED',
          status: 'SUCCESS',
        }),
      );
    });

    it('dovrebbe restituire not_found se il job non esiste', async () => {
      mockQueue.getJob.mockResolvedValue(null);

      const result = await service.cancelBooking('999', 'tenant-1', 'user-1', '127.0.0.1');

      expect(result).toEqual({ status: 'not_found' });
    });
  });
});
