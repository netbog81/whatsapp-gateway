import { WhatsappProcessor } from './whatsapp.processor';
import { NoUsableChannelError } from '../delivery/channel-delivery.service';

/**
 * Consegna multicanale dei messaggi programmati.
 *
 * Il caso che conta davvero e' l'ultimo: un paziente senza il recapito del
 * canale scelto NON e' un guasto. Se il job fallisse, BullMQ lo ritenterebbe
 * per sempre contro un'anagrafica che non cambiera' da sola, e la coda si
 * riempirebbe di errori che nessuno puo' risolvere ritentando.
 */
describe('WhatsappProcessor.deliverMultichannel', () => {
  const make = (deliverImpl: jest.Mock) => {
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const redis = { set: jest.fn().mockResolvedValue('OK'), get: jest.fn().mockResolvedValue(null) };
    const processor = new WhatsappProcessor(
      null as any,
      null as any,
      redis as any,
      null as any,
      audit as any,
      null as any,
      { deliver: deliverImpl } as any,
      null as any,
    );
    return { processor, audit, redis };
  };

  const data = (extra: Record<string, any> = {}) => ({
    tenantId: 'bdq',
    channels: ['whatsapp', 'sms'],
    phone: '+393471234567',
    content: 'Promemoria: domani alle 10:00',
    message_type: 'reminder_24h',
    correlationId: 'corr-1',
    pazienteId: 'pat-1',
    ...extra,
  });

  it('canale primario: consegna, audit MESSAGE_DISPATCHED, metadati per il webhook', async () => {
    const deliver = jest.fn().mockResolvedValue({
      channel: 'whatsapp', driver: 'evolution', providerMessageId: 'wa-1',
      usedFallback: false, recipientMasked: '+39*******567', skipped: [], attempts: [],
    });
    const { processor, audit, redis } = make(deliver);

    const result = await (processor as any).deliverMultichannel(data());

    expect(result.channel).toBe('whatsapp');
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'MESSAGE_DISPATCHED', status: 'SUCCESS' }),
    );
    // I metadati servono al webhook per attribuire la ricevuta di consegna.
    expect(redis.set).toHaveBeenCalledWith(
      'msg_meta:bdq:wa-1', expect.any(String), 'EX', 172800,
    );
  });

  it('riserva: canale diverso dal primo → audit MESSAGE_FALLBACK', async () => {
    const deliver = jest.fn().mockResolvedValue({
      channel: 'sms', driver: 'personal_gsm', providerMessageId: 'sms-1',
      usedFallback: true, recipientMasked: '+39*******567', skipped: [], attempts: [],
    });
    const { processor, audit, redis } = make(deliver);

    const result = await (processor as any).deliverMultichannel(data());

    expect(result.usedFallback).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'MESSAGE_FALLBACK' }),
    );
    // Nessuna ricevuta da attendere: l'SMS non passa dal webhook WhatsApp.
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('il piano di canali viene passato tale e quale al motore', async () => {
    const deliver = jest.fn().mockResolvedValue({
      channel: 'email', driver: 'smtp', usedFallback: false,
      recipientMasked: 'm***o@x.it', skipped: ['sms'], attempts: [],
    });
    const { processor } = make(deliver);

    await (processor as any).deliverMultichannel(
      data({
        channels: ['email', 'sms'],
        email: 'mario@x.it',
        emailSubject: 'Promemoria appuntamento',
        emailBody: 'Corpo disteso',
        smsText: 'Testo corto',
        smsDriver: 'skebby',
      }),
    );

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: ['email', 'sms'],
        email: 'mario@x.it',
        smsDriver: 'skebby',
        content: expect.objectContaining({
          subject: 'Promemoria appuntamento',
          emailBody: 'Corpo disteso',
          smsText: 'Testo corto',
        }),
      }),
    );
  });

  it('nessun recapito utilizzabile: NON rilancia, così la coda non ritenta a vuoto', async () => {
    const deliver = jest.fn().mockRejectedValue(new NoUsableChannelError(['email'], ['email']));
    const { processor, audit } = make(deliver);

    const result = await (processor as any).deliverMultichannel(data({ channels: ['email'] }));

    expect(result.skipped).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ERROR',
        metadata: expect.objectContaining({ no_recipient: true }),
      }),
    );
  });

  it('guasto vero: rilancia, così BullMQ ritenta', async () => {
    const deliver = jest.fn().mockRejectedValue(new Error('gateway GSM irraggiungibile'));
    const { processor, audit } = make(deliver);

    await expect(
      (processor as any).deliverMultichannel(data()),
    ).rejects.toThrow('gateway GSM irraggiungibile');

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ERROR',
        metadata: expect.objectContaining({ no_recipient: false }),
      }),
    );
  });
});
