import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AssetKind } from '../../generated/prisma/enums';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../core/audit/audit.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

export interface ReorderItem {
  id: string;
  sortOrder: number;
}

export interface CategoryRow {
  id: string;
  kind: AssetKind;
  parentId: string | null;
  slug: string;
  name: string;
  sortOrder: number;
}

export interface CategoryNode extends CategoryRow {
  children: CategoryNode[];
}

@Injectable()
export class CategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async tree(kind: AssetKind): Promise<CategoryNode[]> {
    const rows = (await this.prisma.category.findMany({
      where: { kind },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })) as unknown as CategoryRow[];

    const byId = new Map<string, CategoryNode>();
    for (const r of rows) byId.set(r.id, { ...r, children: [] });

    const roots: CategoryNode[] = [];
    for (const node of byId.values()) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  async create(dto: CreateCategoryDto, actorId: string): Promise<CategoryRow> {
    if (dto.parentId) await this.assertParentMatchesKind(dto.parentId, dto.kind);

    const created = (await this.prisma.category.create({
      data: {
        kind: dto.kind,
        name: dto.name,
        slug: slugify(dto.name),
        description: dto.description ?? null,
        parentId: dto.parentId ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    })) as unknown as CategoryRow;

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.create',
      entityType: 'Category',
      entityId: created.id,
      after: { kind: dto.kind, name: dto.name },
    });

    return created;
  }

  async update(
    id: string,
    dto: UpdateCategoryDto,
    actorId: string,
  ): Promise<CategoryRow> {
    const before = await this.load(id);

    const updated = (await this.prisma.category.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name, slug: slugify(dto.name) } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    })) as unknown as CategoryRow;

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.update',
      entityType: 'Category',
      entityId: id,
      before: { name: before.name },
      after: dto,
    });

    return updated;
  }

  async remove(id: string, actorId: string): Promise<void> {
    await this.load(id);

    // Children first: deleting a parent would orphan a subtree whose rows still
    // carry its id.
    const candidates = (await this.prisma.category.findMany({
      where: { parentId: id },
    })) as unknown as CategoryRow[];
    const children = candidates.filter((c) => c.parentId === id);
    if (children.length > 0) {
      throw new ConflictException(
        `This category has ${children.length} child categor${children.length === 1 ? 'y' : 'ies'}. Move or delete them first.`,
      );
    }

    // Assets second: cascading would silently uncategorise them, and nulling is
    // a data change nobody asked for. Make the admin choose.
    const assetCount = await this.prisma.asset.count({ where: { categoryId: id } });
    if (assetCount > 0) {
      throw new ConflictException(
        `${assetCount} asset${assetCount === 1 ? '' : 's'} use this category. Reassign them first.`,
      );
    }

    await this.prisma.category.delete({ where: { id } });

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.delete',
      entityType: 'Category',
      entityId: id,
    });
  }

  async reorder(items: ReorderItem[], actorId: string): Promise<void> {
    await this.prisma.$transaction(
      items.map((i) =>
        this.prisma.category.update({
          where: { id: i.id },
          data: { sortOrder: i.sortOrder },
        }),
      ),
    );

    await this.audit.record({
      actorId,
      actorType: 'admin',
      action: 'category.reorder',
      entityType: 'Category',
      after: { count: items.length },
    });
  }

  private async load(id: string): Promise<CategoryRow> {
    const row = (await this.prisma.category.findUnique({
      where: { id },
    })) as unknown as CategoryRow | null;
    if (!row) throw new NotFoundException(`Category not found: ${id}`);
    return row;
  }

  private async assertParentMatchesKind(
    parentId: string,
    kind: AssetKind,
  ): Promise<void> {
    const parent = await this.load(parentId);
    // The tree is kind-scoped: nothing in the column types stops an audio
    // category parenting a font one, so it is enforced here.
    if (parent.kind !== kind) {
      throw new BadRequestException(
        `Parent category is for ${parent.kind}, not ${kind}.`,
      );
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
