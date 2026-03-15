import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BullBoardModule } from '@bull-board/nestjs';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { HttpModule } from '@nestjs/axios';
import { WhatsappController } from '../controllers/whatsapp.controller';
import { WhatsappTestController } from '../controllers/whatsapp-test.controller';
import { WhatsappService } from './whatsapp.service';
import { WhatsappProcessor } from './whatsapp.processor';
import { WhatsappTestService } from './whatsapp-test.service';
import { AuthModule } from '../auth/auth.module'; // Per il Guard
import { AuditModule } from '../audit/audit.module'; // Per l'Audit

@Module({
  imports: [
    HttpModule, // Per chiamare Evolution API
    AuthModule,
    AuditModule,
    
    // Registrazione delle Code
    BullModule.registerQueue({
      name: 'whatsapp-queue',
    }),
    BullModule.registerQueue({
      name: 'callback-webhook',
    }),

    // Aggiunta della Coda alla Dashboard BullBoard
    BullBoardModule.forFeature({
      name: 'whatsapp-queue',
      adapter: BullMQAdapter as any,
    }),
  ],
  controllers: [WhatsappController, WhatsappTestController],
  providers: [WhatsappService, WhatsappProcessor, WhatsappTestService],
  exports: [WhatsappService],
})
export class WhatsappModule {}
