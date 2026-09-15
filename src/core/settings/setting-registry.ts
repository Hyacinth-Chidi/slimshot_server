export type SettingType = 'string' | 'int' | 'boolean' | 'string[]' | 'json';

export interface SettingDefinition<T = unknown> {
  key: string;
  group: string;
  type: SettingType;
  default: T;
  secret: boolean;
  description?: string;
  min?: number;
  max?: number;
  minLength?: number;
  enum?: readonly string[];
}

export function defineSetting<T>(def: SettingDefinition<T>): SettingDefinition<T> {
  return Object.freeze(def);
}

export function validateSetting<T>(def: SettingDefinition<T>, value: unknown): T {
  switch (def.type) {
    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${def.key}: expected int, got ${typeof value}`);
      }
      if (def.min !== undefined && value < def.min) {
        throw new Error(`${def.key}: must be at least ${def.min}`);
      }
      if (def.max !== undefined && value > def.max) {
        throw new Error(`${def.key}: must be at most ${def.max}`);
      }
      return value as T;
    }
    case 'string': {
      if (typeof value !== 'string') {
        throw new Error(`${def.key}: expected string, got ${typeof value}`);
      }
      if (def.minLength !== undefined && value.length < def.minLength) {
        throw new Error(
          `${def.key}: must be at least ${def.minLength} characters`,
        );
      }
      if (def.enum && !def.enum.includes(value)) {
        throw new Error(`${def.key}: must be one of ${def.enum.join(', ')}`);
      }
      return value as T;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new Error(`${def.key}: expected boolean, got ${typeof value}`);
      }
      return value as T;
    }
    case 'string[]': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new Error(`${def.key}: expected string[]`);
      }
      return value as T;
    }
    case 'json': {
      if (value === null || typeof value !== 'object') {
        throw new Error(`${def.key}: expected json object`);
      }
      return value as T;
    }
  }
}
