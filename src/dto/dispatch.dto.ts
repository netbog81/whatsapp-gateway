import { IsString, IsEnum, IsObject, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export enum DispatchType {
  APPOINTMENT_BOOKING = 'APPOINTMENT_BOOKING',
  INTERNAL_TASK = 'INTERNAL_TASK',
}

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

  @ApiProperty({ example: '2026-02-15T10:30:00Z', description: 'Data e ora appuntamento (ISO 8601)' })
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
