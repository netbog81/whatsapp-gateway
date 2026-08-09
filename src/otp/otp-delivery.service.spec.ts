import { BadGatewayException } from '@nestjs/common';
import { of } from 'rxjs';
import { OtpDeliveryService, maskEmail, maskPhone } from './otp-delivery.service';
import { SendOtpDto } from './dto/send-otp.dto';

describe('OtpDeliveryService', () => {
  let service: OtpDeliveryService;
  let httpService: { post: jest.Mock };
  let configService: { get: jest.Mock };
  let baoService: { getSecret: jest.Mock };
  let auditService: { log: jest.Mock };
  let personalGsmDriver: { name: string; send: jest.Mock };
  let skebbyDriver: { name: string; send: jest.Mock };
  let smtpDriver: { name: string; send: jest.Mock };
  let redis: { get: jest.Mock; set: jest.Mock };

  const dto = (overrides: Partial<SendOtpDto> = {}): SendOtpDto =>
    ({
      phone: '+393471234567',
      message: 'Curandis: il codice per firmare è 123456',
      ...overrides,
    }) as SendOtpDto;

  beforeEach(() => {
    httpService = { post: jest.fn() };
    configService = { get: jest.fn().mockReturnValue('http://evolution:8080') };
    baoService = { getSecret: jest.fn().mockResolvedValue(null) };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    personalGsmDriver = { name: 'personal_gsm', send: jest.fn() };
    skebbyDriver = { name: 'skebby', send: jest.fn() };
    smtpDriver = { name: 'smtp', send: jest.fn() };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };

    service = new OtpDeliveryService(
      httpService as any,
      configService as any,
      baoService as any,
      auditService as any,
      personalGsmDriver as any,
      skebbyDriver as any,
      smtpDriver as any,
      redis as any,
    );
  });

  it('canale primario sms via personal_gsm (priorità dal chiamante)', async () => {
    personalGsmDriver.send.mockResolvedValue({ providerMessageId: 'gsm-1' });

    const result = await service.send(
      'bdq',
      dto({ channelPriority: ['sms', 'whatsapp'], smsDriver: 'personal_gsm' }),
      '10.0.0.1',
    );

    expect(result).toEqual({
      channel: 'sms',
      driver: 'personal_gsm',
      providerMessageId: 'gsm-1',
      usedFallback: false,
      recipientMasked: '+39*******567',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'OTP_DISPATCHED', status: 'SUCCESS' }),
    );
    // il numero non deve mai finire in chiaro nell'audit
    const payload = auditService.log.mock.calls[0][0].payload;
    expect(JSON.stringify(payload)).not.toContain('+393471234567');
  });

  it('fallback: sms fallisce → whatsapp consegna, eventType OTP_FALLBACK', async () => {
    personalGsmDriver.send.mockRejectedValue(new Error('device irraggiungibile'));
    baoService.getSecret.mockImplementation(async (path: string) =>
      path.includes('evolution_apikey') ? { api_key: 'evo-key' } : null,
    );
    httpService.post.mockReturnValue(of({ data: { key: { id: 'wa-msg-1' } } }));

    const result = await service.send(
      'bdq',
      dto({ channelPriority: ['sms', 'whatsapp'], smsDriver: 'personal_gsm' }),
      '10.0.0.1',
    );

    expect(result).toEqual({
      channel: 'whatsapp',
      driver: 'evolution',
      providerMessageId: 'wa-msg-1',
      usedFallback: true,
      recipientMasked: '+39*******567',
    });
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'OTP_FALLBACK' }),
    );
  });

  it('config per-tenant dal KV quando il chiamante non passa priorità', async () => {
    baoService.getSecret.mockImplementation(async (path: string) => {
      if (path.endsWith('otp_config')) {
        return { primary_channel: 'sms', fallback_channel: 'whatsapp', sms_driver: 'skebby' };
      }
      return null;
    });
    skebbyDriver.send.mockResolvedValue({ providerMessageId: 'skb-9' });

    const result = await service.send('bdq', dto(), '10.0.0.1');

    expect(result.channel).toBe('sms');
    expect(result.driver).toBe('skebby');
    expect(skebbyDriver.send).toHaveBeenCalled();
    expect(personalGsmDriver.send).not.toHaveBeenCalled();
  });

  it('default senza config: whatsapp primario, sms fallback', async () => {
    baoService.getSecret.mockImplementation(async (path: string) =>
      path.includes('evolution_apikey') ? { api_key: 'evo-key' } : null,
    );
    httpService.post.mockReturnValue(of({ data: { key: { id: 'wa-msg-2' } } }));

    const result = await service.send('bdq', dto(), '10.0.0.1');

    expect(result.channel).toBe('whatsapp');
    expect(result.usedFallback).toBe(false);
  });

  it('numero senza WhatsApp: il canale viene saltato e si passa a SMS', async () => {
    // Evolution accetterebbe il messaggio senza errore: senza il controllo
    // preventivo il cliente resterebbe senza codice.
    baoService.getSecret.mockImplementation(async (path: string) =>
      path.includes('evolution_apikey') ? { api_key: 'evo-key' } : null,
    );
    httpService.post.mockReturnValue(of({ data: [{ exists: false, number: '393471234567' }] }));
    personalGsmDriver.send.mockResolvedValue({ providerMessageId: 'gsm-2' });

    const result = await service.send(
      'bdq',
      dto({ channelPriority: ['whatsapp', 'sms'], smsDriver: 'personal_gsm' }),
      '10.0.0.1',
    );

    expect(result.channel).toBe('sms');
    // saltato per assenza da WhatsApp, non per un errore di consegna
    expect(result.usedFallback).toBe(false);
  });

  it('verifica numero non disponibile: si tenta WhatsApp lo stesso (fail-open)', async () => {
    // Una versione di Evolution senza quell'endpoint non deve impedire l'invio.
    baoService.getSecret.mockImplementation(async (path: string) =>
      path.includes('evolution_apikey') ? { api_key: 'evo-key' } : null,
    );
    let call = 0;
    httpService.post.mockImplementation(() => {
      call += 1;
      if (call === 1) throw new Error('404 not found');
      return of({ data: { key: { id: 'wa-msg-9' } } });
    });

    const result = await service.send(
      'bdq', dto({ channelPriority: ['whatsapp'] }), '10.0.0.1',
    );

    expect(result.channel).toBe('whatsapp');
    expect(result.providerMessageId).toBe('wa-msg-9');
  });

  it('numero registrato: WhatsApp procede', async () => {
    baoService.getSecret.mockImplementation(async (path: string) =>
      path.includes('evolution_apikey') ? { api_key: 'evo-key' } : null,
    );
    let call = 0;
    httpService.post.mockImplementation(() => {
      call += 1;
      return call === 1
        ? of({ data: [{ exists: true, number: '393471234567' }] })
        : of({ data: { key: { id: 'wa-msg-10' } } });
    });

    const result = await service.send('bdq', dto({ channelPriority: ['whatsapp'] }), '10.0.0.1');
    expect(result.channel).toBe('whatsapp');
  });

  it('canale email: consegna via SMTP con oggetto', async () => {
    smtpDriver.send.mockResolvedValue({ providerMessageId: 'smtp-1', from: 'noreply@curandis.cloud' });

    const result = await service.send(
      'bdq',
      dto({ email: 'mario.rossi@example.com', subject: 'Codice per firmare', channelPriority: ['email'] }),
      '10.0.0.1',
    );

    expect(result.channel).toBe('email');
    expect(result.driver).toBe('smtp');
    expect(result.recipientMasked).toBe('m*********i@example.com');
    expect(smtpDriver.send).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'mario.rossi@example.com', subject: 'Codice per firmare' }),
    );
    // l'indirizzo in chiaro non deve finire nell'audit
    const payload = auditService.log.mock.calls[0][0].payload;
    expect(JSON.stringify(payload)).not.toContain('mario.rossi@example.com');
  });

  it('salta i canali privi del recapito invece di fallire', async () => {
    // Nessun telefono: whatsapp e sms non sono utilizzabili, resta email.
    smtpDriver.send.mockResolvedValue({ providerMessageId: 'smtp-2', from: 'noreply@curandis.cloud' });

    const result = await service.send(
      'bdq',
      { message: 'codice 123456', email: 'a@b.it', channelPriority: ['whatsapp', 'sms', 'email'] } as SendOtpDto,
      '10.0.0.1',
    );

    expect(result.channel).toBe('email');
    // saltati per mancanza di recapito, non per errore: nessun fallback "vero"
    expect(result.usedFallback).toBe(false);
    expect(personalGsmDriver.send).not.toHaveBeenCalled();
    expect(httpService.post).not.toHaveBeenCalled();
  });

  it('nessun canale utilizzabile → BadGatewayException esplicita', async () => {
    await expect(
      service.send(
        'bdq',
        { message: 'codice', phone: '+393471234567', channelPriority: ['email'] } as SendOtpDto,
        '10.0.0.1',
      ),
    ).rejects.toThrow(/Nessun canale utilizzabile/);
    expect(smtpDriver.send).not.toHaveBeenCalled();
  });

  it('fallback eterogeneo: whatsapp fallisce → email consegna', async () => {
    baoService.getSecret.mockImplementation(async (path: string) =>
      path.includes('evolution_apikey') ? { api_key: 'evo-key' } : null,
    );
    httpService.post.mockImplementation(() => { throw new Error('evolution giù'); });
    smtpDriver.send.mockResolvedValue({ providerMessageId: 'smtp-3', from: 'noreply@curandis.cloud' });

    const result = await service.send(
      'bdq',
      dto({ email: 'mario@example.com', channelPriority: ['whatsapp', 'email'] }),
      '10.0.0.1',
    );

    expect(result.channel).toBe('email');
    expect(result.usedFallback).toBe(true);
  });

  it('tutti i canali falliscono → BadGatewayException + audit ERROR', async () => {
    personalGsmDriver.send.mockRejectedValue(new Error('gsm giù'));
    baoService.getSecret.mockResolvedValue(null); // niente token evolution

    await expect(
      service.send('bdq', dto({ channelPriority: ['sms', 'whatsapp'], smsDriver: 'personal_gsm' }), '10.0.0.1'),
    ).rejects.toThrow(BadGatewayException);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ERROR', status: 'FAILED' }),
    );
  });
});

describe('maskPhone', () => {
  it('maschera la parte centrale', () => {
    expect(maskPhone('+393471234567')).toBe('+39*******567');
    expect(maskPhone('12345')).toBe('***');
  });
});

describe('maskEmail', () => {
  it('lascia leggibile solo il dominio e le iniziali', () => {
    expect(maskEmail('mario.rossi@example.com')).toBe('m*********i@example.com');
    expect(maskEmail('ab@example.com')).toBe('a@example.com');
    expect(maskEmail('non-una-email')).toBe('***');
  });
});
