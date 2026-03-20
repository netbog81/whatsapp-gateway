import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { TaskMessageService } from './task-message.service';

@Processor('task-message-queue')
export class TaskMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(TaskMessageProcessor.name);

  constructor(private readonly taskMessageService: TaskMessageService) {
    super();
  }

  async process(job: Job<{ messageId: string; tenantId: string }>): Promise<any> {
    const { messageId, tenantId } = job.data;

    this.logger.log(
      `Attivazione messaggio schedulato ${messageId} per tenant ${tenantId}`,
    );

    await this.taskMessageService.activateScheduledMessage(messageId, tenantId);

    return { status: 'activated', messageId };
  }
}
