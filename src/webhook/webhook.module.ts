import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HttpModule } from '@nestjs/axios';
import { WebhookConsumer } from './webhook.consumer';
import { WebhookProcessor } from './webhook.processor';
import { WebhookFailedListener } from './webhook.failed-listener';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [
    HttpModule,
    AuditModule,

    BullModule.registerQueue({
      name: 'callback-webhook',
      defaultJobOptions: {
        attempts: 15,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),

    BullBoardModule.forFeature({
      name: 'callback-webhook',
      adapter: BullMQAdapter as any,
    }),
  ],
  providers: [WebhookConsumer, WebhookProcessor, WebhookFailedListener],
})
export class WebhookModule {}
