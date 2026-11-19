import Joi from 'joi';

export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number;
  trustProxy: boolean;
  corsOrigins: string[];
  /** Where the built player site is, to serve it from the same address. Empty: API only. */
  webDistDir: string;
  /** Public address of the site, e.g. https://game.leyubid.com. Chapa sends players back here. */
  publicUrl: string;
  databaseUrl: string;
  jwt: { accessSecret: string; accessTtlSeconds: number; refreshTtlDays: number; issuer: string };
  currency: { code: string; minorUnits: number };
  throttle: { limit: number; authLimit: number };
  game: {
    enabled: boolean;
    edgeBps: number;
    flightRiskBps: number;
    totalRiskBps: number;
    maxMultiplierX100: number;
    minBetMinor: bigint;
    maxBetMinor: bigint;
    /** How long betting stays open before each round lifts off. */
    bettingMs: number;
    /** How often the round engine runs (settles cash-outs, ends and starts rounds). 0 = never (tests drive it). */
    tickMs: number;
    chainLength: number;
    chainSalt: string;
  };
  payments: {
    provider: 'none' | 'chapa';
    chapa: { secretKey: string; webhookSecret: string; baseUrl: string; timeoutMs: number };
    minDepositMinor: bigint;
    maxDepositMinor: bigint;
    expiryMinutes: number;
    sweepIntervalSeconds: number;
  };
}

const PLACEHOLDER = /change-me/i;

const schema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3100),
  TRUST_PROXY: Joi.boolean().default(false),
  CORS_ORIGINS: Joi.string().allow('').default('http://localhost:5180'),
  WEB_DIST_DIR: Joi.string().allow('').default(''),
  PUBLIC_URL: Joi.string().uri({ scheme: ['http', 'https'] }).default('http://localhost:5180'),
  DATABASE_URL: Joi.string().uri({ scheme: ['postgresql', 'postgres'] }).required(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(900),
  JWT_REFRESH_TTL_DAYS: Joi.number().integer().min(1).max(90).default(30),
  JWT_ISSUER: Joi.string().default('updraft'),

  CURRENCY: Joi.string().length(3).uppercase().default('ETB'),
  CURRENCY_MINOR_UNITS: Joi.number().integer().min(0).max(3).default(2),

  THROTTLE_LIMIT: Joi.number().integer().min(10).default(600),
  AUTH_THROTTLE_LIMIT: Joi.number().integer().min(1).default(10),

  GAME_ENABLED: Joi.boolean().default(false),
  GAME_EDGE_BPS: Joi.number().integer().min(100).max(1000).default(300),
  GAME_FLIGHT_RISK_BPS: Joi.number().integer().min(1).max(500).default(100),
  GAME_TOTAL_RISK_BPS: Joi.number().integer().min(1).max(3000).default(1000),
  GAME_MAX_MULTIPLIER_X100: Joi.number().integer().min(200).max(1_000_000).default(100_000),
  GAME_MIN_BET_MINOR: Joi.number().integer().min(1).default(100),
  GAME_MAX_BET_MINOR: Joi.number().integer().min(1).default(1_000_000),
  GAME_BETTING_MS: Joi.number().integer().min(2000).max(60000).default(7000),
  GAME_TICK_MS: Joi.number().integer().min(0).max(1000).default(100),
  GAME_CHAIN_LENGTH: Joi.number().integer().min(10).max(1_000_000).default(100_000),
  GAME_CHAIN_SALT: Joi.string().min(1).max(100).default('updraft'),

  PAYMENT_PROVIDER: Joi.string().valid('none', 'chapa').default('none'),
  CHAPA_SECRET_KEY: Joi.string().allow('').default(''),
  CHAPA_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  CHAPA_BASE_URL: Joi.string().uri({ scheme: ['https', 'http'] }).default('https://api.chapa.co'),
  CHAPA_TIMEOUT_MS: Joi.number().integer().min(1000).default(15000),
  DEPOSIT_MIN_MINOR: Joi.number().integer().min(1).default(1000),
  DEPOSIT_MAX_MINOR: Joi.number().integer().min(1).default(10_000_000),
  DEPOSIT_EXPIRY_MINUTES: Joi.number().integer().min(5).default(60),
  PAYMENT_SWEEP_INTERVAL_SECONDS: Joi.number().integer().min(0).default(60),
}).unknown(true);

