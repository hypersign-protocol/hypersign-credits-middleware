import { Module } from '@nestjs/common';
import { ExampleBullMqModule } from '../bullmq.module';
import { RedisModule } from '../redis.module';
import { CreditEventsController } from './credit-events.controller';
import { CreditEventStore } from './event-store.service';
import { CreditLifecycleConsumer } from './lifecycle-consumer.service';

@Module({
  imports: [RedisModule, ExampleBullMqModule],
  controllers: [CreditEventsController],
  providers: [CreditEventStore, CreditLifecycleConsumer],
})
export class CreditEventServerModule {}
