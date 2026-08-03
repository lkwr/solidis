/**
 * String value type: SET/GET family, counters, ranged access, and the various
 * SET option permutations (expiry, existence guards, GET-on-set).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  closeClient,
  createClient,
  createKeyspace,
  isCommandSupported,
  waitFor,
} from '../utils/index.ts';

import type { FeaturedClient } from '../utils/index.ts';

describe('strings', () => {
  let client: FeaturedClient;
  const keyspace = createKeyspace('strings');

  let setIfEqAvailable = false;
  let setIfNeAvailable = false;
  let setIfDeqAvailable = false;
  let setIfDneAvailable = false;
  let digestAvailable = false;
  let delexAvailable = false;

  before(async () => {
    client = await createClient();

    const probeKey = keyspace.key('probe');
    setIfEqAvailable = await isCommandSupported(client, [
      'SET',
      probeKey,
      'x',
      'IFEQ',
      'x',
    ]);
    setIfNeAvailable = await isCommandSupported(client, [
      'SET',
      probeKey,
      'x',
      'IFNE',
      'x',
    ]);
    setIfDeqAvailable = await isCommandSupported(client, [
      'SET',
      probeKey,
      'x',
      'IFDEQ',
      '0000000000000000',
    ]);
    setIfDneAvailable = await isCommandSupported(client, [
      'SET',
      probeKey,
      'x',
      'IFDNE',
      '0000000000000000',
    ]);
    digestAvailable = await isCommandSupported(client, ['DIGEST', probeKey]);
    delexAvailable = await isCommandSupported(client, ['DELEX', probeKey]);

    await client.del(probeKey);
  });

  after(async () => {
    await closeClient(client);
  });

  it('sets and gets a simple value', async () => {
    const key = keyspace.key('simple');

    assert.strictEqual(await client.set(key, 'hello'), 'OK');
    assert.strictEqual(await client.get(key), 'hello');
  });

  it('returns null for a missing key', async () => {
    assert.strictEqual(await client.get(keyspace.key('missing')), null);
  });

  it('reads raw bytes through getBuffer', async () => {
    const key = keyspace.key('buffer');

    await client.set(key, 'raw-bytes');

    const value = await client.getBuffer(key);

    assert.deepStrictEqual(value, Buffer.from('raw-bytes'));
  });

  it('appends and reports the resulting length', async () => {
    const key = keyspace.key('append');

    assert.strictEqual(await client.append(key, 'foo'), 3);
    assert.strictEqual(await client.append(key, 'bar'), 6);
    assert.strictEqual(await client.get(key), 'foobar');
    assert.strictEqual(await client.strlen(key), 6);
  });

  it('supports GETRANGE and SETRANGE', async () => {
    const key = keyspace.key('range');

    await client.set(key, 'Hello World');

    assert.strictEqual(await client.getrange(key, 0, 4), 'Hello');
    assert.strictEqual(await client.getrange(key, -5, -1), 'World');

    await client.setrange(key, 6, 'Redis');

    assert.strictEqual(await client.get(key), 'Hello Redis');
  });

  it('increments and decrements integer counters', async () => {
    const key = keyspace.key('counter');

    assert.strictEqual(await client.incr(key), 1);
    assert.strictEqual(await client.incrby(key, 9), 10);
    assert.strictEqual(await client.decr(key), 9);
    assert.strictEqual(await client.decrby(key, 4), 5);
  });

  it('increments floating point counters precisely', async () => {
    const key = keyspace.key('float');

    assert.strictEqual(await client.incrbyfloat(key, 3.0), 3);
    assert.strictEqual(await client.incrbyfloat(key, 0.1), 3.1);
    assert.strictEqual(await client.incrbyfloat(key, -1.1), 2);
  });

  it('rejects INCR on a non-integer value', async () => {
    const key = keyspace.key('not-a-number');

    await client.set(key, 'abc');

    await assert.rejects(
      () => client.incr(key),
      (error: Error) => {
        assert.strictEqual(
          error.message,
          `[INCR ${key}] Invalid reply: RespError: ERR value is not an integer or out of range`,
        );
        return true;
      },
    );
  });

  it('handles MSET and MGET together', async () => {
    const first = keyspace.key('m', 1);
    const second = keyspace.key('m', 2);
    const third = keyspace.key('m', 3);

    assert.strictEqual(
      await client.mset({ [first]: 'a1', [second]: 'a2', [third]: 'a3' }),
      'OK',
    );

    assert.deepStrictEqual(await client.mget(first, second, third), [
      'a1',
      'a2',
      'a3',
    ]);
    assert.deepStrictEqual(await client.mget(first, keyspace.key('absent')), [
      'a1',
      null,
    ]);
  });

  it('honours MSETNX atomicity', async () => {
    const present = keyspace.key('msetnx', 'present');
    const fresh = keyspace.key('msetnx', 'fresh');

    await client.set(present, 'existing');

    assert.strictEqual(
      await client.msetnx({ [present]: 'x', [fresh]: 'y' }),
      0,
    );
    assert.strictEqual(await client.get(fresh), null);

    const onlyFresh = keyspace.key('msetnx', 'only-fresh');

    assert.strictEqual(await client.msetnx({ [onlyFresh]: 'z' }), 1);
    assert.strictEqual(await client.get(onlyFresh), 'z');
  });

  it('applies SETEX / PSETEX expirations', async () => {
    const secondsKey = keyspace.key('setex');
    const millisKey = keyspace.key('psetex');

    assert.strictEqual(await client.setex(secondsKey, 100, 'value'), 'OK');
    const secondsTtl = await client.ttl(secondsKey);
    assert.ok(secondsTtl >= 99 && secondsTtl <= 100);
    assert.strictEqual(await client.get(secondsKey), 'value');

    assert.strictEqual(await client.psetex(millisKey, 100000, 'value'), 'OK');
    const millisPttl = await client.pttl(millisKey);
    assert.ok(millisPttl >= 99000 && millisPttl <= 100000);
    assert.strictEqual(await client.get(millisKey), 'value');
  });

  it('respects SETNX semantics', async () => {
    const key = keyspace.key('setnx');

    assert.strictEqual(await client.setnx(key, 'first'), 1);
    assert.strictEqual(await client.setnx(key, 'second'), 0);
    assert.strictEqual(await client.get(key), 'first');
  });

  it('reads and clears with GETDEL', async () => {
    const key = keyspace.key('getdel');

    await client.set(key, 'temporary');

    assert.strictEqual(await client.getdel(key), 'temporary');
    assert.strictEqual(await client.get(key), null);
  });

  it('refreshes and clears TTL with GETEX', async () => {
    const key = keyspace.key('getex');

    await client.set(key, 'value');

    assert.strictEqual(
      await client.getex(key, { expireInSeconds: 100 }),
      'value',
    );
    const getexSecondsTtl = await client.ttl(key);
    assert.ok(getexSecondsTtl >= 99 && getexSecondsTtl <= 100);

    assert.strictEqual(
      await client.getex(key, { expireInMilliseconds: 50000 }),
      'value',
    );
    const getexMillisPttl = await client.pttl(key);
    assert.ok(getexMillisPttl >= 49000 && getexMillisPttl <= 50000);

    const futureSeconds = Math.floor(Date.now() / 1000) + 3600;

    assert.strictEqual(
      await client.getex(key, { expireAtSeconds: futureSeconds }),
      'value',
    );
    const getexFutureSecondsTtl = await client.ttl(key);
    assert.ok(getexFutureSecondsTtl >= 3599 && getexFutureSecondsTtl <= 3600);

    const futureMilliseconds = Date.now() + 7200000;

    assert.strictEqual(
      await client.getex(key, { expireAtMilliseconds: futureMilliseconds }),
      'value',
    );
    const getexFutureMillisPttl = await client.pttl(key);
    assert.ok(
      getexFutureMillisPttl >= 7199000 && getexFutureMillisPttl <= 7200000,
    );

    assert.strictEqual(await client.getex(key, { persist: true }), 'value');
    assert.strictEqual(await client.ttl(key), -1);
  });

  it('SET with expireInSeconds option sets a TTL', async () => {
    const key = keyspace.key('set-ex-option');

    assert.strictEqual(
      await client.set(key, 'value', { expireInSeconds: 100 }),
      'OK',
    );
    const setExOptionTtl = await client.ttl(key);
    assert.ok(setExOptionTtl >= 99 && setExOptionTtl <= 100);
    assert.strictEqual(await client.get(key), 'value');
  });

  it('SET honours setIfKeyNotExists / setIfKeyExists guards', async () => {
    const key = keyspace.key('set-guards');

    assert.strictEqual(
      await client.set(key, 'initial', { setIfKeyExists: true }),
      null,
    );
    assert.strictEqual(
      await client.set(key, 'initial', { setIfKeyNotExists: true }),
      'OK',
    );
    assert.strictEqual(
      await client.set(key, 'updated', { setIfKeyNotExists: true }),
      null,
    );
    assert.strictEqual(
      await client.set(key, 'updated', { setIfKeyExists: true }),
      'OK',
    );
    assert.strictEqual(await client.get(key), 'updated');
  });

  it('SET returnOldValue yields the previous value', async () => {
    const key = keyspace.key('set-get');

    await client.set(key, 'old');

    assert.strictEqual(
      await client.set(key, 'new', { returnOldValue: true }),
      'old',
    );
    assert.strictEqual(await client.get(key), 'new');
  });

  it('SET returnOldValueAsBuffer yields a Buffer', async () => {
    const key = keyspace.key('set-get-buffer');

    await client.set(key, 'old');

    const previous = await client.set(key, 'new', {
      returnOldValue: true,
      returnOldValueAsBuffer: true,
    });

    assert.deepStrictEqual(previous, Buffer.from('old'));
  });

  it('SET keepOriginalTimeToLive preserves the TTL', async () => {
    const key = keyspace.key('set-keepttl');

    await client.set(key, 'value', { expireInSeconds: 100 });
    await client.set(key, 'changed', { keepOriginalTimeToLive: true });

    assert.strictEqual(await client.get(key), 'changed');
    const keepTtlValue = await client.ttl(key);
    assert.ok(keepTtlValue >= 99 && keepTtlValue <= 100);
  });

  it('SET with expireInMilliseconds expires the key', async () => {
    const key = keyspace.key('set-px');

    await client.set(key, 'value', { expireInMilliseconds: 60 });

    assert.strictEqual(await client.get(key), 'value');

    await waitFor(async () => (await client.get(key)) === null, {
      timeout: 2000,
      interval: 20,
      description: 'key expired',
    });
  });

  it('preserves binary payloads round-trip', async () => {
    const key = keyspace.key('binary');
    const payload = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x80]);

    await client.set(key, payload);

    const value = await client.getBuffer(key);

    assert.deepStrictEqual(value, payload);
  });

  it('builds SET with EXAT option', async () => {
    const { buildSetCommand } = await import(
      '../../../sources/command/utils/command.ts'
    );

    const command = buildSetCommand('key', 'val', {
      expireAtSeconds: 9999999999,
    });

    assert.deepStrictEqual(command, [
      'SET',
      'key',
      'val',
      'EXAT',
      '9999999999',
    ]);
  });

  it('builds SET with PXAT option', async () => {
    const { buildSetCommand } = await import(
      '../../../sources/command/utils/command.ts'
    );

    const command = buildSetCommand('key', 'val', {
      expireAtMilliseconds: 9999999999999,
    });

    assert.deepStrictEqual(command, [
      'SET',
      'key',
      'val',
      'PXAT',
      '9999999999999',
    ]);
  });

  it('builds SET with KEEPTTL and GET options', async () => {
    const { buildSetCommand } = await import(
      '../../../sources/command/utils/command.ts'
    );

    const command = buildSetCommand('key', 'val', {
      keepOriginalTimeToLive: true,
      returnOldValue: true,
    });

    assert.deepStrictEqual(command, ['SET', 'key', 'val', 'KEEPTTL', 'GET']);
  });

  it('builds SET with IFEQ / IFNE / IFDEQ / IFDNE condition tokens', async () => {
    const { buildSetCommand } = await import(
      '../../../sources/command/utils/command.ts'
    );

    assert.deepStrictEqual(
      buildSetCommand('k', 'v', { setIfValueEquals: 'old' }),
      ['SET', 'k', 'v', 'IFEQ', 'old'],
    );
    assert.deepStrictEqual(
      buildSetCommand('k', 'v', { setIfValueNotEquals: 'old' }),
      ['SET', 'k', 'v', 'IFNE', 'old'],
    );
    assert.deepStrictEqual(
      buildSetCommand('k', 'v', { setIfDigestEquals: 'abc123' }),
      ['SET', 'k', 'v', 'IFDEQ', 'abc123'],
    );
    assert.deepStrictEqual(
      buildSetCommand('k', 'v', { setIfDigestNotEquals: 'abc123' }),
      ['SET', 'k', 'v', 'IFDNE', 'abc123'],
    );
    assert.deepStrictEqual(
      buildSetCommand('k', 'v', {
        setIfValueEquals: 'old',
        returnOldValue: true,
      }),
      ['SET', 'k', 'v', 'IFEQ', 'old', 'GET'],
    );
  });

  it('builds DELEX with optional condition tokens', async () => {
    const { buildDelexCommand } = await import(
      '../../../sources/command/utils/command.ts'
    );

    assert.deepStrictEqual(buildDelexCommand('k'), ['DELEX', 'k']);
    assert.deepStrictEqual(
      buildDelexCommand('k', {
        ifValueEquals: 'v',
      }),
      ['DELEX', 'k', 'IFEQ', 'v'],
    );
    assert.deepStrictEqual(
      buildDelexCommand('k', {
        ifValueNotEquals: 'v',
      }),
      ['DELEX', 'k', 'IFNE', 'v'],
    );
    assert.deepStrictEqual(
      buildDelexCommand('k', {
        ifDigestEquals: 'abc123',
      }),
      ['DELEX', 'k', 'IFDEQ', 'abc123'],
    );
    assert.deepStrictEqual(
      buildDelexCommand('k', {
        ifDigestNotEquals: 'abc123',
      }),
      ['DELEX', 'k', 'IFDNE', 'abc123'],
    );
  });

  it('SET IFEQ guards on the current value', async (context) => {
    if (!setIfEqAvailable) {
      context.skip('requires Redis 8.4+ SET IFEQ');
      return;
    }

    const key = keyspace.key('set-ifeq');

    // IFEQ against a missing key does not create it.
    assert.strictEqual(
      await client.set(key, 'a', { setIfValueEquals: 'x' }),
      null,
    );
    assert.strictEqual(await client.get(key), null);

    await client.set(key, 'a');

    // IFEQ mismatch is a no-op.
    assert.strictEqual(
      await client.set(key, 'b', { setIfValueEquals: 'x' }),
      null,
    );
    assert.strictEqual(await client.get(key), 'a');

    // IFEQ match applies the new value.
    assert.strictEqual(
      await client.set(key, 'b', { setIfValueEquals: 'a' }),
      'OK',
    );
    assert.strictEqual(await client.get(key), 'b');
  });

  it('SET IFNE guards on the current value and creates missing keys', async (context) => {
    if (!setIfNeAvailable) {
      context.skip('requires Redis 8.4+ SET IFNE');
      return;
    }

    const key = keyspace.key('set-ifne');

    await client.set(key, 'b');

    // IFNE mismatch (value equals) is a no-op.
    assert.strictEqual(
      await client.set(key, 'c', { setIfValueNotEquals: 'b' }),
      null,
    );
    assert.strictEqual(await client.get(key), 'b');

    // IFNE match applies the new value.
    assert.strictEqual(
      await client.set(key, 'c', { setIfValueNotEquals: 'x' }),
      'OK',
    );
    assert.strictEqual(await client.get(key), 'c');

    // IFNE against a missing key creates it.
    const fresh = keyspace.key('set-ifne-create');
    assert.strictEqual(
      await client.set(fresh, 'created', { setIfValueNotEquals: 'anything' }),
      'OK',
    );
    assert.strictEqual(await client.get(fresh), 'created');
  });

  it('DIGEST returns the XXH3 hex digest of a string value', async (context) => {
    if (!digestAvailable) {
      context.skip('requires Redis 8.4+ DIGEST');
      return;
    }

    const key = keyspace.key('digest');

    assert.strictEqual(await client.digest(key), null);

    await client.set(key, 'Hello world');

    const d = await client.digest(key);
    assert.ok(typeof d === 'string' && /^[0-9a-fA-F]+$/.test(d), `${d}`);
  });

  it('SET IFDEQ / IFDNE guard on the current hash digest', async (context) => {
    if (!(setIfDeqAvailable && setIfDneAvailable && digestAvailable)) {
      context.skip('requires Redis 8.4+ SET IFDEQ/IFDNE and DIGEST');
      return;
    }

    const key = keyspace.key('set-ifdeq-ifdne');

    await client.set(key, 'v1');
    const d1 = await client.digest(key);
    assert.ok(typeof d1 === 'string');

    // IFDEQ with a non-matching digest is a no-op.
    assert.strictEqual(
      await client.set(key, 'v2', { setIfDigestEquals: '0000000000000000' }),
      null,
    );
    assert.strictEqual(await client.get(key), 'v1');

    // IFDEQ with the matching digest applies.
    assert.strictEqual(
      await client.set(key, 'v2', { setIfDigestEquals: d1 }),
      'OK',
    );
    assert.strictEqual(await client.get(key), 'v2');

    // Recompute the digest for the new value before testing IFDNE.
    const d2 = await client.digest(key);
    assert.ok(typeof d2 === 'string');

    // IFDNE with the matching digest is a no-op.
    assert.strictEqual(
      await client.set(key, 'v3', { setIfDigestNotEquals: d2 }),
      null,
    );
    assert.strictEqual(await client.get(key), 'v2');

    // IFDNE with a non-matching digest applies.
    assert.strictEqual(
      await client.set(key, 'v3', { setIfDigestNotEquals: '0000000000000000' }),
      'OK',
    );
    assert.strictEqual(await client.get(key), 'v3');
  });

  it('DELEX conditionally removes a key', async (context) => {
    if (
      !delexAvailable ||
      !setIfEqAvailable ||
      !setIfNeAvailable ||
      !setIfDeqAvailable ||
      !setIfDneAvailable ||
      !digestAvailable
    ) {
      context.skip('requires Redis 8.4+ DELEX and its condition options');
      return;
    }

    const key = keyspace.key('delex');

    // Without a condition, DELEX behaves like DEL.
    await client.set(key, 'v');
    assert.strictEqual(await client.delex(key), 1);
    assert.strictEqual(await client.get(key), null);
    assert.strictEqual(await client.delex(key), 0);

    // IFEQ only deletes when the current value matches.
    await client.set(key, 'v');
    assert.strictEqual(await client.delex(key, { ifValueEquals: 'wrong' }), 0);
    assert.strictEqual(await client.get(key), 'v');
    assert.strictEqual(await client.delex(key, { ifValueEquals: 'v' }), 1);
    assert.strictEqual(await client.get(key), null);

    // IFNE deletes when the current value differs.
    await client.set(key, 'v');
    assert.strictEqual(await client.delex(key, { ifValueNotEquals: 'v' }), 0);
    assert.strictEqual(
      await client.delex(key, { ifValueNotEquals: 'other' }),
      1,
    );
    assert.strictEqual(await client.get(key), null);

    // IFDEQ / IFDNE based on the digest.
    await client.set(key, 'v');
    const digest = await client.digest(key);
    assert.ok(typeof digest === 'string');

    assert.strictEqual(
      await client.delex(key, { ifDigestEquals: '0000000000000000' }),
      0,
    );
    assert.strictEqual(await client.get(key), 'v');
    assert.strictEqual(await client.delex(key, { ifDigestEquals: digest }), 1);
    assert.strictEqual(await client.get(key), null);

    await client.set(key, 'v');
    assert.strictEqual(
      await client.delex(key, { ifDigestNotEquals: digest }),
      0,
    );
    assert.strictEqual(
      await client.delex(key, { ifDigestNotEquals: '0000000000000000' }),
      1,
    );
    assert.strictEqual(await client.get(key), null);
  });
});
