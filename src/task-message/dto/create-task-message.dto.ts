import { IsString, IsUUID, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateTaskMessageDto {
  @ApiProperty({
    description: 'UUID dell\'utente destinatario',
    example: '550e8400-e29b-41d4-a716-446655440001',
  })
  @IsUUID('all')
  recipientUserId: string;

  @ApiProperty({
    description: 'UUID dell\'utente mittente',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID('all')
  senderUserId: string;

  @ApiProperty({
    description: 'Contenuto del messaggio/task',
    example: 'Ricordati di inviare il report mensile entro fine mese.',
  })
  @IsString()
  content: string;

  @ApiProperty({
    description: 'Data da cui il messaggio sarà visibile al destinatario (ISO 8601). Se omesso, disponibile subito.',
    required: false,
    example: '2026-03-25T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  availableFrom?: string;

  @ApiProperty({
    description: 'ID di correlazione per tracciabilità (generato dalla Main App)',
    required: false,
    example: '550e8400-e29b-41d4-a716-446655440099',
  })
  @IsOptional()
  @IsUUID('all')
  correlationId?: string;
}
