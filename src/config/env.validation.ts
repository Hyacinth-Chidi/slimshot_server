import { plainToInstance, Transform, TransformFnParams } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsDefined,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidationError,
  validateSync,
} from 'class-validator';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A `.env` line with nothing after `=` arrives as ''. Treat it as unset. */
function blank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === '';
}

const text = ({ value }: TransformFnParams): unknown =>
  blank(value) ? undefined : String(value).trim();

const int =
  (fallback: number) =>
  ({ value }: TransformFnParams): unknown => {
    if (blank(value)) return fallback;
    const s = String(value).trim();
    // Number('15m') is NaN and Number('1e3') is 1000; accept digits only.
    return /^-?\d+$/.test(s) ? Number(s) : s;
  };

const list =
  (fallback: string[]) =>
  ({ value }: TransformFnParams): unknown => {
    if (blank(value)) return fallback;
    return String(value)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  };

const origin = ({ value }: TransformFnParams): unknown =>
  blank(value) ? undefined : String(value).trim().replace(/\/+$/, '');

const URL_OPTIONS = { require_tld: false, require_protocol: true, protocols: ['http', 'https'] };

const DEFAULT_MIME_TYPES = ['audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'];

const DEFAULT_CAPTION_TMP_DIR = join(tmpdir(), 'slimshot-captions');

export class Env {
  @Transform(({ value }) => (blank(value) ? 'development' : String(value).trim()))
  @IsIn(['development', 'production', 'test'])
  NODE_ENV: 'development' | 'production' | 'test' = 'development';

  @Transform(int(2700))
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT = 2700;

  @Transform(origin)
  @IsOptional()
  @IsUrl(URL_OPTIONS)
  ADMIN_BASE_URL?: string;

  // Browsers send Origin without a path, so a trailing slash could never match.
  @Transform((params) => {
    const origins = list([])(params);
    return Array.isArray(origins) ? origins.map((o: string) => o.replace(/\/+$/, '')) : origins;
  })
  @IsArray()
  @IsUrl(URL_OPTIONS, { each: true })
  CORS_ALLOWED_ORIGINS: string[] = [];

  @Transform(text)
  @IsDefined({ message: 'DATABASE_URL is required' })
  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @Transform(text)
  @IsDefined({ message: 'REDIS_URL is required' })
  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL must start with redis:// or rediss://' })
  REDIS_URL!: string;

  @Transform(text)
  @IsDefined({ message: 'JWT_ACCESS_SECRET is required' })
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @Transform(int(900))
  @IsInt()
  @Min(60)
  @Max(3_600)
  JWT_ACCESS_TTL_SECONDS = 900;

  @Transform(int(604_800))
  @IsInt()
  @Min(3_600)
  @Max(7_776_000)
  JWT_REFRESH_TTL_SECONDS = 604_800;

  @Transform(int(5))
  @IsInt()
  @Min(1)
  @Max(100)
  AUTH_LOGIN_MAX_ATTEMPTS = 5;

  @Transform(int(900))
  @IsInt()
  @Min(30)
  @Max(86_400)
  AUTH_LOGIN_LOCKOUT_SECONDS = 900;

  @Transform(text)
  @IsOptional()
  @IsEmail()
  ADMIN_BOOTSTRAP_EMAIL?: string;

  @Transform(text)
  @ValidateIf((env: Env) => env.ADMIN_BOOTSTRAP_EMAIL !== undefined)
  @IsDefined({ message: 'ADMIN_BOOTSTRAP_PASSWORD is required when ADMIN_BOOTSTRAP_EMAIL is set' })
  @IsString()
  ADMIN_BOOTSTRAP_PASSWORD?: string;

  @Transform(int(52_428_800))
  @IsInt()
  @Min(1)
  @Max(1_073_741_824)
  UPLOAD_AUDIO_MAX_BYTES = 52_428_800;

  @Transform(list(DEFAULT_MIME_TYPES))
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  UPLOAD_AUDIO_MIME_TYPES: string[] = DEFAULT_MIME_TYPES;

  @Transform(int(900))
  @IsInt()
  @Min(60)
  @Max(86_400)
  UPLOAD_TICKET_TTL_SECONDS = 900;

  @Transform(text)
  @IsDefined({ message: 'CLOUDINARY_CLOUD_NAME is required' })
  @IsString()
  CLOUDINARY_CLOUD_NAME!: string;

  @Transform(text)
  @IsDefined({ message: 'CLOUDINARY_API_KEY is required' })
  @IsString()
  CLOUDINARY_API_KEY!: string;

  @Transform(text)
  @IsDefined({ message: 'CLOUDINARY_API_SECRET is required' })
  @IsString()
  CLOUDINARY_API_SECRET!: string;

  @Transform(({ value }) => (blank(value) ? 'slimshot/audio' : String(value).trim()))
  @IsString()
  CLOUDINARY_AUDIO_FOLDER = 'slimshot/audio';

  // Encrypts the provider API keys stored in the database. It cannot live
  // there itself: it is what decrypts them.
  @Transform(text)
  @IsDefined({ message: 'MASTER_ENCRYPTION_KEY is required' })
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'MASTER_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)',
  })
  MASTER_ENCRYPTION_KEY!: string;

  @Transform(({ value }) => (blank(value) ? DEFAULT_CAPTION_TMP_DIR : String(value).trim()))
  @IsString()
  CAPTION_TMP_DIR = DEFAULT_CAPTION_TMP_DIR;

  @Transform(int(52_428_800))
  @IsInt()
  @Min(1_048_576)
  @Max(209_715_200)
  CAPTION_MAX_UPLOAD_BYTES = 52_428_800;

  @Transform(int(180))
  @IsInt()
  @Min(30)
  @Max(3_600)
  CAPTION_RESULT_TTL_SECONDS = 180;

  @Transform(int(4))
  @IsInt()
  @Min(1)
  @Max(20)
  CAPTION_CONCURRENCY = 4;

  @Transform(({ value }) => (blank(value) ? 'nova-3' : String(value).trim()))
  @IsString()
  CAPTION_DEEPGRAM_MODEL = 'nova-3';

  @Transform(({ value }) => (blank(value) ? 'scribe_v2' : String(value).trim()))
  @IsString()
  CAPTION_ELEVENLABS_MODEL = 'scribe_v2';
}

function problemsOf(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

/**
 * Parses and validates the environment. Throws one Error listing every
 * problem, so a misconfigured deploy fails at boot with the full picture.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const env = plainToInstance(Env, raw);
  const problems = problemsOf(validateSync(env, { skipMissingProperties: false }));
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n - ${problems.join('\n - ')}`);
  }
  return env;
}

/**
 * The `validate` hook for `ConfigModule.forRoot`: checks everything, then
 * returns the RAW values. forRoot copies the returned object into process.env
 * but only primitive values — a parsed list (string[]) would be dropped, and
 * the namespaces, which re-parse process.env, would silently see defaults.
 */
export function validate(config: Record<string, unknown>): Record<string, unknown> {
  parseEnv(config);
  return config;
}
