import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateCreditSettingsDto } from './credit-admin.dto';

async function problems(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(UpdateCreditSettingsDto, body));
  return errors.map((e) => e.property);
}

describe('UpdateCreditSettingsDto: daily credits', () => {
  it('takes the switch and the amount', async () => {
    expect(await problems({ dailyRewardEnabled: true, dailyRewardCredits: 5 })).toEqual([]);
    expect(await problems({ dailyRewardEnabled: false })).toEqual([]);
  });

  it.each([
    [{ dailyRewardEnabled: 'yes' }, 'dailyRewardEnabled'],
    [{ dailyRewardCredits: 0 }, 'dailyRewardCredits'],
    [{ dailyRewardCredits: 2.5 }, 'dailyRewardCredits'],
    [{ dailyRewardCredits: 100_001 }, 'dailyRewardCredits'],
  ])('refuses %j', async (body, field) => {
    expect(await problems(body)).toEqual([field]);
  });
});
