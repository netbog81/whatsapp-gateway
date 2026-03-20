import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { TaskMessageController } from './task-message.controller';
import { TaskMessageTestController } from './task-message-test.controller';
import { TaskMessageService } from './task-message.service';
import { TaskMessageProcessor } from './task-message.processor';

@Module({
  imports: [
    // Registrazione della coda BullMQ per i messaggi schedulati
    BullModule.registerQueue({
      name: 'task-message-queue',
    }),

    // Usa la coda callback-webhook esistente per inviare webhook
    BullModule.registerQueue({
      name: 'callback-webhook',
    }),

    // Dashboard BullBoard per la coda task-message
    BullBoardModule.forFeature({
      name: 'task-message-queue',
      adapter: BullMQAdapter as any,
    }),
  ],
  controllers: [TaskMessageController, TaskMessageTestController],
  providers: [TaskMessageService, TaskMessageProcessor],
  exports: [TaskMessageService],
})
export class TaskMessageModule {}
