import {
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AudioAsset, Prisma } from '../../generated/prisma/client';

import {
  AudioCategory,
  AudioSearchMeta,
  AudioTrack,
} from '../../common/interfaces/audio-track.interface';
import { CreateAudioUploadSignatureDto } from './dto/create-audio-upload-signature.dto';
import { FinalizeAudioUploadDto } from './dto/finalize-audio-upload.dto';
import { SearchAudioDto } from './dto/search-audio.dto';
import { CloudinaryAudioService } from './providers/cloudinary-audio.service';
import { PrismaService } from '../../prisma/prisma.service';

export interface SearchResponse {
  success: true;
  data: AudioTrack[];
  meta: AudioSearchMeta;
}

export interface CategoriesResponse {
  success: true;
  data: AudioCategory[];
}

export interface UploadResponse {
  success: true;
  data: AudioTrack;
}

export interface UploadSignatureResponse {
  success: true;
  data: ReturnType<CloudinaryAudioService['createDirectUploadSignature']>;
}

@Injectable()
export class AudioService {
  private readonly categories: AudioCategory[] = [
    { id: 'cinematic', name: 'Cinematic', type: 'music' },
    { id: 'ambient', name: 'Ambient', type: 'music' },
    { id: 'corporate', name: 'Corporate', type: 'music' },
    { id: 'lofi', name: 'Lofi', type: 'music' },
    { id: 'transitions', name: 'Transitions', type: 'sfx' },
    { id: 'whoosh', name: 'Whoosh', type: 'sfx' },
    { id: 'impacts', name: 'Impacts', type: 'sfx' },
    { id: 'ui', name: 'UI', type: 'sfx' },
  ];

  constructor(
    private readonly prismaService: PrismaService,
    private readonly cloudinaryAudioService: CloudinaryAudioService,
  ) {}

  async search(query: SearchAudioDto): Promise<SearchResponse> {
    const where = this.buildSearchWhere(query);
    const skip = (query.page - 1) * query.limit;

    try {
      const [records, total] = await this.prismaService.$transaction([
        this.prismaService.audioAsset.findMany({
          where,
          skip,
          take: query.limit,
          orderBy: {
            uploadedAt: 'desc',
          },
        }),
        this.prismaService.audioAsset.count({ where }),
      ]);

      return {
        success: true,
        data: records.map((record) => this.toAudioTrack(record)),
        meta: {
          total_results: total,
          page: query.page,
          has_more: total > query.page * query.limit,
        },
      };
    } catch {
      throw new ServiceUnavailableException(
        'Database is unavailable. Check DATABASE_URL and Prisma setup.',
      );
    }
  }

  createUploadSignature(
    payload: CreateAudioUploadSignatureDto,
  ): UploadSignatureResponse {
    try {
      return {
        success: true,
        data: this.cloudinaryAudioService.createDirectUploadSignature(payload),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not prepare upload.';

      if (message === 'Cloudinary is not configured.') {
        throw new ServiceUnavailableException(
          'Cloudinary is not configured. Add the Cloudinary credentials to .env.',
        );
      }

      throw new ServiceUnavailableException(message);
    }
  }

  async upload(payload: FinalizeAudioUploadDto): Promise<UploadResponse> {
    try {
      const uploadedAsset =
        this.cloudinaryAudioService.mapDirectUploadResult(payload);
      const record = await this.prismaService.audioAsset.upsert({
        where: {
          cloudinaryPublicId: uploadedAsset.publicId,
        },
        update: {
          cloudinaryAssetId: uploadedAsset.assetId,
          originalFilename: uploadedAsset.originalFilename,
          title: uploadedAsset.title,
          author: uploadedAsset.author,
          durationSeconds: uploadedAsset.durationSeconds,
          previewUrl: uploadedAsset.previewUrl,
          downloadUrl: uploadedAsset.downloadUrl,
          type: uploadedAsset.type,
          tags: uploadedAsset.tags,
          mimeType: payload.mimeType,
          fileSizeBytes: payload.fileSizeBytes,
        },
        create: {
          cloudinaryAssetId: uploadedAsset.assetId,
          cloudinaryPublicId: uploadedAsset.publicId,
          originalFilename: uploadedAsset.originalFilename,
          title: uploadedAsset.title,
          author: uploadedAsset.author,
          durationSeconds: uploadedAsset.durationSeconds,
          previewUrl: uploadedAsset.previewUrl,
          downloadUrl: uploadedAsset.downloadUrl,
          type: uploadedAsset.type,
          tags: uploadedAsset.tags,
          mimeType: payload.mimeType,
          fileSizeBytes: payload.fileSizeBytes,
        },
      });

      return {
        success: true,
        data: this.toAudioTrack(record),
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Audio upload failed.';

      if (message === 'Cloudinary is not configured.') {
        throw new ServiceUnavailableException(
          'Cloudinary is not configured. Add the Cloudinary credentials to .env.',
        );
      }

      throw new ServiceUnavailableException(message);
    }
  }

  getUploadPage(): string {
    return this.cloudinaryAudioService.getUploadPageHtml();
  }

  getCategories(): CategoriesResponse {
    return {
      success: true,
      data: this.categories,
    };
  }

  private buildSearchWhere(query: SearchAudioDto): Prisma.AudioAssetWhereInput {
    if (!query.q) {
      return {
        type: query.type,
      };
    }

    const term = query.q.trim();
    const lowerTerm = term.toLowerCase();

    return {
      type: query.type,
      OR: [
        {
          title: {
            contains: term,
            mode: 'insensitive',
          },
        },
        {
          author: {
            contains: term,
            mode: 'insensitive',
          },
        },
        {
          originalFilename: {
            contains: term,
            mode: 'insensitive',
          },
        },
        {
          tags: {
            has: lowerTerm,
          },
        },
      ],
    };
  }

  private toAudioTrack(record: AudioAsset): AudioTrack {
    return {
      id: record.id,
      title: record.title,
      author: record.author,
      duration_seconds: record.durationSeconds,
      preview_url: record.previewUrl,
      download_url: record.downloadUrl,
      type: record.type,
      source: 'cloudinary',
      tags: record.tags,
    };
  }
}
