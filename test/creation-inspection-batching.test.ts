import { describe, expect, it } from 'vitest';
import { inspectCreationDeployment } from '../packages/shared/v3/creationInspection';
import { creationInspectionScenario } from '../packages/test-fixtures/v3CreationInspection';

describe('creation inspection stages', () => {
  it('drains all code reads before failing and never calls getters on unknown code', async () => {
    const f = creationInspectionScenario(), original = f.request.getMockImplementation()!;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let finished = false;
    f.request.mockImplementation(async request => {
      if (request.method === 'eth_getCode') {
        if (request.params?.[0] === f.profile.deployment.components.factory.address) return '0x';
        await pending;
      }
      return original(request);
    });
    const result = inspectCreationDeployment(f.client, f.input).catch(error => { finished = true; return error; });
    for (let i = 0; i < 30 && f.request.mock.calls.length < 10; i++) await Promise.resolve();
    expect(f.request.mock.calls.filter(([request]) => request.method === 'eth_getCode')).toHaveLength(7);
    expect(finished).toBe(false);
    release();
    expect(await result).toMatchObject({ code: 'UNEXPECTED_CODE' });
    expect(f.request.mock.calls.some(([request]) => request.method === 'eth_call')).toBe(false);
  });

  it('keeps all 29 logical reads and the separate closing checkpoint', async () => {
    const f = creationInspectionScenario();
    expect(await inspectCreationDeployment(f.client, f.input)).toMatchObject({ status: 'composition_matches' });
    expect(f.request).toHaveBeenCalledTimes(29);
    expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'eth_getBlockByNumber', params: ['0x64', false] });
  });
});
