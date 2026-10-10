import { describe, expect, it } from 'vitest';
import { HttpError, json, readBody, readJson, withCors } from '../packages/shared/http';

const post = (body: BodyInit, type = 'application/json') =>
  new Request('https://api.test/', {
    method: 'POST',
    headers: { 'Content-Type': type },
    body,
    duplex: 'half',
  } as RequestInit);

describe('http', () => {
  it('stops reading a body as soon as it is larger than the limit', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 16_384;
        controller.enqueue(new Uint8Array(16_384).fill(32));
      },
    });
    await expect(readJson(post(endless), 32_768)).rejects.toThrow('BODY_TOO_LARGE');
    expect(pulled).toBeLessThan(64 * 1024);
    // The limit is in bytes, not characters: "ñ" takes two.
    expect(await readBody(post('ññ'), 4)).toBe('ññ');
    await expect(readBody(post('ñññ'), 4)).rejects.toThrow('BODY_TOO_LARGE');
  });

  it('accepts only a JSON object', async () => {
    expect(await readJson(post('{"amount":"1.00"}'), 1024)).toEqual({ amount: '1.00' });
    for (const body of ['null', '[]', '"text"', '{'])
      await expect(readJson(post(body), 1024)).rejects.toThrow('INVALID_JSON');
    await expect(readJson(post('{}', 'text/plain'), 1024)).rejects.toThrow('JSON_REQUIRED');
  });

  it('answers errors and CORS in one shape for both Workers', async () => {
    const error = new HttpError(404, 'NOT_FOUND');
    expect(error.status).toBe(404);
    const response = withCors(json({ ok: true }), 'https://gatopago.com', {
      methods: 'GET, POST',
      headers: 'Authorization',
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://gatopago.com');
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true });
  });
});
