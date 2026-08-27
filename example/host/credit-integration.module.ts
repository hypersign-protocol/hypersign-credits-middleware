import { Global, Module, UnauthorizedException } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import {
  CreditAppType,
  CreditEnvironment,
  CreditModule,
  CreditType,
} from '../../src';
import { CreditInfrastructureModule } from './credit-infrastructure.module';
import { CreditRecoveryScheduler } from './credit-recovery.scheduler';

interface TrustedServiceRequest {
  service?: {
    appId?: string;
    subdomain?: string;
    env?: string;
  };
  requestId?: string;
}

@Global()
@Module({
  imports: [
    ScheduleModule.forRoot(),
    CreditInfrastructureModule,
    CreditModule.forRootAsync({
      imports: [CreditInfrastructureModule],
      useFactory: () => ({
        requestContextResolver: (unknownRequest: unknown) => {
          const request = unknownRequest as TrustedServiceRequest;
          const appId = request.service?.appId?.trim();
          const environment = request.service?.env?.trim();
          if (!appId) {
            throw new UnauthorizedException(
              'Trusted service appId is required',
            );
          }
          if (
            environment !== CreditEnvironment.PROD &&
            environment !== CreditEnvironment.DEV
          ) {
            throw new UnauthorizedException(
              'Trusted service environment must be prod or dev',
            );
          }

          return {
            subject: {
              tenantId: request.service?.subdomain?.trim() || undefined,
              appId,
              appType: CreditAppType.CAVACH_API,
              creditType: CreditType.API_CREDIT,
            },
            requestId: request.requestId,
            environment,
          };
        },
      }),
    }),
  ],
  providers: [CreditRecoveryScheduler],
  exports: [CreditModule],
})
export class CreditIntegrationModule {}
