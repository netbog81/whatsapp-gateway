import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BaoService } from './bao.service';
import { TenantAuthGuard } from './tenant-auth.guard';

@Global() // Lo rendiamo globale così non dobbiamo importarlo ovunque
@Module({
  imports: [HttpModule],
  providers: [BaoService, TenantAuthGuard],
  exports: [BaoService, TenantAuthGuard],
})
export class AuthModule {}
