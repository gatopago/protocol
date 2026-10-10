/**
 * The HTTP pieces both Workers (Wallet Core and Flow) answer with, on the standard `Request` and
 * `Response`: expected failures as `{ error_code }`, JSON responses, bounded JSON bodies and CORS.
 */

/** An expected failure, returned to the client as `{ error_code }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

/** A JSON object body of at most `limit` bytes; reading stops as soon as it is larger. */
export async function readJson<T>(request: Request, limit: number): Promise<T> {
  if (!request.headers.get('Content-Type')?.startsWith('application/json'))
    throw new HttpError(415, 'JSON_REQUIRED');
  const text = await readBody(request, limit);
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('not an object');
    return value as T;
  } catch {
    throw new HttpError(400, 'INVALID_JSON');
  }
}

/** The body as text, of at most `limit` bytes: reading stops as soon as it is larger. */
export async function readBody(request: Request, limit: number): Promise<string> {
  if (Number(request.headers.get('Content-Length')) > limit)
    throw new HttpError(413, 'BODY_TOO_LARGE');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    size += chunk.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, 'BODY_TOO_LARGE');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

/** `response` for the allowed `origin`, with the methods and request headers the API accepts. */
export function withCors(
  response: Response,
  origin: string,
  allow: { methods: string; headers: string },
): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', allow.methods);
  headers.set('Access-Control-Allow-Headers', allow.headers);
  headers.set('Access-Control-Max-Age', '600');
  headers.set('Vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
