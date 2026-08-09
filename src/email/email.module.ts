import { Module } from '@nestjs/common';
import { SmtpDriver } from './smtp.driver';

@Module({
  providers: [SmtpDriver],
  exports: [SmtpDriver],
})
export class EmailModule {}
