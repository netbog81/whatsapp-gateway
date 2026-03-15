import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { BaoService } from './bao.service';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

const hashKey = (apiKey: string): string =>
  crypto.createHash('sha256').update(apiKey).digest('hex');

@Injectable()
export class TenantAuthGuard implements CanActivate {
  constructor(
    private readonly baoService: BaoService,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const tenantId = request.headers['x-tenant-id'];
    const apiKey = request.headers['x-tenant-api-key'];

    if (!tenantId || !apiKey) {
      throw new UnauthorizedException('Credenziali Tenant mancanti');
    }

    const apiKeyHash = hashKey(apiKey);

    // Cache Redis: salviamo l'hash (non il valore raw)
    const cachedHash = await this.redis.get(`auth:${tenantId}`);

    if (cachedHash) {
      if (cachedHash === apiKeyHash) {
        return true;
      } else {
        throw new ForbiddenException('API Key non valida (Cache)');
      }
    }

    // Verifica su OpenBao (source of truth)
    try {
      const secret = await this.baoService.getSecret(`whatsapp/${tenantId}/gateway_access`);

      if (!secret || secret.api_key !== apiKey) {
        throw new ForbiddenException('API Key non valida o Tenant inesistente');
      }

      // Salviamo l'hash in cache (non la chiave raw)
      await this.redis.set(`auth:${tenantId}`, apiKeyHash, 'EX', 600);

      return true;
    } catch (error: any) {
      if (error instanceof ForbiddenException) throw error;
      throw new ForbiddenException('Accesso Negato');
    }
  }
}
