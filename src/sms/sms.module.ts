import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PersonalGsmDriver } from './personal-gsm.driver';
import { SkebbyDriver } from './skebby.driver';

@Module({
  imports: [HttpModule],
  providers: [PersonalGsmDriver, SkebbyDriver],
  exports: [PersonalGsmDriver, SkebbyDriver],
})
export class SmsModule {}
