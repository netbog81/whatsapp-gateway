/**
 * Astrazione driver SMS del gateway. Due implementazioni:
 *  - PersonalGsmDriver: gateway GSM fisico di rete (HTTP API sul device)
 *  - SkebbyDriver: provider SMS commerciale
 *
 * Il gateway è "dumb pipe": riceve il testo già renderizzato (per gli OTP
 * include il codice) e NON deve mai loggarlo né persisterlo.
 */
export interface SmsSendInput {
  tenantId: string;
  /** Numero destinatario, formato internazionale (es. +393471234567). */
  phone: string;
  /** Testo del messaggio. MAI loggare. */
  message: string;
}

export interface SmsSendResult {
  providerMessageId?: string;
}

export interface SmsDriver {
  /** Nome riportato nelle evidence della ceremony (es. 'personal_gsm', 'skebby'). */
  readonly name: string;
  send(input: SmsSendInput): Promise<SmsSendResult>;
}

export type SmsDriverName = 'personal_gsm' | 'skebby';
