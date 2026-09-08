import { WhatsappProcessor } from './whatsapp.processor';

/**
 * Composizione del testo di recap: è l'unico punto in cui il gateway mette
 * insieme i template del tenant (che arrivano dalla main-app) con i dati
 * accumulati nel buffer di 60s.
 */
describe('WhatsappProcessor.buildRecapText', () => {
  // buildRecapText è una funzione pura: niente dipendenze da iniettare.
  const processor = new WhatsappProcessor(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
  const build = (appointments: any[], jobRecapMessage?: string) =>
    (processor as any).buildRecapText('booking', appointments, jobRecapMessage);
  const sort = (appointments: any[]) =>
    (processor as any).sortChronologically(appointments);

  const appt = (extra: Record<string, any> = {}) => ({
    date: '2026-02-15T10:30:00',
    name: 'Mario Rossi',
    ...extra,
  });

  it('usa il recap singolo renderizzato dalla main-app', () => {
    const text = build([appt({ recapMessage: 'Testo dal template' })]);
    expect(text).toBe('Testo dal template');
  });

  it('senza template ricade sul testo di default con l\'ora locale di Roma', () => {
    const text = build([appt()]);
    expect(text).toBe(
      'Gentile Mario Rossi, confermiamo il suo appuntamento per il 15/02/2026 alle 10:30.',
    );
  });

  it('interpreta le date senza offset come ora locale italiana (no shift DST)', () => {
    // 18:00 in piena ora legale: senza offset non deve diventare 19:00 o 20:00
    const text = build([appt({ date: '2026-08-05T18:00:00' })]);
    expect(text).toContain('alle 18:00');
  });

  it('compone il recap multiplo dal template del tenant', () => {
    const text = build([
      appt({
        recapMultiTemplate: 'Ciao {name}, ecco i tuoi appuntamenti:\n{appointments}',
        recapLine: '- 15/02/2026 alle 10:30',
      }),
      appt({ date: '2026-02-16T14:00:00', recapLine: '- 16/02/2026 alle 14:00' }),
    ]);

    expect(text).toBe(
      'Ciao Mario Rossi, ecco i tuoi appuntamenti:\n- 15/02/2026 alle 10:30\n- 16/02/2026 alle 14:00',
    );
  });

  it('senza template multiplo ricade sull\'elenco di default', () => {
    const text = build([appt(), appt({ date: '2026-02-16T14:00:00' })]);

    expect(text).toBe(
      'Gentile Mario Rossi, confermiamo i seguenti appuntamenti:\n' +
        '- 15/02/2026 alle 10:30\n- 16/02/2026 alle 14:00',
    );
  });

  it('ordina gli appuntamenti dal più prossimo al più lontano', () => {
    // Ordine di prenotazione invertito rispetto a quello cronologico: è il
    // caso reale di chi fissa prima l'appuntamento lontano e poi quello vicino.
    const ordered = sort([
      appt({ date: '2026-02-20T09:00:00', recapLine: '- 20/02/2026 alle 09:00' }),
      appt({ date: '2026-02-08T11:00:00', recapLine: '- 08/02/2026 alle 11:00' }),
      appt({ date: '2026-02-15T10:30:00', recapLine: '- 15/02/2026 alle 10:30' }),
    ]);

    expect(build(ordered)).toBe(
      'Gentile Mario Rossi, confermiamo i seguenti appuntamenti:\n' +
        '- 08/02/2026 alle 11:00\n- 15/02/2026 alle 10:30\n- 20/02/2026 alle 09:00',
    );
  });

  it('a parità di giorno ordina per orario e non perde chi non ha data', () => {
    const ordered = sort([
      appt({ date: '2026-02-15T16:00:00' }),
      appt({ date: undefined }),
      appt({ date: '2026-02-15T09:00:00' }),
    ]);

    expect(ordered.map((a: any) => a.date)).toEqual([
      '2026-02-15T09:00:00',
      '2026-02-15T16:00:00',
      undefined,
    ]);
  });

  it('non muta l\'array ricevuto', () => {
    const input = [appt({ date: '2026-02-20T09:00:00' }), appt({ date: '2026-02-08T11:00:00' })];
    sort(input);
    expect(input[0].date).toBe('2026-02-20T09:00:00');
  });

  it('ignora il recapMessage del job quando gli appuntamenti sono più di uno', () => {
    const text = build(
      [appt(), appt({ date: '2026-02-16T14:00:00' })],
      'Recap del primo appuntamento',
    );
    expect(text).not.toBe('Recap del primo appuntamento');
    expect(text).toContain('16/02/2026');
  });
});

/**
 * Spostamenti e disdette passano dallo stesso raggruppamento delle
 * prenotazioni, ma con testi propri: cancellati e spostati non si mescolano
 * mai nello stesso messaggio, perché sono due notizie diverse.
 */
describe('WhatsappProcessor.buildRecapText — spostamenti e disdette', () => {
  const processor = new WhatsappProcessor(
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
    null as any,
  );
  const build = (kind: string, appointments: any[], jobMessage?: string) =>
    (processor as any).buildRecapText(kind, appointments, jobMessage);

  const moved = (extra: Record<string, any> = {}) => ({
    date: '2026-02-22T11:00:00',
    previousDate: '2026-02-15T10:30:00',
    name: 'Mario Rossi',
    ...extra,
  });

  describe('spostamenti', () => {
    it('usa il testo singolo renderizzato dalla main-app', () => {
      const text = build('update', [moved({ updateMessage: 'Spostato a lunedì' })]);
      expect(text).toBe('Spostato a lunedì');
    });

    it('compone l\'elenco dal template del tenant', () => {
      const text = build('update', [
        moved({ updateLine: '- 15/02 10:30 → 22/02 11:00', updateMultiTemplate: 'Ciao {name}:\n{appointments}' }),
        moved({ date: '2026-03-01T09:00:00', updateLine: '- 20/02 09:00 → 01/03 09:00' }),
      ]);
      expect(text).toBe('Ciao Mario Rossi:\n- 15/02 10:30 → 22/02 11:00\n- 20/02 09:00 → 01/03 09:00');
    });

    it('senza template mostra da dove a dove, non solo la destinazione', () => {
      // Con più spostamenti insieme il solo orario nuovo non direbbe al
      // paziente QUALE dei suoi appuntamenti si è mosso.
      const text = build('update', [moved(), moved({ date: '2026-03-01T09:00:00' })]);
      expect(text).toContain('15/02/2026 10:30 → 22/02/2026 11:00');
      expect(text).toContain('sono stati spostati');
    });

    it('senza data di partenza ricade sulla sola destinazione', () => {
      const text = build('update', [
        moved({ previousDate: undefined }),
        moved({ date: '2026-03-01T09:00:00', previousDate: undefined }),
      ]);
      expect(text).toContain('- 22/02/2026 alle 11:00');
    });
  });

  describe('disdette', () => {
    const dropped = (extra: Record<string, any> = {}) => ({
      date: '2026-02-15T10:30:00',
      name: 'Mario Rossi',
      ...extra,
    });

    it('usa il testo singolo renderizzato dalla main-app', () => {
      const text = build('cancel', [dropped({ cancelNotificationMessage: 'Disdetta confermata' })]);
      expect(text).toBe('Disdetta confermata');
    });

    it('compone l\'elenco dal template del tenant', () => {
      const text = build('cancel', [
        dropped({ cancelLine: '- 15/02 10:30', cancelMultiTemplate: '{name}, annullati:\n{appointments}' }),
        dropped({ date: '2026-02-20T09:00:00', cancelLine: '- 20/02 09:00' }),
      ]);
      expect(text).toBe('Mario Rossi, annullati:\n- 15/02 10:30\n- 20/02 09:00');
    });

    it('senza nome né data resta una frase sensata', () => {
      // Il tenant può aver disattivato il template: meglio una frase generica
      // che un messaggio vuoto.
      const text = build('cancel', [{ }]);
      expect(text).toBe('Il suo appuntamento è stato cancellato.');
    });

    it('senza template ricade sull\'elenco di default', () => {
      const text = build('cancel', [dropped(), dropped({ date: '2026-02-20T09:00:00' })]);
      expect(text).toContain('sono stati cancellati');
      expect(text).toContain('- 15/02/2026 alle 10:30');
      expect(text).toContain('- 20/02/2026 alle 09:00');
    });
  });
});

/**
 * Ordine di lettura: prima cosa hai prenotato, poi cosa si è spostato, infine
 * cosa è saltato. Chi telefona per riorganizzare di solito fa tutte e tre le
 * cose nella stessa telefonata, e le tre finestre scadono a ridosso.
 */
describe('WhatsappProcessor.deferBehindEarlierKinds', () => {
  const makeProcessor = (queue: any) =>
    new WhatsappProcessor(
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      null as any,
      queue,
    );

  const job = (name: string, data: Record<string, any> = {}) => ({
    name,
    data: { tenantId: 'tenant-1', phone: '393471234567', ...data },
  });

  const defer = (processor: any, kind: string, j: any) =>
    (processor as any).deferBehindEarlierKinds(kind, j);

  it('le prenotazioni non aspettano nessuno', async () => {
    const queue = { getJob: jest.fn(), add: jest.fn() };
    expect(await defer(makeProcessor(queue), 'booking', job('process-recap'))).toBe(false);
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('la disdetta si fa da parte se la conferma deve ancora uscire', async () => {
    const queue = {
      getJob: jest.fn().mockImplementation(async (id: string) =>
        id === 'timer-recap:tenant-1:393471234567'
          ? { timestamp: Date.now(), delay: 30_000 }
          : null,
      ),
      add: jest.fn().mockResolvedValue({}),
    };
    const processor = makeProcessor(queue);

    expect(await defer(processor, 'cancel', job('process-cancel-recap'))).toBe(true);
    const [name, data, opts] = queue.add.mock.calls[0];
    expect(name).toBe('process-cancel-recap');
    expect(data.deferCount).toBe(1);
    expect(opts.delay).toBeGreaterThan(29_000);
    // Id distinto: quello canonico è del job ancora attivo.
    expect(opts.jobId).toBe('timer-cancel-recap:tenant-1:393471234567:defer:1');
  });

  it('non aspetta un raggruppamento che sta già partendo', async () => {
    // Finestra scaduta: alla sequenza pensa la coda, che ha un solo worker.
    const queue = {
      getJob: jest.fn().mockResolvedValue({ timestamp: Date.now() - 60_000, delay: 30_000 }),
      add: jest.fn(),
    };
    expect(await defer(makeProcessor(queue), 'cancel', job('process-cancel-recap'))).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('dopo troppi rinvii parte comunque', async () => {
    const queue = {
      getJob: jest.fn().mockResolvedValue({ timestamp: Date.now(), delay: 30_000 }),
      add: jest.fn(),
    };
    const j = job('process-cancel-recap', { deferCount: 3 });
    expect(await defer(makeProcessor(queue), 'cancel', j)).toBe(false);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('la disdetta aspetta anche gli spostamenti, non solo le conferme', async () => {
    const queue = {
      getJob: jest.fn().mockImplementation(async (id: string) =>
        id === 'timer-update-recap:tenant-1:393471234567'
          ? { timestamp: Date.now(), delay: 45_000 }
          : null,
      ),
      add: jest.fn().mockResolvedValue({}),
    };
    expect(await defer(makeProcessor(queue), 'cancel', job('process-cancel-recap'))).toBe(true);
    expect(queue.add.mock.calls[0][2].delay).toBeGreaterThan(44_000);
  });

  it('aspetta il più lontano dei due che lo precedono', async () => {
    const queue = {
      getJob: jest.fn().mockImplementation(async (id: string) => {
        if (id === 'timer-recap:tenant-1:393471234567') return { timestamp: Date.now(), delay: 20_000 };
        if (id === 'timer-update-recap:tenant-1:393471234567') return { timestamp: Date.now(), delay: 90_000 };
        return null;
      }),
      add: jest.fn().mockResolvedValue({}),
    };
    expect(await defer(makeProcessor(queue), 'cancel', job('process-cancel-recap'))).toBe(true);
    expect(queue.add.mock.calls[0][2].delay).toBeGreaterThan(89_000);
  });
});
