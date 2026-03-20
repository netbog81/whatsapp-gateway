import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TransitionTaskMessageDto {
  @ApiProperty({
    description: 'UUID dell\'utente che esegue la transizione',
    example: '550e8400-e29b-41d4-a716-446655440001',
  })
  @IsUUID('all')
  userId: string;
}
