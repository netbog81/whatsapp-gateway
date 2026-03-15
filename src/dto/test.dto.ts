import { IsString, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TestMessageDto {
  @ApiProperty({ example: '393471234567', description: 'Numero di telefono destinatario (senza +)' })
  @IsString()
  phone: string;

  @ApiProperty({ example: 'Mario Rossi', description: 'Nome del paziente di test', required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ example: 'Messaggio di test dal gateway.', description: 'Testo del messaggio (solo per /test/direct)', required: false })
  @IsOptional()
  @IsString()
  message?: string;
}
