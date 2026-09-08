import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Email generica: testo già renderizzato da chi chiama. */
export class SendEmailDto {
  @ApiProperty({ description: 'Indirizzo del destinatario' })
  @IsEmail({}, { message: 'Indirizzo email non valido' })
  email: string;

  @ApiPropertyOptional({ description: "Oggetto; se assente il driver ne usa uno neutro" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  subject?: string;

  @ApiProperty({ description: 'Corpo testuale. Non viene mai loggato.' })
  @IsString()
  @IsNotEmpty({ message: 'Il corpo del messaggio è obbligatorio' })
  message: string;
}
