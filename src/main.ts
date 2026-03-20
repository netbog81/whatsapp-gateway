import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // 1. Validazione Globale (DTO)
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // 2. Protezione BullBoard con Basic Auth
  const bullBoardUser = process.env.BULLBOARD_USER;
  const bullBoardPassword = process.env.BULLBOARD_PASSWORD;

  if (bullBoardUser && bullBoardPassword) {
    const httpAdapter = app.getHttpAdapter();
    httpAdapter.use('/admin/queues', (req: any, res: any, next: any) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="BullBoard"');
        res.status(401).send('Autenticazione richiesta');
        return;
      }
      const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
      const [user, pass] = credentials.split(':');
      if (user === bullBoardUser && pass === bullBoardPassword) {
        next();
      } else {
        res.status(403).send('Accesso negato');
      }
    });
  }

  // 3. Configurazione Swagger (Documentazione API)
  const config = new DocumentBuilder()
    .setTitle('WhatsApp Gateway Multi-tenant')
    .setDescription(
      'Microservizio per la gestione di messaggi WhatsApp, Reminder, Task interni via Evolution API e Messaggistica/Task tra utenti.',
    )
    .setVersion('1.0')
    .addTag('WhatsApp Dispatcher')
    .addTag('Task Messages')
    .addGlobalParameters({
      in: 'header',
      required: true,
      name: 'X-Tenant-ID',
      schema: { example: 'studio-roma-01' },
    })
    .addGlobalParameters({
      in: 'header',
      required: true,
      name: 'X-Tenant-API-Key',
      schema: { example: 'chiave-segreta-tenant' },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  // 4. Avvio del Server
  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Gateway in ascolto sulla porta ${port}`);
  logger.log(`Swagger disponibile su http://localhost:${port}/docs`);
  logger.log(`BullBoard disponibile su http://localhost:${port}/admin/queues`);
}
bootstrap();
