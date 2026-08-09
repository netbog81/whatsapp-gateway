import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../sms/sms.module';
import { EmailModule } from '../email/email.module';
import { OtpDeliveryService } from './otp-delivery.service';
import { OtpController } from './otp.controller';

@Module({
  imports: [HttpModule, AuditModule, SmsModule, EmailModule],
  controllers: [OtpController],
  providers: [OtpDeliveryService],
})
export class OtpModule {}
