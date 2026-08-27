import { NestFactory } from '@nestjs/core';
import { CreditEventServerModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(CreditEventServerModule);
  app.enableShutdownHooks();
  const port = Number(process.env.EVENT_SERVER_PORT ?? 3002);
  await app.listen(port);
  console.log(`Credit event server listening on http://localhost:${port}`);
}

void bootstrap();
