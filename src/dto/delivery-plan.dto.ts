import {
  IsArray, IsEmail, IsIn, IsObject, IsOptional, IsString, MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Piano di consegna multicanale che la main-app allega a una richiesta.
 *
 * Ereditato dai DTO delle operazioni (prenotazione, spostamento, disdetta)
 * invece di essere ripetuto in ognuno: sono gli stessi campi con lo stesso
 * significato, e tre copie sarebbero divergite alla prima aggiunta.
 *
 * Tutto facoltativo: senza piano il gateway si comporta esattamente come
 * prima, cioe' solo WhatsApp. Chi non ha configurato altri canali non deve
 * accorgersi che questa possibilita' esiste.
 *
 * La SCELTA dei canali resta della main-app, che sa chi e' il paziente e cosa
 * ha chiesto: qui arriva gia' decisa.
 */
export class DeliveryPlanDto {
  @ApiProperty({
    required: false,
    isArray: true,
    enum: ['whatsapp', 'sms', 'email'],
    description:
      'Canali in ordine di preferenza: il primo che riesce vince. I canali privi del ' +
      'recapito necessario vengono saltati senza contare come errore. Omesso = solo WhatsApp.',
    example: ['whatsapp', 'sms'],
  })
  @IsOptional()
  @IsArray()
  @IsIn(['whatsapp', 'sms', 'email'], { each: true })
  channels?: ('whatsapp' | 'sms' | 'email')[];

  @ApiProperty({
    required: false,
    isArray: true,
    enum: ['whatsapp', 'sms', 'email'],
    description:
      'Canali per il PROMEMORIA, se diversi da quelli della conferma. Una stessa ' +
      'richiesta genera due messaggi di categorie diverse (conferma subito, promemoria ' +
      'il giorno prima) e lo studio puo\' averle configurate su canali diversi — tipico: ' +
      'la conferma su WhatsApp che non costa, il promemoria anche via SMS. ' +
      'Omesso = si usano gli stessi di `channels`.',
    example: ['whatsapp', 'sms'],
  })
  @IsOptional()
  @IsArray()
  @IsIn(['whatsapp', 'sms', 'email'], { each: true })
  reminderChannels?: ('whatsapp' | 'sms' | 'email')[];

  @ApiProperty({
    required: false,
    description: "Email del destinatario. Senza questa il canale email viene saltato.",
    example: 'mario.rossi@example.com',
  })
  @IsOptional()
  @IsEmail({}, { message: 'email non valida' })
  @MaxLength(320)
  email?: string;

  @ApiProperty({
    required: false,
    enum: ['personal_gsm', 'skebby'],
    description: 'Quale driver SMS usare. Omesso = personal_gsm.',
  })
  @IsOptional()
  @IsIn(['personal_gsm', 'skebby'])
  smsDriver?: 'personal_gsm' | 'skebby';

  @ApiProperty({ required: false, description: "Oggetto dell'email. Ignorato dagli altri canali." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  emailSubject?: string;

  @ApiProperty({
    required: false,
    description: "Corpo dell'email, quando puo' essere piu' disteso del testo WhatsApp.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  emailBody?: string;

  @ApiProperty({
    required: false,
    description:
      "Nome visualizzato come mittente dell'email (denominazione della struttura). " +
      'Sovrascrive quello della configurazione SMTP.',
    example: 'Studio BDQ',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  emailFromName?: string;

  @ApiProperty({
    required: false,
    description: "Testo dedicato all'SMS, quando serve piu' corto di quello WhatsApp.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(480)
  smsText?: string;

  @ApiProperty({
    required: false,
    type: 'object',
    additionalProperties: true,
    description:
      'Testi per canale, indicizzati per TIPO di messaggio (single_recap, multiple_recap, ' +
      'reminder_24h, reminder_48h, update_notification, cancel_notification, ...). ' +
      'Una sola richiesta genera messaggi di tipi diversi in momenti diversi — la conferma ' +
      "subito, il promemoria il giorno prima, e l'elenco raggruppato solo se nel frattempo " +
      'arrivano altre prenotazioni: quale sara' + "'" + ' lo si sa solo al momento di spedire, ' +
      'quindi viaggiano tutti e si sceglie li' + "'" + '. ' +
      'Ogni voce: { sms?, emailSubject?, emailBody? }. Assente = si usa il testo WhatsApp.',
    example: {
      reminder_24h: { sms: 'Promemoria: domani alle 10:00', emailSubject: 'Il suo appuntamento' },
    },
  })
  @IsOptional()
  @IsObject()
  channelTexts?: Record<string, { sms?: string; emailSubject?: string; emailBody?: string }>;
}
