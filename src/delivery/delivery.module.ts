import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { SmsModule } from '../sms/sms.module';
import { EmailModule } from '../email/email.module';
import { ChannelDeliveryService } from './channel-delivery.service';

/**
 * Il motore di consegna multicanale, condiviso fra gli OTP delle firme e i
 * promemoria degli appuntamenti. Non ha stato proprio: tutto ciò che serve
 * arriva nella singola richiesta.
 */
@Module({
  imports: [HttpModule, SmsModule, EmailModule],
  providers: [ChannelDeliveryService],
  exports: [ChannelDeliveryService],
})
export class DeliveryModule {}
