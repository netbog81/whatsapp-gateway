import { IsString, IsOptional, IsBoolean, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CancelDto {
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
    description: 'ID univoco per tracciabilità (generato dalla Main App)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsOptional()
  @IsUUID()
  correlationId?: string;
}
