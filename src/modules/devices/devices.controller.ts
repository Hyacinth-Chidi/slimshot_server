import { Body, Controller, Post } from '@nestjs/common';

import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

@Controller('api/app/v1/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** No auth: this is how an install gets its token. */
  @Post()
  async register(@Body() dto: RegisterDeviceDto) {
    return { success: true as const, data: await this.devices.register(dto) };
  }
}
