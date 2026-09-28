import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { hashDeviceToken, newDeviceToken } from './device-token';
import { RegisterDeviceDto } from './dto/register-device.dto';

export interface AuthenticatedDevice {
  id: string;
}

/** A write per request would be pure churn; a minute is precise enough for "last seen". */
const LAST_SEEN_RESOLUTION_MS = 60_000;

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: RegisterDeviceDto): Promise<{ deviceId: string; token: string }> {
    const token = newDeviceToken();
    const device = await this.prisma.device.create({
      data: {
        tokenHash: hashDeviceToken(token),
        platform: input.platform ?? null,
        appVersion: input.appVersion ?? null,
      },
      select: { id: true },
    });
    return { deviceId: device.id, token };
  }

  async authenticate(token: string): Promise<AuthenticatedDevice | null> {
    if (!token) return null;

    const device = await this.prisma.device.findUnique({
      where: { tokenHash: hashDeviceToken(token) },
      select: { id: true, lastSeenAt: true },
    });
    if (!device) return null;

    if (Date.now() - device.lastSeenAt.getTime() >= LAST_SEEN_RESOLUTION_MS) {
      await this.prisma.device.update({
        where: { id: device.id },
        data: { lastSeenAt: new Date() },
      });
    }
    return { id: device.id };
  }
}
