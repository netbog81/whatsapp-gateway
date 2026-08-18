import { IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class ChatReadStateItemDto {
  @ApiProperty({
    example: '393471234567',
    description: 'Numero della conversazione, sole cifre con prefisso internazionale.',
  })
  @IsString()
  @MaxLength(20)
  phone: string;

  @ApiProperty({
    example: '3AF5C4AA5DBD4A4B790A',
    description:
      "Id WhatsApp dell'ultimo messaggio IN ARRIVO non ancora letto secondo la main-app. Serve a " +
      'riconoscerlo nello storico di stato di Evolution: se risulta letto, tutta la conversazione lo è. ' +
      'Senza questo id si può solo guardare il contatore della chat, che spesso è nullo.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  messageId?: string;
}

export class ChatReadStateDto {
  @ApiProperty({
    type: [ChatReadStateItemDto],
    description:
      'Conversazioni da controllare. Conviene passare solo quelle che la main-app considera non lette: ' +
      'lo stato si interroga una chat per volta e oltre 60 per richiesta le eccedenti vengono rimandate.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatReadStateItemDto)
  items: ChatReadStateItemDto[];
}
