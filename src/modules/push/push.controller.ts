import { Body, Controller, HttpCode, Put } from '@nestjs/common';

import { PushTokenDto } from './dto/push-token.dto';
import { PushService } from './push.service';

@Controller('api/app/v1/push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** No sign-in: every install can get messages to everyone; a signed-in install also gets its user's. */
  @Put('token')
  @HttpCode(200)
  async setToken(@Body() dto: PushTokenDto) {
    return { success: true as const, data: await this.push.setToken(dto.deviceToken, dto.token) };
  }
}
