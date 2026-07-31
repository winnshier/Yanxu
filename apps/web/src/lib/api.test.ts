import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, normalizeTaskEvidence } from './api.js';

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: () => Promise.resolve(body),
  } as Response;
}

describe('api request headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only declares JSON content when a request has a body', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'test-csrf' }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await api.probeExecutors();
    await api.updateSettings({ maxParallelTasks: 2 });

    const probeInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(probeInit.method).toBe('POST');
    expect(probeInit.body).toBeUndefined();
    expect(probeInit.headers).toEqual({ 'x-yanxu-csrf': 'test-csrf' });

    const updateInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(updateInit.body).toBe(JSON.stringify({ maxParallelTasks: 2 }));
    expect(updateInit.headers).toEqual({
      'content-type': 'application/json',
      'x-yanxu-csrf': 'test-csrf',
    });
  });

  it('normalizes evidence from an older daemon instead of crashing the execution page', () => {
    const evidence = normalizeTaskEvidence({
      artifacts: [],
      deliveryReport: null,
    });

    expect(evidence.qualitySummary).toMatchObject({
      status: 'not_configured',
      configured: 0,
      blockingFindings: [],
    });
    expect(evidence.designedQualityGates).toEqual([]);
    expect(evidence.permissionManifests).toEqual([]);
  });
});
