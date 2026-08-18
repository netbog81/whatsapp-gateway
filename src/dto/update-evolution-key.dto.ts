import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateEvolutionKeyDto {
  @ApiProperty({
    description:
      'Nuova API key dell\'istanza Evolution del tenant. Viene scritta in OpenBao ' +
      '(kv/whatsapp/{tenantId}/evolution_apikey, campo api_key) e la cache Redis ' +
      'viene invalidata immediatamente.',
    example: '79D4XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  })
  @IsString()
  @MinLength(16, {
    message: 'API key Evolution troppo corta (min 16 caratteri): probabile valore incompleto o autofill',
  })
  apiKey: string;
}
