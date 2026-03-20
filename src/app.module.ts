import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { RedisModule } from '@nestjs-modules/ioredis';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
import { WebhookModule } from './webhook/webhook.module';
import { TaskMessageModule } from './task-message/task-message.module';

@Module({
  imports: [
    // 1. Gestione Variabili d'Ambiente (.env)
    ConfigModule.forRoot({
      isGlobal: true, // Disponibile ovunque senza importarlo
    }),

    // 2. Connessione Redis Globale (per cache e servizi vari)
    RedisModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'single',
        url: config.get<string>('REDIS_URL'), // es: redis://evolution_redis:6379
      }),
    }),

    // 3. Configurazione Base BullMQ (Code)
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>('REDIS_URL'),
        },
        defaultJobOptions: {
          removeOnComplete: true, // Pulisce i job completati per risparmiare RAM
          removeOnFail: false,    // Mantiene i falliti per debug
          attempts: 3,            // Riprova 3 volte in caso di errore
          backoff: {
            type: 'exponential',
            delay: 1000,          // Attesa crescente: 1s, 2s, 4s...
          },
        },
      }),
    }),

    // 4. BullBoard (Dashboard Code)
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
      // TODO: Aggiungere middleware di protezione (Basic Auth) per produzione
    }),

    // 5. Moduli Applicativi
    CommonModule,
    AuthModule,
    WhatsappModule,
    AuditModule,
    WebhookModule,
    TaskMessageModule,
  ],
})
export class AppModule {}
