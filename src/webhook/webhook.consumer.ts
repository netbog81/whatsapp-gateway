import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import * as amqp from 'amqplib';
import { v4 as uuidv4 } from 'uuid';
import { OTP_STATUS_PREFIX, OTP_TRACK_PREFIX, OTP_TRACK_TTL_S } from '../otp/otp-delivery.service';

const EVOLUTION_EXCHANGE = 'evolution_events';
const QUEUE_NAME = 'whatsapp-gateway.evolution-events';
const ROUTING_KEY = '#'; // tutti gli eventi Evolution

const RECONNECT_DELAYS = [5000, 10000, 15000, 30000, 30000]; // backoff: 5s, 10s, 15s, 30s, 30s...

@Injectable()
export class WebhookConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookConsumer.name);
  private connection: any;
  private channel: any;
  private isDestroyed = false;
  private reconnectAttempt = 0;

  constructor(
    private readonly configService: ConfigService,
    @InjectQueue('callback-webhook') private readonly callbackQueue: Queue,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    this.isDestroyed = true;
    await this.disconnect();
  }

  private async connect() {
    if (this.isDestroyed) return;

    const url = this.configService.get<string>('RABBITMQ_URL');

    try {
      this.connection = await amqp.connect(url);
      this.channel = await this.connection.createChannel();

      // Listener per riconnessione automatica
      this.connection.on('error', (err: Error) => {
        this.logger.warn(`RabbitMQ connection error: ${err.message}`);
      });

      this.connection.on('close', () => {
        if (!this.isDestroyed) {
          this.logger.warn('RabbitMQ connection closed. Riconnessione in corso...');
          this.scheduleReconnect();
        }
      });

      this.channel.on('error', (err: Error) => {
        this.logger.warn(`RabbitMQ channel error: ${err.message}`);
      });

      // Topic exchange per ricevere tutti gli eventi Evolution
      await this.channel.assertExchange(EVOLUTION_EXCHANGE, 'topic', { durable: true });

      const { queue } = await this.channel.assertQueue(QUEUE_NAME, {
        durable: true,
        arguments: { 'x-message-ttl': 86400000 }, // 24h TTL sui messaggi
      });

      await this.channel.bindQueue(queue, EVOLUTION_EXCHANGE, ROUTING_KEY);
      await this.channel.prefetch(1);

      this.channel.consume(queue, (msg: any) => this.handleMessage(msg), { noAck: false });

      this.reconnectAttempt = 0; // reset contatore dopo successo
      this.logger.log(`Consumer RabbitMQ connesso a exchange "${EVOLUTION_EXCHANGE}"`);
    } catch (error: any) {
      this.logger.error(`Errore connessione RabbitMQ (attempt ${this.reconnectAttempt + 1}): ${error.message}`);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.isDestroyed) return;

    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt++;

    this.logger.log(`Prossimo tentativo di riconnessione RabbitMQ in ${delay / 1000}s (attempt ${this.reconnectAttempt})`);

    setTimeout(() => this.connect(), delay);
  }

  private async disconnect() {
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      // ignora errori alla chiusura
    }
  }

  private async handleMessage(msg: any) {
    if (!msg) return;

    try {
      const event = JSON.parse(msg.content.toString());
      const rawStatus = event.data?.update?.status ?? event.data?.status ?? null;
      // Normalizza status numerici (protobuf enum WhatsApp: 2=SERVER_ACK, 3=DELIVERY_ACK, 4=READ, 5=PLAYED)
      const numStatusMap: Record<number, string> = {0:'ERROR',1:'PENDING',2:'SERVER_ACK',3:'DELIVERY_ACK',4:'READ',5:'PLAYED'};
      const updateStatus = typeof rawStatus === 'number' ? (numStatusMap[rawStatus] ?? String(rawStatus)) : rawStatus;
      this.logger.log(
        `[RABBITMQ] evento=${event.event || 'sconosciuto'} instance=${event.instance || '?'}` +
        (updateStatus ? ` status=${updateStatus}` : ''),
      );

      // Debug temporaneo per verificare struttura payload messages.update
      if (event.event === 'messages.update') {
        this.logger.log(`[RABBITMQ DEBUG] messages.update raw: ${JSON.stringify({
          'data.key': event.data?.key,
          'data.keyId': event.data?.keyId,
          'data.update': event.data?.update,
          'data.status': event.data?.status,
          rawStatus,
        })}`);
      }

      // Recupera i metadati dal gateway (salvati in Redis al momento dell'invio)
      // Disponibile solo per messaggi inviati dal gateway stesso (recap, reminder, cancel_notification)
      const tenantId = event.instance || event.tenantId;
      // Il message ID è in posizioni diverse a seconda dell'evento Evolution:
      // - send.message / messages.upsert: event.data.key.id
      // - messages.update: event.data.keyId
      const evolutionMsgId = event.data?.key?.id || event.data?.keyId;
      if (!evolutionMsgId) {
        this.logger.debug(`[RABBITMQ] no msgId: event=${event.event} data_keys=${Object.keys(event.data || {}).join(',')}`);
      }
      // Esito di consegna degli OTP: registrato solo per i messaggi che
      // l'OtpDeliveryService ha marcato, così non si tocca il resto del
      // traffico. Serve a distinguere "non arrivato" da "arrivato e non
      // digitato", che allo sportello sono due situazioni diverse.
      if (tenantId && evolutionMsgId && ['DELIVERY_ACK', 'READ', 'PLAYED'].includes(String(updateStatus))) {
        const tracked = await this.redis.get(`${OTP_TRACK_PREFIX}${tenantId}:${evolutionMsgId}`);
        if (tracked) {
          await this.redis.set(
            `${OTP_STATUS_PREFIX}${tenantId}:${evolutionMsgId}`,
            JSON.stringify({
              status: updateStatus === 'DELIVERY_ACK' ? 'delivered' : 'read',
              at: new Date().toISOString(),
            }),
            'EX',
            OTP_TRACK_TTL_S,
          );
          this.logger.log(`[OTP] consegna confermata per ${evolutionMsgId} (${updateStatus})`);
        }
      }

      let msgMetadata: any = null;
      if (tenantId && evolutionMsgId) {
        const metaJson = await this.redis.get(`msg_meta:${tenantId}:${evolutionMsgId}`);
        if (metaJson) {
          try {
            msgMetadata = JSON.parse(metaJson);
          } catch {
            this.logger.warn(`Impossibile parsare msg_meta per ${evolutionMsgId}`);
          }
        } else {
          // Fallback legacy (chiavi msg_type: scadono dopo 48h dal deploy)
          const legacyType = await this.redis.get(`msg_type:${tenantId}:${evolutionMsgId}`);
          if (legacyType) {
            msgMetadata = { message_type: legacyType };
          }
        }
      }

      await this.callbackQueue.add(
        'send-callback',
        {
          correlationId: msgMetadata?.correlation_id || event.correlationId || uuidv4(),
          tenantId,
          event,
          msg_metadata: msgMetadata,
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );

      this.channel.ack(msg);
    } catch (error: any) {
      this.logger.error(`Errore processamento messaggio RabbitMQ: ${error.message}`);
      // nack senza requeue: il messaggio era malformato
      this.channel?.nack(msg, false, false);
    }
  }
}
