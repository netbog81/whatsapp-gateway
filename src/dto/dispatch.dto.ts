import {
  IsString,
  IsEnum,
  IsObject,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsInt,
  Matches,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export enum DispatchType {
  APPOINTMENT_BOOKING = 'APPOINTMENT_BOOKING',
  APPOINTMENT_UPDATE = 'APPOINTMENT_UPDATE',
  INTERNAL_TASK = 'INTERNAL_TASK',
}

/**
 * Cosa fare quando la fascia del giorno prima cadrebbe a MENO di 24h
 * dall'appuntamento, cioè per gli appuntamenti che iniziano prima della fine
 * della fascia (con il default 08:30-09:00: quelli prima delle 09:00).
 */
export enum ReminderEarlyPolicy {
  /** Arretra alla fascia del giorno ancora precedente: le 24h restano garantite. */
  SHIFT_PREVIOUS_DAY = 'SHIFT_PREVIOUS_DAY',
  /** Invia all'ora esatta -24h, fuori fascia e fuori dalla distribuzione. */
  EXACT_24H = 'EXACT_24H',
  /** Invia comunque in fascia, accettando un preavviso inferiore alle 24h. */
  FORCE_WINDOW = 'FORCE_WINDOW',
}

/** Formato degli orari di fascia accettati dal gateway: HH:mm 24h. */
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class BookingDataDto {
  @ApiProperty({ example: '10255', description: 'ID appuntamento nel DB Main App' })
  @IsString()
  appointmentId: string;

  @ApiProperty({ example: 'paz_99', description: 'ID del paziente' })
  @IsString()
  pazienteId: string;

  @ApiProperty({ example: '393471234567', description: 'Numero di telefono con prefisso' })
  @IsString()
  phone: string;

  @ApiProperty({
    example: '2026-02-15T10:30:00',
    description:
      'Data e ora appuntamento (ISO 8601). Se privo di offset viene interpretato come ora locale Europe/Rome ' +
      '(modo consigliato: evita gli errori di un\'ora fra ora solare e ora legale).',
  })
  @IsString()
  date: string;

  @ApiProperty({ example: 'Mario Rossi', description: 'Nome del paziente' })
  @IsString()
  name: string;

  @ApiProperty({
    example: 'Gentile Mario Rossi, confermiamo il suo appuntamento per il 15/02/2026 alle 10:30.',
    description: 'Testo recap personalizzato (opzionale). Se omesso il gateway genera il testo di default.',
    required: false,
  })
  @IsOptional()
  @IsString()
  recapMessage?: string;

  @ApiProperty({
    example: 'Promemoria: il suo appuntamento è domani alle 10:30.',
    description: 'Testo reminder 24h personalizzato (opzionale). Se omesso il gateway genera il testo di default.',
    required: false,
  })
  @IsOptional()
  @IsString()
  reminderMessage?: string;

  @ApiProperty({
    example: 'Promemoria: il suo appuntamento è dopodomani alle 10:30.',
    description:
      'Testo del promemoria da usare quando l\'invio parte DUE giorni prima dell\'appuntamento ' +
      '(politica reminderEarlyPolicy=SHIFT_PREVIOUS_DAY). Serve perché in quel caso "domani" sarebbe ' +
      'sbagliato. Se omesso viene usato reminderMessage.',
    required: false,
  })
  @IsOptional()
  @IsString()
  reminderMessageEarly?: string;

  @ApiProperty({
    example: 'Gentile Mario Rossi, confermiamo i seguenti appuntamenti:\n{appointments}',
    description:
      'Template recap multiplo NON renderizzato, usato solo quando nella finestra di buffer (60s) ' +
      'si accumula più di un appuntamento per lo stesso numero. Il gateway sostituisce {appointments} ' +
      'con l\'elenco delle recapLine bufferizzate e {name} con il nome del paziente.',
    required: false,
  })
  @IsOptional()
  @IsString()
  recapMultiTemplate?: string;

  @ApiProperty({
    example: '- 15/02/2026 alle 10:30',
    description: 'Riga di questo appuntamento nel recap multiplo (già formattata dalla main-app).',
    required: false,
  })
  @IsOptional()
  @IsString()
  recapLine?: string;

  @ApiProperty({
    example: 60,
    description:
      'Finestra di raggruppamento del recap in secondi (30-600, default 60). Il conteggio riparte a ogni ' +
      'nuovo appuntamento per lo stesso numero, fino a un massimo di 5 volte la finestra (max 15 minuti).',
    required: false,
    minimum: 30,
    maximum: 600,
  })
  @IsOptional()
  @IsInt()
  @Min(30)
  @Max(600)
  recapDelaySeconds?: number;

  @ApiProperty({
    example: true,
    description:
      'Invia il recap SUBITO, saltando la finestra di raggruppamento. Da usare quando il recap è stato ' +
      "chiesto a mano dalla segreteria: chi preme il pulsante si aspetta che il messaggio parta, non che " +
      'entri in una coda di qualche minuto insieme ad altri appuntamenti. Default: false.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  recapImmediate?: boolean;

  @ApiProperty({
    example: '08:30',
    description:
      'Inizio della fascia oraria (HH:mm, Europe/Rome) in cui far partire il promemoria del giorno prima. ' +
      'Se assente insieme a reminderWindowEnd il promemoria parte all\'ora esatta -24h (comportamento storico). ' +
      'Dentro la fascia gli invii vengono distribuiti con intervalli casuali, per non far partire ' +
      'tutti i promemoria del giorno in blocco.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(HH_MM, { message: 'reminderWindowStart deve essere nel formato HH:mm' })
  reminderWindowStart?: string;

  @ApiProperty({
    example: '09:00',
    description: 'Fine della fascia oraria (HH:mm, Europe/Rome). Deve essere successiva a reminderWindowStart.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(HH_MM, { message: 'reminderWindowEnd deve essere nel formato HH:mm' })
  reminderWindowEnd?: string;

  @ApiProperty({
    enum: ReminderEarlyPolicy,
    example: ReminderEarlyPolicy.SHIFT_PREVIOUS_DAY,
    description:
      'Appuntamenti che iniziano prima della fine della fascia (default: prima delle 09:00): per loro la ' +
      'fascia del giorno prima cadrebbe a meno di 24h. SHIFT_PREVIOUS_DAY (default) arretra alla fascia del ' +
      'giorno ancora precedente, EXACT_24H invia a -24h esatte fuori fascia, FORCE_WINDOW invia comunque in ' +
      'fascia accettando meno di 24h di preavviso.',
    required: false,
  })
  @IsOptional()
  @IsEnum(ReminderEarlyPolicy)
  reminderEarlyPolicy?: ReminderEarlyPolicy;

  @ApiProperty({
    example: 'Gentile Mario Rossi, il suo appuntamento è stato spostato al 16/02/2026 alle 11:00.',
    description:
      'Testo notifica di modifica appuntamento (solo per type=APPOINTMENT_UPDATE). ' +
      'Se omesso il gateway genera il testo di default.',
    required: false,
  })
  @IsOptional()
  @IsString()
  updateMessage?: string;

  @ApiProperty({
    example: true,
    description:
      'Solo per type=APPOINTMENT_UPDATE: se false il gateway riprogramma il reminder senza avvisare il paziente. Default: true.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  sendUpdateNotification?: boolean;
}

export class DispatchDto {
  @ApiProperty({ enum: DispatchType, description: 'Tipo di operazione richiesta' })
  @IsEnum(DispatchType)
  type: DispatchType;

  @ApiProperty({ description: 'Dati specifici per l\'operazione (es. dettagli appuntamento)' })
  @IsObject()
  @ValidateNested()
  @Type(() => BookingDataDto)
  data: BookingDataDto;

  @ApiProperty({
    description: 'ID univoco per tracciabilità (generato dalla Main App)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000'
  })
  @IsOptional()
  @IsUUID()
  correlationId?: string;
}
