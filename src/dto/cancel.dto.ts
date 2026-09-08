import { IsString, IsOptional, IsBoolean, IsUUID, IsInt, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { DeliveryPlanDto } from './delivery-plan.dto';

export class CancelDto extends DeliveryPlanDto {
  @ApiProperty({ example: '10255', description: 'ID appuntamento da cancellare' })
  @IsString()
  appointmentId: string;

  @ApiProperty({ example: 'paz_99', description: 'ID del paziente' })
  @IsString()
  pazienteId: string;

  @ApiProperty({ example: '393471234567', description: 'Numero di telefono del paziente' })
  @IsString()
  phone: string;

  @ApiProperty({
    example: true,
    description: 'Se true, invia un messaggio WhatsApp di notifica cancellazione al paziente. Default: false.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  sendCancelNotification?: boolean;

  @ApiProperty({
    example: 'Gentile Mario Rossi, il suo appuntamento del 15/02/2026 alle 10:30 è stato cancellato.',
    description: 'Testo notifica cancellazione personalizzato. Usato solo se sendCancelNotification=true. Se omesso il gateway genera il testo di default.',
    required: false,
  })
  @IsOptional()
  @IsString()
  cancelNotificationMessage?: string;

  @ApiProperty({ example: 'Mario Rossi', description: 'Nome del paziente (usato nel messaggio di default)', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: '2026-02-15T10:30:00Z', description: 'Data appuntamento ISO 8601 (usata nel messaggio di default)', required: false })
  @IsOptional()
  @IsString()
  date?: string;

  @ApiProperty({
    example: 'Gentile Mario Rossi, i seguenti appuntamenti sono stati cancellati:\n{appointments}',
    description:
      'Template NON renderizzato per la disdetta di PIÙ appuntamenti dello stesso numero dentro la ' +
      'finestra di raggruppamento. Il gateway sostituisce {appointments} con l\'elenco delle cancelLine ' +
      'bufferizzate e {name} con il nome del paziente.',
    required: false,
  })
  @IsOptional()
  @IsString()
  cancelMultiTemplate?: string;

  @ApiProperty({
    example: '- 15/02/2026 alle 10:30',
    description: 'Riga di questa disdetta nell\'elenco multiplo (già formattata dalla main-app).',
    required: false,
  })
  @IsOptional()
  @IsString()
  cancelLine?: string;

  @ApiProperty({
    example: 60,
    description:
      'Finestra di raggruppamento delle disdette in secondi (30-600, default 60). Stessa impostazione del ' +
      'recap delle prenotazioni: chi disdice tre sedute in una telefonata riceve un elenco, non tre messaggi.',
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
    description: 'ID univoco per tracciabilità (generato dalla Main App)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  correlationId?: string;
}
