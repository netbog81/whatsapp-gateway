/**
 * Raggruppamento dei messaggi automatici per numero di telefono.
 *
 * Tre cose diverse possono succedere agli appuntamenti di una stessa persona
 * nel giro di pochi minuti — ne prenota di nuovi, ne sposta, ne disdice — e
 * ognuna merita UN messaggio con l'elenco, non uno per appuntamento. Chi
 * telefona per riorganizzare la settimana altrimenti riceve dieci WhatsApp a
 * dieci secondi l'uno dall'altro (il processor tiene i messaggi automatici
 * dello stesso tenant a distanza di 10s).
 *
 * Ogni tipo ha buffer, timer e messaggio propri: cancellati e spostati non si
 * mescolano mai nello stesso testo, perché sono due notizie diverse.
 *
 * Le chiavi stanno qui e non nei due chiamanti perché service (che riempie il
 * buffer) e processor (che lo svuota) devono per forza guardare lo stesso
 * posto: quando erano scritte a mano in due file, bastava un refuso perché il
 * recap uscisse vuoto.
 */

/** I tre raggruppamenti, in ordine di lettura per il paziente. */
export type RecapKind = 'booking' | 'update' | 'cancel';

/**
 * Ordine con cui i tre messaggi devono raggiungere il paziente quando le
 * finestre scadono a ridosso: prima cosa ha prenotato, poi cosa si è spostato,
 * infine cosa è saltato. Leggere "disdetto" prima di "confermiamo" è
 * incomprensibile, e il caso è tutt'altro che raro: chi telefona per spostare
 * di solito disdice e riprenota nella stessa telefonata.
 */
export const RECAP_KIND_ORDER: RecapKind[] = ['booking', 'update', 'cancel'];

/**
 * Scarto con cui un raggruppamento si rimette in coda dietro a uno che deve
 * uscire prima. Basta che i job diventino eseguibili in ordine: alla distanza
 * vera fra i due invii pensa poi il rate limit del processor.
 */
export const RECAP_DEFER_MARGIN_MS = 2000;

/**
 * Quante volte un raggruppamento può farsi da parte prima di partire comunque.
 * Serve solo come fondo corsa: la finestra che lo precede ha già un tetto
 * proprio, quindi in condizioni normali un rinvio o due bastano.
 */
export const RECAP_MAX_DEFERRALS = 3;

/** Chiavi Redis e identificativi di coda di un raggruppamento. */
export interface RecapBufferKeys {
  /** Lista Redis con i payload cifrati accumulati. */
  listKey: string;
  /** Istante di apertura della finestra, per il tetto allo slittamento. */
  startKey: string;
  /** Job BullMQ che allo scadere svuota il buffer. */
  jobId: string;
  /** Nome del job, che è anche il ramo scelto dal processor. */
  jobName: string;
}

/**
 * Chiavi del raggruppamento `kind` per un numero di telefono.
 *
 * Le prenotazioni conservano le chiavi STORICHE (`pending:{tenant}:{phone}`,
 * `process-recap`): al momento del deploy ci sono buffer pieni e timer già
 * programmati, e rinominarli significherebbe perdere per strada le conferme
 * dei pazienti che stavano prenotando in quel minuto.
 */
export function recapKeys(kind: RecapKind, tenantId: string, phone: string): RecapBufferKeys {
  const keyInfix = kind === 'booking' ? '' : `${kind}:`;
  const jobInfix = kind === 'booking' ? '' : `${kind}-`;

  return {
    listKey: `pending:${keyInfix}${tenantId}:${phone}`,
    startKey: `recap_start:${keyInfix}${tenantId}:${phone}`,
    jobId: `timer-${jobInfix}recap:${tenantId}:${phone}`,
    jobName: kind === 'booking' ? 'process-recap' : `process-${kind}-recap`,
  };
}

/** Raggruppamento a cui appartiene un job, o null se il job è di altro tipo. */
export function recapKindOfJob(jobName: string): RecapKind | null {
  return RECAP_KIND_ORDER.find(kind => recapKeys(kind, '', '').jobName === jobName) ?? null;
}

/** I raggruppamenti che devono uscire PRIMA di quello indicato. */
export function earlierKinds(kind: RecapKind): RecapKind[] {
  return RECAP_KIND_ORDER.slice(0, RECAP_KIND_ORDER.indexOf(kind));
}

/**
 * Tipo di messaggio dichiarato a Evolution e alla main-app, che lo usa per
 * riconciliare i propri log. I nomi al singolare sono quelli storici e non
 * vanno cambiati: la main-app li riconosce già.
 */
export function recapMessageType(kind: RecapKind, count: number): string {
  const single = count === 1;
  switch (kind) {
    case 'booking':
      return single ? 'single_recap' : 'multiple_recap';
    case 'update':
      return single ? 'update_notification' : 'multiple_update';
    case 'cancel':
      return single ? 'cancel_notification' : 'multiple_cancel';
  }
}
