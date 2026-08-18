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
  );
  const build = (appointments: any[], jobRecapMessage?: string) =>
    (processor as any).buildRecapText(appointments, jobRecapMessage);

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

  it('ignora il recapMessage del job quando gli appuntamenti sono più di uno', () => {
    const text = build(
      [appt(), appt({ date: '2026-02-16T14:00:00' })],
      'Recap del primo appuntamento',
    );
    expect(text).not.toBe('Recap del primo appuntamento');
    expect(text).toContain('16/02/2026');
  });
});
