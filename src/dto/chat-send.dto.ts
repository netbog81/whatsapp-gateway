import { IsString, IsOptional, IsUUID, MaxLength, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Invio di un messaggio di testo libero verso un numero WhatsApp.
 *
 * A differenza di `/whatsapp/dispatch` qui non c'è nessuna logica di
 * appuntamento (niente recap, buffer o reminder): è la segreteria che scrive a
 * mano dentro una conversazione, quindi il messaggio parte così com'è.
 */
export class ChatSendDto {
  @ApiProperty({
    example: '393471234567',
    description: 'Numero destinatario con prefisso internazionale, solo cifre.',
  })
  @IsString()
  @Matches(/^\d{8,15}$/, {
    message: 'phone deve contenere solo cifre, prefisso internazionale incluso (8-15 cifre)',
  })
  phone: string;

  @ApiProperty({
    example: 'Buongiorno, le confermiamo lo spostamento a giovedì alle 15:00.',
    description: 'Testo del messaggio.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  text: string;

  @ApiProperty({
    description: 'ID di correlazione generato dalla Main App, per riconciliare gli stati di consegna.',
    required: false,
  })
  @IsOptional()
  @IsUUID('all')
  correlationId?: string;

  @ApiProperty({
    description:
      'ID della conversazione lato Main App. Torna nei webhook di stato così la Main App ' +
      'sa a quale chat appartiene l\'aggiornamento.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  conversationId?: string;
}
