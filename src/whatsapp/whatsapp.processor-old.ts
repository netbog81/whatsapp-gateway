import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Processor('whatsapp-queue', { 
  concurrency: 1, // Esegue UNO alla volta per tenant (Anti-Ban rigoroso)
  limiter: {
    max: 1,
    duration: 10000 // Max 1 messaggio ogni 10 secondi
  }
})
export class WhatsappProcessor extends WorkerHost {
  constructor(
    private readonly httpService: HttpService,
    @InjectRedis() private readonly redis: Redis,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    // Jitter casuale (1-3 secondi) per sembrare umano
    const jitter = Math.floor(Math.random() * 2000) + 1000;
    await new Promise(resolve => setTimeout(resolve, jitter));

    switch (job.name) {
      case 'process-recap':
        return this.sendRecap(job.data);
      case 'send-reminder':
        return this.sendToEvolution(job.data);
    }
  }

  private async sendRecap(data: any) {
    const { tenantId, pazienteId, phone } = data;
    const key = `pending:${tenantId}:${pazienteId}`;
    
    // Transazione atomica: Leggi e Cancella
    const items = await this.redis.multi().lrange(key, 0, -1).del(key).exec();
    const appointments = items[0][1] as string[]; // Risultato lrange

    if (!appointments || appointments.length === 0) return;

    const parsedApps = appointments.map(a => JSON.parse(a));
    
    // Logica messaggio unico vs multiplo
    let message = '';
    if (parsedApps.length === 1) {
      message = `Conferma appuntamento: ${parsedApps[0].date}`;
    } else {
      message = `Riepilogo appuntamenti:\n` + parsedApps.map(a => `- ${a.date}`).join('\n');
    }

    return this.sendToEvolution({ tenantId, phone, content: message });
  }

  private async sendToEvolution(data: any) {
    // Recupera API Key specifica del tenant (logica semplificata)
    // In produzione: usa OpenBaoService qui
    const instanceName = data.tenantId; 
    
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${process.env.EVOLUTION_API_URL}/message/sendText/${instanceName}`, {
          number: data.phone,
          text: data.content
        }, {
          headers: { apikey: process.env.EVOLUTION_GLOBAL_KEY } // O chiave specifica tenant
        })
      );
      return response.data;
    } catch (error) {
      // BullMQ gestirà il retry automatico
      throw error;
    }
  }
}
