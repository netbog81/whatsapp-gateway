import { PersonalGsmDriver } from './personal-gsm.driver';
import { SkebbyDriver } from './skebby.driver';

/**
 * Ripiego condiviso della SaaS per gli SMS.
 *
 * Stessa forma di `mail/saas-relay` per l'email: un tenant senza apparato
 * proprio manda comunque, senza che qualcuno debba ricordarsi di copiargli la
 * configurazione. Il caso che conta e' quello parziale — un secret del tenant
 * che esiste ma e' incompleto non deve bloccare l'invio fingendo di essere
 * una configurazione valida.
 */
describe('PersonalGsmDriver — configurazione a due livelli', () => {
  const make = (secrets: Record<string, any>) => {
    const bao = {
      getSecret: jest.fn(async (path: string) => secrets[path] ?? null),
    };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    const driver = new PersonalGsmDriver(null as any, bao as any, redis as any);
    return { driver, bao, redis };
  };

  const config = (driver: PersonalGsmDriver, tenant = 'bdq') =>
    (driver as any).getConfig(tenant);

  it('il device del tenant vince su quello condiviso', async () => {
    const { driver } = make({
      'sms/bdq/gsm_gateway': { base_url: 'http://192.168.1.50:8080' },
      'sms/saas-relay/gsm_gateway': { base_url: 'http://relay:8080' },
    });

    const resolved = await config(driver);

    expect(resolved.base_url).toBe('http://192.168.1.50:8080');
    expect(resolved.source).toBe('tenant');
  });

  it('senza device proprio si usa quello condiviso', async () => {
    const { driver } = make({ 'sms/saas-relay/gsm_gateway': { base_url: 'http://relay:8080' } });

    const resolved = await config(driver);

    expect(resolved.base_url).toBe('http://relay:8080');
    expect(resolved.source).toBe('saas');
  });

  it('secret del tenant senza base_url: si ripiega invece di fallire', async () => {
    const { driver } = make({
      // Configurazione lasciata a metà: c'è la chiave ma manca l'indirizzo.
      'sms/bdq/gsm_gateway': { api_key: 'abc' },
      'sms/saas-relay/gsm_gateway': { base_url: 'http://relay:8080' },
    });

    const resolved = await config(driver);

    expect(resolved.source).toBe('saas');
  });

  it('niente da nessuna parte: null, e il chiamante spiega entrambi i percorsi', async () => {
    const { driver } = make({});

    expect(await config(driver)).toBeNull();

    await expect(
      driver.send({ tenantId: 'bdq', phone: '+393471234567', message: 'x' }),
    ).rejects.toThrow(/sms\/bdq\/gsm_gateway.*sms\/saas-relay\/gsm_gateway/s);
  });

  it("l'esito condiviso finisce in cache: niente doppia lettura a ogni SMS", async () => {
    const { driver, redis } = make({ 'sms/saas-relay/gsm_gateway': { base_url: 'http://relay:8080' } });

    await config(driver);

    expect(redis.set).toHaveBeenCalledWith(
      'sms:gsm:config:bdq', expect.stringContaining('relay'), 'EX', 600,
    );
  });
});

describe('SkebbyDriver — configurazione a due livelli', () => {
  const make = (secrets: Record<string, any>) => {
    const bao = { getSecret: jest.fn(async (path: string) => secrets[path] ?? null) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    const driver = new SkebbyDriver(null as any, null as any, bao as any, redis as any);
    return { driver, redis };
  };

  const resolve = (driver: SkebbyDriver, tenant = 'bdq') =>
    (driver as any).resolveConfig(tenant);

  it("l'account del tenant vince su quello condiviso", async () => {
    const { driver } = make({
      'sms/bdq/skebby': { username: 'tenant', password: 'p' },
      'sms/saas-relay/skebby': { username: 'saas', password: 'p' },
    });

    expect((await resolve(driver)).username).toBe('tenant');
  });

  it('credenziali incomplete del tenant: si ripiega sul condiviso', async () => {
    const { driver } = make({
      'sms/bdq/skebby': { username: 'tenant' }, // manca la password
      'sms/saas-relay/skebby': { username: 'saas', password: 'p' },
    });

    const resolved = await resolve(driver);

    expect(resolved.username).toBe('saas');
    expect(resolved.source).toBe('saas');
  });

  it("la sessione dell'account condiviso è unica, non una per tenant", async () => {
    const { driver, redis } = make({});
    redis.get.mockResolvedValue('user-key;session-key');

    const session = await (driver as any).getSession('saas-relay', {}, 'http://api', false);

    // Cercata sotto l'account, non sotto il tenant: due tenant che usano il
    // relay condividono la stessa sessione invece di scadersela a vicenda.
    expect(redis.get).toHaveBeenCalledWith('sms:skebby:session:saas-relay');
    expect(session).toEqual(['user-key', 'session-key']);
  });
});
