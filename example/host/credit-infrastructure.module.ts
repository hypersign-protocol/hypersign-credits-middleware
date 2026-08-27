import {
  Global,
  Inject,
  Injectable,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CREDIT_REDIS_CLIENT } from '../../src';

@Injectable()
class CreditRedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(CREDIT_REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: CREDIT_REDIS_CLIENT,
      useFactory: async (): Promise<Redis> => {
        if (!process.env.REDIS_URL) throw new Error('REDIS_URL is required');
        const redis = new Redis(process.env.REDIS_URL, {
          enableReadyCheck: true,
          maxRetriesPerRequest: 2,
        });
        await redis.ping();
        return redis;
      },
    },
    CreditRedisShutdown,
  ],
  exports: [CREDIT_REDIS_CLIENT],
})
export class CreditInfrastructureModule {}
