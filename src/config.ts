export type RuntimeConfig = {
  maxFileBytes: number;
  maxOriginalFileBytes: number;
  maxTextWriteBytes: number;
  maxReadChars: number;
  cacheTtlSeconds: number;
  maxImageInputBytes: number;
  maxImagePixels: number;
  maxImageDimension: number;
  maxImagePages: number;
  imageProcessingTimeoutMs: number;
};

type NumberRule = {
  name: keyof Env;
  defaultValue: number;
  min: number;
  max: number;
  integer?: boolean;
};

function parseNumber(env: Env, rule: NumberRule): number {
  const raw = env[rule.name];
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return rule.defaultValue;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Configuration ${String(rule.name)} must be a finite number.`);
  }
  if ((rule.integer ?? true) && !Number.isInteger(value)) {
    throw new Error(`Configuration ${String(rule.name)} must be an integer.`);
  }
  if (value < rule.min || value > rule.max) {
    throw new Error(
      `Configuration ${String(rule.name)} must be between ${rule.min} and ${rule.max}.`,
    );
  }
  return value;
}

function megabytes(value: number): number {
  return value * 1024 * 1024;
}

export function getRuntimeConfig(env: Env): RuntimeConfig {
  const maxFileMb = parseNumber(env, {
    name: "MAX_FILE_MB",
    defaultValue: 20,
    min: 1,
    max: 100,
  });
  const maxOriginalFileMb = parseNumber(env, {
    name: "MAX_ORIGINAL_FILE_MB",
    defaultValue: 25,
    min: 1,
    max: 100,
  });
  const maxTextWriteKb = parseNumber(env, {
    name: "MAX_TEXT_WRITE_KB",
    defaultValue: 512,
    min: 1,
    max: 4096,
  });
  return {
    maxFileBytes: megabytes(maxFileMb),
    maxOriginalFileBytes: megabytes(maxOriginalFileMb),
    maxTextWriteBytes: maxTextWriteKb * 1024,
    maxReadChars: parseNumber(env, {
      name: "MAX_READ_CHARS",
      defaultValue: 50_000,
      min: 1_000,
      max: 1_000_000,
    }),
    cacheTtlSeconds: parseNumber(env, {
      name: "CACHE_TTL_SECONDS",
      defaultValue: 604_800,
      min: 0,
      max: 2_592_000,
    }),
    maxImageInputBytes: megabytes(
      parseNumber(env, {
        name: "MAX_IMAGE_INPUT_MB",
        defaultValue: 15,
        min: 1,
        max: 20,
      }),
    ),
    maxImagePixels: parseNumber(env, {
      name: "MAX_IMAGE_PIXELS",
      defaultValue: 40_000_000,
      min: 1_000_000,
      max: 100_000_000,
    }),
    maxImageDimension: parseNumber(env, {
      name: "MAX_IMAGE_DIMENSION",
      defaultValue: 8_192,
      min: 256,
      max: 16_384,
    }),
    maxImagePages: parseNumber(env, {
      name: "MAX_IMAGE_PAGES",
      defaultValue: 8,
      min: 1,
      max: 32,
    }),
    imageProcessingTimeoutMs: parseNumber(env, {
      name: "IMAGE_PROCESSING_TIMEOUT_MS",
      defaultValue: 15_000,
      min: 1_000,
      max: 30_000,
    }),
  };
}

export function validateRequiredConfiguration(env: Env): void {
  const required: Array<keyof Env> = [
    "MICROSOFT_CLIENT_ID",
    "MICROSOFT_CLIENT_SECRET",
    "COOKIE_ENCRYPTION_KEY",
    "OWNER_MICROSOFT_ID",
    "ONEDRIVE_ROOT",
  ];
  for (const key of required) {
    if (!env[key] || String(env[key]).trim() === "") {
      throw new Error(`Required configuration ${String(key)} is missing.`);
    }
  }
  getRuntimeConfig(env);
}
