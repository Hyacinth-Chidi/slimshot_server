import { HttpStatus, Injectable } from '@nestjs/common';

import { appError } from '../../core/errors/app-error';
import { ErrorCode } from '../../core/errors/error-codes';
import { isUniqueViolation } from '../../core/errors/prisma-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeUsername, usernameProblem } from './username';

export type UsernameCheck =
  | { username: string; available: true }
  | { username: string; available: false; reason: 'INVALID' | 'RESERVED' | 'TAKEN' };

const taken = () => appError(HttpStatus.CONFLICT, ErrorCode.USERNAME_TAKEN, 'That username is taken.');

@Injectable()
export class UsernameService {
  constructor(private readonly prisma: PrismaService) {}

  async check(raw: string, forUserId?: string): Promise<UsernameCheck> {
    const username = normalizeUsername(raw);
    const problem = usernameProblem(username);
    if (problem) return { username, available: false, reason: problem };
    const owner = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (owner && owner.id !== forUserId) return { username, available: false, reason: 'TAKEN' };
    return { username, available: true };
  }

  async assertAvailable(raw: string, userId: string): Promise<string> {
    const result = await this.check(raw, userId);
    if (result.available) return result.username;
    if (result.reason === 'TAKEN') throw taken();
    throw appError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      ErrorCode.USERNAME_INVALID,
      result.reason === 'RESERVED' ? 'That username is reserved.' : 'Usernames are 3–20 characters: a–z, 0–9 and _.',
    );
  }

  async change(userId: string, raw: string): Promise<string> {
    const username = await this.assertAvailable(raw, userId);
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { username } });
    } catch (err) {
      if (isUniqueViolation(err)) throw taken();
      throw err;
    }
    return username;
  }
}
