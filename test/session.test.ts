import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveEditor, MemorySessionStore, newSessionId, retryAfterMs, SessionManager } from '../src/session.js';

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe('sessions', () => {
  it('ids are 10 base36 characters', () => {
    const ids = new Set(Array.from({ length: 200 }, newSessionId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{10}$/);
  });

  it('create fills defaults and stores the session', async () => {
    const c = clock();
    const m = new SessionManager({ ttlMs: 1000, now: c.now });
    const s = await m.create({ ownerId: 'o', mode: 'js', input: '1', channelId: 'c', triggerId: 't1' });
    expect(s).toMatchObject({ ownerId: 'o', pinned: false, page: 0, expiresAt: c.now() + 1000 });
    expect(s.view).toEqual({ depth: 1, hidden: false, getters: false, path: [], keyPage: 0 });
    expect(await m.get(s.id)).toBe(s);
    expect(await m.findByTrigger('t1')).toBe(s);
  });

  it('expires after the TTL; touch refreshes it', async () => {
    const c = clock();
    const m = new SessionManager({ ttlMs: 1000, now: c.now });
    const s = await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c' });
    c.advance(800);
    await m.touch(s);
    c.advance(800);
    expect(await m.get(s.id)).toBe(s);
    c.advance(1001);
    expect(await m.get(s.id)).toBeUndefined();
  });

  it('pinned sessions and running shells do not expire; watch does', async () => {
    const c = clock();
    const m = new SessionManager({ ttlMs: 100, now: c.now });
    const pinned = await m.pin(await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c' }), true);
    const shell = await m.create({
      ownerId: 'o',
      mode: 'sh',
      input: '',
      channelId: 'c',
      live: { kind: 'shell', paused: false, startedAt: 0 },
    });
    const watch = await m.create({
      ownerId: 'o',
      mode: 'watch',
      input: '',
      channelId: 'c',
      live: { kind: 'watch', paused: false, startedAt: 0 },
    });
    c.advance(1000);
    expect(await m.get(pinned.id)).toBeDefined();
    expect(await m.get(shell.id)).toBeDefined();
    expect(await m.get(watch.id)).toBeUndefined();
    await m.pin(pinned, false);
    c.advance(1000);
    expect(await m.get(pinned.id)).toBeUndefined();
  });

  it('sweep ends expired sessions, aborts live work and calls onExpire', async () => {
    const c = clock();
    const onExpire = vi.fn();
    const m = new SessionManager({ ttlMs: 100, now: c.now, onExpire });
    const s = await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c' });
    const keep = await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c', pinned: true });
    const live = m.live(s.id);
    c.advance(200);
    expect(await m.sweep()).toBe(1);
    expect(onExpire).toHaveBeenCalledWith(s);
    expect(live.abort.signal.aborted).toBe(true);
    expect(m.peekLive(s.id)).toBeUndefined();
    expect(await m.get(keep.id)).toBeDefined();
  });

  it('stop ends everything', async () => {
    const m = new SessionManager({ ttlMs: 100 });
    m.start();
    await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c', pinned: true });
    await m.stop();
    expect(await m.store.list()).toHaveLength(0);
  });

  it('a failing onExpire does not stop the sweep', async () => {
    const c = clock();
    const m = new SessionManager({ ttlMs: 1, now: c.now, onExpire: () => Promise.reject(new Error('gone')) });
    await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c' });
    await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c' });
    c.advance(10);
    expect(await m.sweep()).toBe(2);
  });

  it('trigger index in the memory store', () => {
    const store = new MemorySessionStore();
    const base = {
      flags: {},
      channelId: 'c',
      createdAt: 0,
      expiresAt: 0,
      pinned: false,
      output: '',
      ok: true,
      ms: 0,
      pages: [''],
      page: 0,
      lang: 'txt',
      input: '',
      mode: 'js',
      data: {},
      view: { depth: 1, hidden: false, getters: false, path: [], keyPage: 0 },
    };
    store.set({ ...base, id: 'a', ownerId: 'x', triggerId: 'm1' });
    store.set({ ...base, id: 'b', ownerId: 'y' });
    expect(store.list().map((s) => s.id)).toEqual(['a', 'b']);
    store.set({ ...base, id: 'a', ownerId: 'x', triggerId: 'm2' });
    expect(store.findByTrigger('m1')).toBeUndefined();
    expect(store.findByTrigger('m2')?.id).toBe('a');
    store.delete('a');
    expect(store.findByTrigger('m2')).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  it('keeps values and renews abort controllers', async () => {
    const m = new SessionManager({ ttlMs: 1000 });
    const s = await m.create({ ownerId: 'o', mode: 'js', input: '', channelId: 'c' });
    m.keepValue(s.id, { x: 1 });
    expect(m.live(s.id)).toMatchObject({ hasValue: true, value: { x: 1 } });
    const first = m.live(s.id).abort;
    const second = m.renewAbort(s.id);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    await m.end(s.id);
    expect(second.signal.aborted).toBe(true);
    expect(m.peekLive(s.id)).toBeUndefined();
  });
});

describe('retryAfterMs', () => {
  it('reads Discord-style 429 errors', () => {
    expect(retryAfterMs({ status: 429, body: { retry_after: 1.25 } })).toBe(1250);
    expect(retryAfterMs({ code: 429 })).toBe(1000);
    expect(retryAfterMs({ retry_after: 0.3 })).toBe(300);
    expect(retryAfterMs(new Error('You are being rate limited.'))).toBe(1000);
  });

  it('ignores other errors', () => {
    expect(retryAfterMs(new Error('Unknown Message'))).toBeUndefined();
    expect(retryAfterMs({ status: 404 })).toBeUndefined();
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe('LiveEditor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('merges many updates into few edits, ending with the newest', async () => {
    const sent: number[] = [];
    const editor = new LiveEditor<number>(async (v) => void sent.push(v), { intervalMs: 1000 });
    for (let i = 1; i <= 50; i++) {
      editor.update(i);
      await vi.advanceTimersByTimeAsync(100);
    }
    await editor.flush();
    expect(sent.length).toBeLessThanOrEqual(7);
    expect(sent[sent.length - 1]).toBe(50);
    // Values only grow (never an old value after a newer one)
    expect([...sent].sort((a, b) => a - b)).toEqual(sent);
  });

  it('never runs two edits at the same time', async () => {
    let active = 0;
    let maxActive = 0;
    const editor = new LiveEditor<number>(
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 3000));
        active--;
      },
      { intervalMs: 100 },
    );
    for (let i = 0; i < 20; i++) {
      editor.update(i);
      await vi.advanceTimersByTimeAsync(250);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    await editor.flush();
    expect(maxActive).toBe(1);
  });

  it('waits retry_after on a 429 and retries the content', async () => {
    const calls: { v: string; at: number }[] = [];
    let fail = true;
    const editor = new LiveEditor<string>(
      async (v) => {
        calls.push({ v, at: Date.now() });
        if (fail) {
          fail = false;
          throw { status: 429, body: { retry_after: 2 } };
        }
      },
      { intervalMs: 100 },
    );
    const start = Date.now();
    editor.update('a');
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls.map((c) => c.v)).toEqual(['a', 'a']);
    expect(calls[1]!.at - start).toBeGreaterThanOrEqual(2000);
    expect(editor.edits).toBe(1);
  });

  it('reports other errors and keeps going', async () => {
    const onError = vi.fn();
    let n = 0;
    const editor = new LiveEditor<number>(
      async () => {
        if (n++ === 0) throw new Error('Unknown Message');
      },
      { intervalMs: 10, onError },
    );
    editor.update(1);
    await vi.advanceTimersByTimeAsync(50);
    editor.update(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(onError).toHaveBeenCalledOnce();
    expect(editor.edits).toBe(1);
  });

  it('close drops queued content', async () => {
    const send = vi.fn(async () => undefined);
    const editor = new LiveEditor<number>(send, { intervalMs: 1000 });
    editor.update(1);
    await vi.advanceTimersByTimeAsync(0);
    editor.update(2);
    editor.close();
    editor.update(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
