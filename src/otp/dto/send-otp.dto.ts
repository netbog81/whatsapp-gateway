import {
  IsArray, IsEmail, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export type OtpChannel = 'sms' | 'whatsapp' | 'email';

export class SendOtpDto {
  @ApiProperty({
    required: false,
    example: '+393471234567',
    description:
      'Numero destinatario (E.164). Facoltativo se è indicata l\'email: ' +
      'i canali che richiedono il telefono vengono saltati quando manca.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+?\d{8,15}$/, { message: 'phone deve essere in formato internazionale' })
  phone?: string;

  @ApiProperty({
    required: false,
    example: 'mario.rossi@example.com',
    description: 'Email destinataria. Serve almeno uno fra phone ed email.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'email non valida' })
  @MaxLength(320)
  email?: string;

  /** Almeno un recapito: validato qui invece che nel service, così è un 400 e non un 502. */
  @ApiProperty({ required: false, readOnly: true, description: 'Vincolo: serve phone oppure email' })
  @ValidateIf((dto: SendOtpDto) => !dto.phone && !dto.email)
  @IsString({ message: 'Indicare almeno un recapito fra phone ed email' })
  private readonly _recipientRequired?: string;

  @ApiProperty({
    description: 'Testo già renderizzato dal chiamante (include il codice OTP). Il gateway non lo logga mai.',
    example: 'Curandis: il codice per firmare il documento X è 123456. Valido 5 minuti.',
  })
  @IsString()
  @MaxLength(480)
  message: string;

  @ApiProperty({
    required: false,
    description: 'Oggetto usato sul canale email (ignorato da SMS e WhatsApp).',
    example: 'Codice per firmare il consenso',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string;

  @ApiProperty({
    required: false,
    description:
      'Priorità canali richiesta dal chiamante (es. dalla config firma per-tenant del registry). ' +
      'I canali privi del recapito necessario vengono saltati. Se omessa vale la config del ' +
      'gateway (KV sms/<tenant>/otp_config) o il default whatsapp→sms.',
    example: ['whatsapp', 'sms', 'email'],
  })
  @IsOptional()
  @IsArray()
  @IsIn(['sms', 'whatsapp', 'email'], { each: true })
  channelPriority?: OtpChannel[];

  @ApiProperty({ required: false, enum: ['personal_gsm', 'skebby'], description: 'Driver SMS da usare (default dalla config per-tenant)' })
  @IsOptional()
  @IsIn(['personal_gsm', 'skebby'])
  smsDriver?: 'personal_gsm' | 'skebby';

  @ApiProperty({ required: false, description: 'Correlation id del chiamante (es. ceremonyId) per l\'audit' })
  @IsOptional()
  @IsUUID()
  correlationId?: string;
}

export interface SendOtpResult {
  channel: OtpChannel;
  driver: string;
  providerMessageId?: string;
  usedFallback: boolean;
  /**
   * Recapito effettivamente usato, già mascherato. Il chiamante lo
   * registra nelle evidence: con più canali non può più dedurlo da sé.
   */
  recipientMasked: string;
}

export class TestEmailDto {
  @ApiProperty({
    required: false,
    description: 'Se presente, invia davvero un messaggio di prova a questo indirizzo.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'to non è un indirizzo valido' })
  @MaxLength(320)
  to?: string;
}
