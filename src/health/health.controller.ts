import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';

const VAULT_HEALTH_TIMEOUT_MS = 3000;

interface VaultHealthStatus {
  reachable: boolean;
  httpStatus?: number;
  sealed?: boolean;
  standby?: boolean;
  error?: string;
}

async function probeVaultEndpoint(endpoint: string): Promise<VaultHealthStatus> {
  const url = `${endpoint.replace(/\/$/, '')}/v1/sys/health`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VAULT_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal });
    let body: { sealed?: boolean; standby?: boolean } = {};
    try {
      body = (await res.json()) as { sealed?: boolean; standby?: boolean };
    } catch {
      // /v1/sys/health può rispondere senza body in alcuni casi
    }
    return {
      reachable: true,
      httpStatus: res.status,
      sealed: body.sealed,
      standby: body.standby,
    };
  } catch (err) {
    return { reachable: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Endpoint di health per whatsapp-gateway.
 *
 * Nessuna autenticazione: il gateway non ha tenant context e gli endpoint
 * sono destinati a monitoring esterno (Uptime Kuma, Docker HEALTHCHECK).
 * Dietro il proxy/firewall del nodo, non ci sono dettagli sensibili
 * esposti dal payload pubblico.
 */
@Controller('health')
export class HealthController {
  /**
   * GET /health/status
   * Risponde 200 OK se il vault risponde unsealed, 503 altrimenti.
   */
  @Get('status')
  async getStatus(@Res({ passthrough: true }) res: Response) {
    const endpoint = process.env.OPENBAO_ADDR || 'http://host-gateway:8200';
    const vault = await probeVaultEndpoint(endpoint);

    const vaultOk = vault.reachable && vault.sealed === false;

    if (!vaultOk) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return {
      status: vaultOk ? 'ok' : 'degraded',
      service: 'whatsapp-gateway',
      checks: {
        vault: vaultOk ? 'ok' : 'error',
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /health/live
   * Liveness probe: ritorna sempre 200 finché il processo è in vita.
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return {
      status: 'alive',
      service: 'whatsapp-gateway',
      timestamp: new Date().toISOString(),
    };
  }
}
