import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { NotifyController } from './notify.controller';

/**
 * Notifiche generiche verso i destinatari, oggi solo email.
 *
 * Separato da OtpModule perché è un uso diverso dello stesso canale: l'OTP ha
 * una sua logica di priorità e fallback fra canali, qui serve solo consegnare
 * un messaggio a un indirizzo. Primo consumatore: il link di sottoscrizione
 * dell'agenda per gli operatori senza numero di telefono.
 */
@Module({
  imports: [EmailModule],
  controllers: [NotifyController],
})
export class NotifyModule {}
