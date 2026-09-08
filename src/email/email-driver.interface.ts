/**
 * Astrazione del canale email del gateway. Come per gli SMS, il gateway
 * è un "dumb pipe": riceve il testo già renderizzato (per gli OTP include
 * il codice) e NON deve mai loggarlo né persisterlo.
 */
export interface EmailSendInput {
  tenantId: string;
  /** Destinatario. */
  email: string;
  /** Oggetto; se assente il driver ne usa uno neutro. */
  subject?: string;
  /** Corpo testuale. MAI loggare. */
  message: string;
  /**
   * Nome visualizzato del mittente, per questo messaggio.
   *
   * Sovrascrive quello della configurazione SMTP: e' il nome dello studio,
   * che non e' un segreto e vive nelle impostazioni del modulo, non in
   * OpenBao. Sul relay condiviso e' l'unico modo per cui il paziente veda
   * la propria struttura invece della SaaS.
   */
  fromName?: string;
}

export interface EmailSendResult {
  providerMessageId?: string;
  /** Mittente effettivamente usato, utile nelle evidence. */
  from: string;
}

/**
 * Configurazione SMTP risolta per un tenant.
 *
 * Due modalità (decisione 2026-08-08):
 *  - relay unico SaaS con mittente personalizzato per struttura — default,
 *    nessuna configurazione richiesta al tenant;
 *  - SMTP proprio del tenant, che sovrascrive tutto.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  /** true = TLS implicito (465); false = STARTTLS opportunistico (587). */
  secure: boolean;
  user?: string;
  password?: string;
  /** Indirizzo mittente. */
  from: string;
  /** Nome visualizzato (di norma la denominazione della struttura). */
  fromName?: string;
  /** 'tenant' se il tenant ha un SMTP proprio, 'saas' se usa il relay comune. */
  source: 'tenant' | 'saas';
}
