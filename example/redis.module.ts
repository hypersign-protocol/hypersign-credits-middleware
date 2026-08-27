import {
  Global,
  Module,
} from '@nestjs/common';

export const REDIS_URL = 'REDIS_URL';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_URL,
      useValue: process.env.REDIS_URL ?? 'redis://localhost:6379',
    },
  ],
  exports: [REDIS_URL],
})
export class RedisModule {}
