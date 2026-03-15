import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { WhatsappService } from './whatsapp.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionService } from '../common/encryption.service';

describe('WhatsappService', () => {
  let service: WhatsappService;
  let mockQueue: any;
  let mockRedis: any;
  let mockAuditService: any;
  let mockEncryptionService: any;

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({}),
      getJob: jest.fn(),
    };

    mockRedis = {
      rpush: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };

    mockAuditService = {
      log: jest.fn().mockResolvedValue(undefined),
    };

    mockEncryptionService = {
      encrypt: jest.fn().mockImplementation((s: string) => `encrypted:${s}`),
      decrypt: jest.fn().mockImplementation((s: string) => s.replace('encrypted:', '')),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WhatsappService,
        { provide: getQueueToken('whatsapp-queue'), useValue: mockQueue },
        { provide: 'default_IORedisModuleConnectionToken', useValue: mockRedis },
        { provide: AuditService, useValue: mockAuditService },
        { provide: EncryptionService, useValue: mockEncryptionService },
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
        'pending:tenant-1:paz_1',
        expect.stringContaining('encrypted:'),
      );
    });

    it('dovrebbe impostare TTL di 5 minuti sulla chiave pending', async () => {
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

      expect(mockRedis.expire).toHaveBeenCalledWith('pending:tenant-1:paz_1', 300);
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

    it('dovrebbe lanciare errore per tipo non supportato', async () => {
      const payload = { type: 'INVALID_TYPE', data: {} };

      await expect(service.dispatch(payload, 'tenant-1', 'user-1', '127.0.0.1')).rejects.toThrow(
        'Tipo dispatch non supportato: INVALID_TYPE',
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
