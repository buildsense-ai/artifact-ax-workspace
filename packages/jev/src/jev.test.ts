import { describe, expect, it } from 'vitest';
import { JevClient, JevError, judgeViewDocument } from './index.js';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const client = (fetchImpl: typeof fetch) => new JevClient({ apiKey: 'k', fetchImpl, retries: 0 });

describe('JevClient', () => {
  it('requires an API key and an absolute base URL', () => {
    expect(() => new JevClient({ apiKey: '' })).toThrow(JevError);
    expect(() => new JevClient({ apiKey: 'k', baseUrl: 'not-a-url' })).toThrow(JevError);
    expect(() => new JevClient({ apiKey: 'k', baseUrl: 'ftp://x' })).toThrow(JevError);
  });

  it('posts {model,state,questions} to /v1/systemone and decodes typed answers', async () => {
    let seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, auth: (init?.headers as Record<string, string>).Authorization, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({
        model: 'jev-1.13.0',
        answers: {
          has_signal: { type: 'noul', noul: 0.21 },
          verdict: { type: 'choice', choice: 'allow', confidence: 0.92, probabilities: { allow: 0.92, flag: 0.08 } },
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const answers = await client(fetchImpl).ask(
      [{ sequence: 0, texts: [{ role: 'evidence', text: 'redacted' }] }],
      { has_signal: { type: 'noul', instructions: 'i' }, verdict: { type: 'choice', instructions: 'i' } },
    );
    expect(seen.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(seen.auth).toBe('Bearer k');
    expect(seen.body?.model).toBe('jev-1.13.0');
    expect((seen.body?.questions as Record<string, unknown>).has_signal).toBeTruthy();
    expect(answers.get('has_signal')).toEqual({ type: 'noul', noul: 0.21 });
    expect(answers.get('verdict')?.type).toBe('choice');
  });

  it('judge() abstains below the signal floor — empty status, never a verdict', async () => {
    const judged = await client(fakeFetch(200, {
      answers: { has_signal: { type: 'noul', noul: 0.4 }, verdict: { type: 'choice', choice: 'allow', confidence: 0.9 } },
    })).judge(
      [{ sequence: 0, texts: [{ role: 'e', text: 'x' }] }],
      { type: 'noul', instructions: 'i' },
      { type: 'choice', instructions: 'i' },
      ['allow', 'flag'],
    );
    expect(judged.abstained).toBe(true);
    if (judged.abstained) expect(judged.confidence).toBeCloseTo(0.6);
  });

  it('judge() rejects unsupported choices and out-of-range confidence', async () => {
    await expect(client(fakeFetch(200, {
      answers: { has_signal: { type: 'noul', noul: 0.9 }, verdict: { type: 'choice', choice: 'merge', confidence: 0.9 } },
    })).judge([{ sequence: 0, texts: [{ role: 'e', text: 'x' }] }],
      { type: 'noul', instructions: 'i' }, { type: 'choice', instructions: 'i' }, ['allow', 'flag']))
      .rejects.toThrow(/unsupported/);

    await expect(client(fakeFetch(200, {
      answers: { has_signal: { type: 'noul', noul: 0.9 }, verdict: { type: 'choice', choice: 'allow', confidence: 1.5 } },
    })).judge([{ sequence: 0, texts: [{ role: 'e', text: 'x' }] }],
      { type: 'noul', instructions: 'i' }, { type: 'choice', instructions: 'i' }, ['allow', 'flag']))
      .rejects.toThrow(/invalid|malformed/i);
  });

  it('retries retryable statuses then fails as transport', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response('{}', { status: 503 });
    }) as unknown as typeof fetch;
    await expect(new JevClient({ apiKey: 'k', fetchImpl, retries: 1, retryBaseDelayMs: 1 }).ask([], {}))
      .rejects.toThrow(/503/);
    expect(calls).toBe(2);
  });
});

describe('judgeViewDocument', () => {
  const base = { proposalId: 'pr-1', baseRevision: 0, rowIds: ['r-1'], documentJson: '{}', contextSummary: 'ctx' };

  it('maps a choice verdict onto the judgment vocabulary', async () => {
    const out = await judgeViewDocument(client(fakeFetch(200, {
      answers: { has_signal: { type: 'noul', noul: 0.9 }, verdict: { type: 'choice', choice: 'flag', confidence: 0.77 } },
    })), base);
    expect(out.verdict).toBe('flag');
    expect(out.confidence).toBeCloseTo(0.77);
  });

  it('maps a floor abstention to abstain with evidence confidence', async () => {
    const out = await judgeViewDocument(client(fakeFetch(200, {
      answers: { has_signal: { type: 'noul', noul: 0.5 }, verdict: { type: 'choice', choice: 'allow', confidence: 0.9 } },
    })), base);
    expect(out.verdict).toBe('abstain');
    expect(out.confidence).toBeCloseTo(0.5);
  });
});
