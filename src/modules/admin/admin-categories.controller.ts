import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';

import { AssetKind } from '../../generated/prisma/enums';
import { CurrentUser } from '../../core/auth/current-user.decorator';
import { JwtAuthGuard } from '../../core/auth/jwt-auth.guard';
import { PermissionsGuard } from '../../core/auth/permissions.guard';
import { RequirePermission } from '../../core/auth/permissions';
import { AccessTokenClaims } from '../auth/token.service';
import { CategoryService } from '../taxonomy/category.service';
import { CreateCategoryDto } from '../taxonomy/dto/create-category.dto';
import { ReorderCategoriesDto } from '../taxonomy/dto/reorder-categories.dto';
import { UpdateCategoryDto } from '../taxonomy/dto/update-category.dto';

@Controller('api/admin/v1/categories')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class AdminCategoriesController {
  constructor(private readonly categories: CategoryService) {}

  @Get()
  @RequirePermission('taxonomy.read')
  async tree(@Query('kind') kind: AssetKind) {
    return {
      success: true as const,
      data: await this.categories.tree(assertKind(kind)),
    };
  }

  @Post()
  @RequirePermission('taxonomy.write')
  async create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.categories.create(dto, user.sub),
    };
  }

  @Patch(':id')
  @RequirePermission('taxonomy.write')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    return {
      success: true as const,
      data: await this.categories.update(id, dto, user.sub),
    };
  }

  @Delete(':id')
  @RequirePermission('taxonomy.write')
  async remove(@Param('id') id: string, @CurrentUser() user: AccessTokenClaims) {
    await this.categories.remove(id, user.sub);
    return { success: true as const, data: { deleted: true } };
  }

  @Post('reorder')
  @RequirePermission('taxonomy.write')
  async reorder(
    @Body() dto: ReorderCategoriesDto,
    @CurrentUser() user: AccessTokenClaims,
  ) {
    await this.categories.reorder(dto.items, user.sub);
    return { success: true as const, data: { reordered: dto.items.length } };
  }
}

/**
 * The `@Query('kind') kind: AssetKind` annotation erases at runtime, and
 * AssetKind is a const object rather than a TS enum, so it validated nothing.
 * An empty `kind` - an ordinary dashboard first paint - reached Prisma and
 * surfaced as a 500 with a stack trace. The sibling write handlers take `kind`
 * in a body DTO where `@IsEnum(AssetKind)` already covers it; this is the only
 * handler that reads it straight off the query string.
 */
function assertKind(kind: unknown): AssetKind {
  const known = Object.values(AssetKind);
  if (typeof kind === 'string' && (known as string[]).includes(kind)) {
    return kind as AssetKind;
  }

  throw new UnprocessableEntityException(
    `kind must be one of: ${known.join(', ')}.`,
  );
}
