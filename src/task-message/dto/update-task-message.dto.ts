import { IsString, IsOptional, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateTaskMessageDto {
  @ApiProperty({
    description: 'Nuovo contenuto del messaggio',
    required: false,
    example: 'Contenuto aggiornato del task.',
  })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiProperty({
    description: 'Nuova data di disponibilità (ISO 8601)',
    required: false,
    example: '2026-03-28T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  availableFrom?: string;
}
