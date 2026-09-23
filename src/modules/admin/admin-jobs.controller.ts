import { Controller, Get, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { QueueService } from '../../core/queue/queue.service';

@Controller('api/admin/v1/jobs')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminJobsController {
  constructor(private readonly queue: QueueService) {}

  @Get('health')
  @RequirePermission('jobs.read')
  async health() {
    return { success: true as const, data: await this.queue.getQueueHealth() };
  }
}
