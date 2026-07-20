interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  AUTH_STATE: DurableObjectNamespace;
  AI: Ai;
  IMAGES: ImagesBinding;
  BROWSER: BrowserRun;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OWNER_MICROSOFT_ID: string;
  CONNECTOR_NAME: string;
  ONEDRIVE_ROOT: string;
  MAX_FILE_MB: string;
  MAX_ORIGINAL_FILE_MB: string;
  MAX_TEXT_WRITE_KB: string;
  MAX_READ_CHARS: string;
  CACHE_TTL_SECONDS: string;
  MAX_IMAGE_INPUT_MB: string;
  MAX_IMAGE_PIXELS: string;
  MAX_IMAGE_DIMENSION: string;
  MAX_IMAGE_PAGES: string;
  IMAGE_PROCESSING_TIMEOUT_MS: string;
}