/** Reads and checks the environment. The server refuses to start on a bad configuration. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const { value: v, error } = schema.validate(env, { abortEarly: false, convert: true });
  if (error) throw new Error(`Invalid configuration: ${error.details.map((d) => d.message).join('; ')}`);

  const problems: string[] = [];
  if (v.NODE_ENV === 'production') {
    if (PLACEHOLDER.test(v.JWT_ACCESS_SECRET)) problems.push('JWT_ACCESS_SECRET is a placeholder');
    if (!/^https:\/\//.test(v.PUBLIC_URL)) problems.push('PUBLIC_URL must be https in production');
  }
  if (v.GAME_MIN_BET_MINOR > v.GAME_MAX_BET_MINOR) problems.push('GAME_MIN_BET_MINOR is above GAME_MAX_BET_MINOR');
  if (v.GAME_FLIGHT_RISK_BPS > v.GAME_TOTAL_RISK_BPS) problems.push('GAME_FLIGHT_RISK_BPS is above GAME_TOTAL_RISK_BPS');
  if (v.PAYMENT_PROVIDER === 'chapa') {
    if (!/^CHASECK(_TEST)?-/.test(v.CHAPA_SECRET_KEY)) problems.push('CHAPA_SECRET_KEY must be a Chapa secret key');
    if (v.CHAPA_WEBHOOK_SECRET && v.CHAPA_WEBHOOK_SECRET.length < 16) problems.push('CHAPA_WEBHOOK_SECRET is too short');
  }
  if (v.DEPOSIT_MIN_MINOR > v.DEPOSIT_MAX_MINOR) problems.push('DEPOSIT_MIN_MINOR is above DEPOSIT_MAX_MINOR');
  if (problems.length) throw new Error(`Invalid configuration: ${problems.join('; ')}`);

  return {
    env: v.NODE_ENV,
    port: v.PORT,
    trustProxy: v.TRUST_PROXY,
    corsOrigins: String(v.CORS_ORIGINS)
      .split(',')
      .map((s: string) => s.trim())
      .filter(Boolean),
    webDistDir: v.WEB_DIST_DIR,
    publicUrl: String(v.PUBLIC_URL).replace(/\/$/, ''),
    databaseUrl: v.DATABASE_URL,
    jwt: {
      accessSecret: v.JWT_ACCESS_SECRET,
      accessTtlSeconds: v.JWT_ACCESS_TTL_SECONDS,
      refreshTtlDays: v.JWT_REFRESH_TTL_DAYS,
      issuer: v.JWT_ISSUER,
    },
    currency: { code: v.CURRENCY, minorUnits: v.CURRENCY_MINOR_UNITS },
    throttle: { limit: v.THROTTLE_LIMIT, authLimit: v.AUTH_THROTTLE_LIMIT },
    game: {
      enabled: v.GAME_ENABLED,
      edgeBps: v.GAME_EDGE_BPS,
      flightRiskBps: v.GAME_FLIGHT_RISK_BPS,
      totalRiskBps: v.GAME_TOTAL_RISK_BPS,
      maxMultiplierX100: v.GAME_MAX_MULTIPLIER_X100,
      minBetMinor: BigInt(v.GAME_MIN_BET_MINOR),
      maxBetMinor: BigInt(v.GAME_MAX_BET_MINOR),
      bettingMs: v.GAME_BETTING_MS,
      tickMs: v.GAME_TICK_MS,
      chainLength: v.GAME_CHAIN_LENGTH,
      chainSalt: v.GAME_CHAIN_SALT,
    },
    payments: {
      provider: v.PAYMENT_PROVIDER,
      chapa: {
        secretKey: v.CHAPA_SECRET_KEY,
        webhookSecret: v.CHAPA_WEBHOOK_SECRET,
        baseUrl: String(v.CHAPA_BASE_URL).replace(/\/$/, ''),
        timeoutMs: v.CHAPA_TIMEOUT_MS,
      },
      minDepositMinor: BigInt(v.DEPOSIT_MIN_MINOR),
      maxDepositMinor: BigInt(v.DEPOSIT_MAX_MINOR),
      expiryMinutes: v.DEPOSIT_EXPIRY_MINUTES,
      sweepIntervalSeconds: v.PAYMENT_SWEEP_INTERVAL_SECONDS,
    },
  };
}
