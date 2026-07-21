export class ConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status?: number;
  readonly correlationId: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: {
      retryable?: boolean;
      status?: number;
      correlationId?: string;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
    this.correlationId = options.correlationId ?? crypto.randomUUID();
    this.details = options.details;
  }
}

export function asConnectorError(error: unknown): ConnectorError {
  if (error instanceof ConnectorError) return error;
  return new ConnectorError("internal_error", "The connector could not complete the request.", {
    retryable: false,
  });
}

export function safeErrorResult(error: unknown) {
  const safe = asConnectorError(error);
  return {
    isError: true,
    structuredContent: {
      error: {
        code: safe.code,
        message: safe.message,
        retryable: safe.retryable,
        status: safe.status ?? null,
        correlationId: safe.correlationId,
        details: safe.details ?? null,
      },
    },
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            error: {
              code: safe.code,
              message: safe.message,
              retryable: safe.retryable,
              status: safe.status ?? null,
              correlationId: safe.correlationId,
              details: safe.details ?? null,
            },
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function logSafeError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const safe = asConnectorError(error);
  console.error(
    JSON.stringify({
      event,
      category: safe.code,
      retryable: safe.retryable,
      status: safe.status ?? null,
      correlationId: safe.correlationId,
      ...(safe.details ?? {}),
      ...fields,
    }),
  );
}
