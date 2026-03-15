import { Test, TestingModule } from '@nestjs/testing';
import { AuditService } from './audit.service';
import * as crypto from 'crypto';

describe('AuditService', () => {
  let service: AuditService;
  let logSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AuditService],
    }).compile();

    service = module.get<AuditService>(AuditService);
    logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation();
  });

  it('dovrebbe scrivere un log strutturato con schema completo ISO', async () => {
    const payload = { appointmentId: '123', phone: '393471234567' };

    await service.log({
      tenantId: 'tenant-1',
      correlationId: 'corr-id-1',
      eventType: 'REQUEST_RECEIVED',
      actor: { user_id: 'user-1', ip_address: '192.168.1.10' },
      resource: { entity: 'APPOINTMENT', id: '123' },
      status: 'PENDING',
      payload,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);

    const loggedEntry = JSON.parse(logSpy.mock.calls[0][0]);
    expect(loggedEntry.audit_version).toBe('1.0');
    expect(loggedEntry.tenant_id).toBe('tenant-1');
    expect(loggedEntry.correlation_id).toBe('corr-id-1');
    expect(loggedEntry.event_type).toBe('REQUEST_RECEIVED');
    expect(loggedEntry.status).toBe('PENDING');
    expect(loggedEntry.timestamp).toBeDefined();

    // actor come oggetto
    expect(loggedEntry.actor).toEqual({ user_id: 'user-1', ip_address: '192.168.1.10' });

    // resource come oggetto
    expect(loggedEntry.resource).toEqual({ entity: 'APPOINTMENT', id: '123' });

    // integrity_check annidato
    const expectedHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    expect(loggedEntry.integrity_check.payload_hash).toBe(expectedHash);
  });

  it('non dovrebbe includere il payload nel log (GDPR)', async () => {
    const payload = { name: 'Mario Rossi', phone: '393471234567' };

    await service.log({
      tenantId: 'tenant-1',
      correlationId: 'corr-id-2',
      eventType: 'MESSAGE_DISPATCHED',
      actor: { user_id: 'SYSTEM', ip_address: 'internal' },
      resource: { entity: 'APPOINTMENT', id: '456' },
      status: 'SUCCESS',
      payload,
    });

    const loggedEntry = JSON.parse(logSpy.mock.calls[0][0]);
    // Il payload non deve essere presente nel log (solo l'hash)
    expect(JSON.stringify(loggedEntry)).not.toContain('Mario Rossi');
    expect(loggedEntry.integrity_check.payload_hash).toBeDefined();
  });

  it('dovrebbe includere metadata quando forniti', async () => {
    await service.log({
      tenantId: 'tenant-1',
      correlationId: 'corr-id-3',
      eventType: 'WEBHOOK_RETRY',
      actor: { user_id: 'SYSTEM', ip_address: 'internal' },
      resource: { entity: 'WEBHOOK', id: 'evt-1' },
      status: 'FAILED',
      payload: {},
      metadata: {
        retry_count: 3,
        processing_time_ms: 1500,
        evolution_message_id: 'wamid.ABC123',
      },
    });

    const loggedEntry = JSON.parse(logSpy.mock.calls[0][0]);
    expect(loggedEntry.metadata.retry_count).toBe(3);
    expect(loggedEntry.metadata.processing_time_ms).toBe(1500);
    expect(loggedEntry.metadata.evolution_message_id).toBe('wamid.ABC123');
  });
});
