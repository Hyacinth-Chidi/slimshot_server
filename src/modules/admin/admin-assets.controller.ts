import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AssetService } from '../assets/asset.service';
import { ListAssetsDto } from '../assets/dto/list-assets.dto';
import { UpdateAssetDto } from '../assets/dto/update-asset.dto';
import { AccessTokenClaims } from '../auth/token.service';
import { CreateUploadTicketDto } from '../ingest/dto/create-upload-ticket.dto';
import { FinalizeUploadDto } from '../ingest/dto/finalize-upload.dto';
import { IngestService } from '../ingest/ingest.service';

@Controller('api/admin/v1/assets')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminAssetsController {
  constructor(
    private readonly assets: AssetService,
    private readonly ingest: IngestService,
  ) {}

  @Get()
  @RequirePermission('asset.read')
  async list(@Query() query: ListAssetsDto) {
    const { data, meta } = await this.assets.list(query);
    return { success: true as const, data, meta };
  }

  @Get(':id')
  @RequirePermission('asset.read')
  async get(@Param('id') id: string) {
    return { success: true as const, data: await this.assets.getById(id) };
  }

  @Post('upload-ticket')
  @RequirePermission('asset.create')
  async ticket(
    @Body() dto: CreateUploadTicketDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.ingest.createTicket(dto, user.sub),
    };
  }

  @Post('finalize')
  @RequirePermission('asset.create')
  async finalize(
    @Body() dto: FinalizeUploadDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return { success: true as const, data: await this.ingest.finalize(dto, user.sub) };
  }

  @Patch(':id')
  @RequirePermission('asset.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.assets.update(id, dto, user.sub),
    };
  }

  @Post(':id/publish')
  @RequirePermission('asset.publish')
  async publish(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.assets.publish(id, user.sub) };
  }

  @Post(':id/unpublish')
  @RequirePermission('asset.publish')
  async unpublish(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    return { success: true as const, data: await this.assets.unpublish(id, user.sub) };
  }

  @Delete(':id')
  @RequirePermission('asset.delete')
  async remove(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    await this.assets.softDelete(id, user.sub);
    return { success: true as const, data: { deleted: true } };
  }
}
