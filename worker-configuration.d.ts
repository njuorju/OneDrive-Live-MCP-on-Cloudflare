interface Env {
  OAUTH_KV: KVNamespace;
  MCP_OBJECT: DurableObjectNamespace;
  AUTH_STATE: DurableObjectNamespace;
  AI: Ai;
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  OWNER_MICROSOFT_ID: string;
  CONNECTOR_NAME: string;
  ONEDRIVE_ROOT: string;
  MAX_FILE_MB: string;
  MAX_READ_CHARS: string;
  CACHE_TTL_SECONDS: string;
}
