import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource} from '../provider/server.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';
import {expandPack} from '../src/senml.mjs';

const get = (path, body, status = 200) => ({path, method: 'GET', body, status});
const post = (path, body, status = 200) => ({path, method: 'POST', body, status});

// 分片必须拼成同一个 JSON 文档，这里把单个数组从中间切开。
function splitPack(entries) {
  const text = JSON.stringify(entries);
  const middle = Math.floor(text.length / 2);
  return [text.slice(0, middle), text.slice(middle)];
}

async function withSource(scenario, operation) {
  const directory = await mkdtemp(join(tmpdir(), 'source-boundary-'));
  const source = await startSource(scenario);
  try {
    await operation({source, directory, reopen: () => openArchive(directory)});
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
}

test('包内基准持续、切换单位与设备基名，包结束整体重置', async () => {
  const scenario = {
    name: 'boundary-bases',
    routes: [
      get('/packs', {packs: ['/pack/a', '/pack/b']}),
      get('/pack/a', [
        {bn: 'dev/', bt: 500, bu: 'Cel', bv: 10, bs: 4},
        {n: 'temp', v: 1, s: 2},
        {bu: 'percent', bn: 'other/', n: 'humidity', v: 0},
        {n: 'flag', vb: true},
        {n: 'label', vs: 'ok'},
        {n: 'blob', vd: 'AA=='},
        {n: 'total', s: 1},
      ]),
      get('/pack/b', [{n: 'fresh', v: 1}]),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(result.complete, true);
    assert.deepEqual(result.records.map(record => [record.packId, record.ordinal, record.name, record.time, record.unit, record.value]), [
      ['a', 1, 'dev/temp', 500, 'Cel', 11],
      ['a', 2, 'other/humidity', 500, 'percent', 10],
      ['a', 3, 'other/flag', 500, 'percent', true],
      ['a', 4, 'other/label', 500, 'percent', 'ok'],
      ['a', 5, 'other/blob', 500, 'percent', 'AA=='],
      ['a', 6, 'other/total', 500, 'percent', undefined],
      // 包 b 不得继承包 a 的基名、基时、基值、基单位或基累计量。
      ['b', 0, 'fresh', 0, null, 1],
    ]);
    // bv 只加普通值，bs 只加累计量。
    assert.equal(result.records[0].sum, 6);
    const total = result.records.find(record => record.name === 'other/total');
    assert.equal('value' in total, false);
    assert.equal(total.sum, 5);
  });
});

test('强制扩展整条隔离，且其中的基准不得泄漏到后续记录', async () => {
  const scenario = {
    name: 'boundary-extension',
    routes: [
      get('/packs', {packs: ['/pack/x']}),
      get('/pack/x', [
        {bn: 'good/', n: 'one', v: 1},
        {bn: 'leak/', bt: 999, bv: 100, n: 'bad', v: 0, unknown_: 'x'},
        {n: 'two', v: 2},
      ]),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.deepEqual(result.records.map(record => [record.ordinal, record.name, record.time, record.value]), [
      [0, 'good/one', 0, 1],
      [2, 'good/two', 0, 2],
    ]);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(item => item.code === 'record-unsupported-extension' && item.ordinal === 1));
  });
});

test('相对时间在首次耐久收件时固定，重试不因 firstSeenAt 改变而移动观测时轴', async () => {
  const delivery = firstSeenAt => ({
    deliveries: [{deliveryId: 'd1', firstSeenAt, parts: ['/part/1'], receipt: '/accept/d1'}],
  });
  const scenario = {
    name: 'boundary-anchor',
    routes: [
      get('/packs', delivery(1800000000)),
      get('/packs', delivery(1800086400)), // 第二天重发：firstSeenAt 改变
      get('/part/1', [{bn: 'room/', bt: -10, n: 'temp', v: 20}]),
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const first = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    const second = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(first.records[0].time, 1799999990);
    assert.equal(second.records[0].time, 1799999990, '重试不得把读数挪到第二天');
    assert.equal(second.records[0].anchor, 1800000000, '时间依据沿用首次登记');
    const archived = await reopen();
    assert.equal(archived.snapshot().records.length, 1, '重放不增加新观测');
    assert.equal(archived.snapshot().deliveries[0].anchor, 1800000000);
    // 已确认的投递重放不重复 POST 收件。
    assert.equal(source.requests().filter(request => request.path === '/accept/d1').length, 1);
  });
});

test('同一投递号出现不同正文时隔离冲突，不更新既有观测', async () => {
  const delivery = {deliveries: [{deliveryId: 'd1', firstSeenAt: 1800000000, parts: ['/part/1'], receipt: '/accept/d1'}]};
  const scenario = {
    name: 'boundary-conflict',
    routes: [
      get('/packs', delivery),
      get('/packs', delivery),
      get('/part/1', [{bn: 'room/', n: 'temp', v: 20}]),
      get('/part/1', [{bn: 'room/', n: 'temp', v: 21}]), // 重放正文不同
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const first = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(first.records.length, 1);
    const second = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.deepEqual(second.records, [], '冲突正文不得发布');
    assert.equal(second.complete, false);
    assert.ok(second.issues.some(item => item.code === 'delivery-body-conflict' && item.deliveryId === 'd1'));
    assert.equal(second.rejected.some(item => item.reason === 'delivery-body-conflict'), true);
    const archived = await reopen();
    assert.equal(archived.snapshot().records.length, 1);
    assert.equal(archived.snapshot().records[0].value, 20, '既有观测保持原值');
    assert.equal(archived.snapshot().conflicts.length, 1);
    assert.equal(archived.snapshot().conflicts[0].receivedBodyHash === archived.snapshot().deliveries[0].bodyHash, false);
  });
});

test('缺片不得确认整包；补齐后仍沿用首次登记的时间依据', async () => {
  const [head, tail] = splitPack([
    {bn: 'room/', bt: -10, n: 'temp', v: 20},
    {n: 'humidity', v: 40},
  ]);
  const delivery = firstSeenAt => ({
    deliveries: [{deliveryId: 'd1', firstSeenAt, parts: ['/part/1', '/part/2'], receipt: '/accept/d1'}],
  });
  const scenario = {
    name: 'boundary-partial',
    routes: [
      get('/packs', delivery(1800000000)),
      get('/packs', delivery(1800086400)),
      get('/part/1', head),
      get('/part/2', {error: 'not yet'}, 503), // 首次缺片
      get('/part/2', tail),
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const first = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.deepEqual(first.records, [], '未领齐不发布观测');
    assert.equal(first.complete, false);
    assert.equal(first.pending.length, 1);
    assert.equal(source.requests().some(request => request.path === '/accept/d1'), false, '缺片不得确认');

    // 第二次领取的 /part/1 仍是同一份原文；/part/2 补齐。
    const second = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(second.complete, true);
    assert.equal(second.pending.length, 0);
    assert.deepEqual(second.records.map(record => [record.name, record.time, record.value]), [
      ['room/temp', 1799999990, 20],
      ['room/humidity', 1799999990, 40],
    ]);
    assert.equal(source.requests().filter(request => request.path === '/accept/d1').length, 1);
    const archived = await reopen();
    assert.equal(archived.snapshot().deliveries[0].anchor, 1800000000);
    assert.equal(archived.snapshot().deliveries[0].status, 'received');
  });
});

test('缺少首次看到时间的登记无法解释相对时间，且不领取分片', async () => {
  const scenario = {
    name: 'boundary-no-anchor',
    routes: [
      get('/packs', {deliveries: [{deliveryId: 'd1', parts: ['/part/1'], receipt: '/accept/d1'}]}),
      get('/part/1', [{n: 'x', v: 1}]),
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.deepEqual(result.records, []);
    assert.equal(result.complete, false);
    assert.ok(result.issues.some(item => item.code === 'delivery-missing-first-seen'));
    assert.equal(source.requests().some(request => request.path === '/part/1'), false);
    assert.equal(source.requests().some(request => request.path === '/accept/d1'), false);
  });
});

test('投递正文的未支持记录与可用观测分开保留，问题在重开归档后仍可复核', async () => {
  const [head, tail] = splitPack([
    {bn: 'room/', n: 'temp', v: 20},
    {n: 'bad', v: 1, mystery_: true},
  ]);
  const scenario = {
    name: 'boundary-mixed',
    routes: [
      get('/packs', {deliveries: [{deliveryId: 'd1', firstSeenAt: 1800000000, parts: ['/part/1', '/part/2'], receipt: '/accept/d1'}]}),
      get('/part/1', head),
      get('/part/2', tail),
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(result.complete, false);
    assert.deepEqual(result.records.map(record => record.name), ['room/temp']);
    assert.equal(result.rejected.some(item => item.ordinal === 1 && item.reason === 'record-unsupported-extension'), true);
    const archived = await reopen();
    assert.equal(archived.snapshot().records.length, 1);
    assert.ok(archived.snapshot().issues.some(item => item.code === 'record-unsupported-extension'));
    assert.ok(archived.snapshot().evidence.length > 0);
  });
});

test('bt 绝对值达到阈值时按绝对 Unix 秒解释', () => {
  const relative = expandPack([{bt: -10, n: 't', v: 1}], {kind: 'delivery', deliveryId: 'd', anchor: 1800000000});
  assert.equal(relative.records[0].time, 1799999990);
  const absolute = expandPack([{bt: 1800000000, n: 't', v: 1}], {kind: 'delivery', deliveryId: 'd', anchor: 1});
  assert.equal(absolute.records[0].time, 1800000000);
  const threshold = expandPack([{bt: 268435456, n: 't', v: 1}], {kind: 'delivery', deliveryId: 'd', anchor: 1});
  assert.equal(threshold.records[0].time, 268435456);
});

test('已确认投递重放时来源已释放原文，不降级状态也不改动既有观测', async () => {
  const delivery = firstSeenAt => ({
    deliveries: [{deliveryId: 'd1', firstSeenAt, parts: ['/part/1'], receipt: '/accept/d1'}],
  });
  const scenario = {
    name: 'boundary-released',
    routes: [
      get('/packs', delivery(1800000000)),
      get('/packs', delivery(1800086400)),
      {...get('/part/1', [{bn: 'room/', bt: -10, n: 'temp', v: 20}]), once: true},
      get('/part/1', {error: 'released'}, 410),
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const first = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(first.complete, true);
    const second = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(second.complete, false);
    assert.ok(second.issues.some(item => item.code === 'delivery-replay-incomplete'));
    assert.equal(second.pending.length, 0, '已确认投递不因重放缺片回到待补齐');
    const archived = await reopen();
    assert.equal(archived.snapshot().deliveries[0].status, 'received', '状态不降级');
    assert.equal(archived.snapshot().deliveries[0].anchor, 1800000000);
    assert.equal(archived.snapshot().records.length, 1);
    assert.equal(archived.snapshot().records[0].time, 1799999990);
  });
});

test('packs 与 deliveries 同时出现时各自独立展开，互不继承基准', async () => {
  const scenario = {
    name: 'boundary-both',
    routes: [
      get('/packs', {
        packs: ['/pack/p'],
        deliveries: [{deliveryId: 'd1', firstSeenAt: 1800000000, parts: ['/part/1'], receipt: '/accept/d1'}],
      }),
      get('/pack/p', [{bn: 'pack/', bt: 1000, bv: 5, n: 'x', v: 1}]),
      get('/part/1', [{bn: 'delivery/', bt: -10, n: 'y', v: 2}]),
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const result = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(result.complete, true);
    const byPack = result.records.find(record => record.packId === 'p');
    const byDelivery = result.records.find(record => record.deliveryId === 'd1');
    assert.deepEqual([byPack.name, byPack.time, byPack.value, byPack.ordinal], ['pack/x', 1000, 6, 0]);
    assert.deepEqual([byDelivery.name, byDelivery.time, byDelivery.value, byDelivery.anchor], ['delivery/y', 1799999990, 2, 1800000000]);
  });
});

test('已隔离的投递重放原始正文时不自动恢复、不重复确认', async () => {
  const delivery = {deliveries: [{deliveryId: 'd1', firstSeenAt: 1800000000, parts: ['/part/1'], receipt: '/accept/d1'}]};
  const scenario = {
    name: 'boundary-quarantine',
    routes: [
      get('/packs', delivery),
      get('/packs', delivery),
      get('/packs', delivery),
      get('/part/1', [{n: 'temp', v: 20}]),
      get('/part/1', [{n: 'temp', v: 21}]), // 冲突
      get('/part/1', [{n: 'temp', v: 20}]), // 再重放原始正文
      post('/accept/d1', {accepted: true}),
    ],
    expected: [],
    forbidden: [],
  };
  await withSource(scenario, async ({source, reopen}) => {
    const first = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.equal(first.records[0].value, 20);
    const conflict = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.ok(conflict.issues.some(item => item.code === 'delivery-body-conflict'));
    const replay = await collect({baseUrl: source.baseUrl, archive: await reopen(), mode: 'source'});
    assert.deepEqual(replay.records, [], '隔离后重放不得重新发布');
    assert.ok(replay.issues.some(item => item.code === 'delivery-quarantined'));
    const archived = await reopen();
    assert.equal(archived.snapshot().deliveries[0].status, 'conflict');
    assert.equal(archived.snapshot().records.length, 1);
    assert.equal(archived.snapshot().records[0].value, 20);
    assert.equal(source.requests().filter(request => request.path === '/accept/d1').length, 1);
  });
});

test('同一条记录同时声明 v 与 vs 时整条隔离', () => {
  const expanded = expandPack([{n: 'bad', v: 1, vs: 'x'}, {n: 'ok', v: 2}], {
    kind: 'pack', packId: 'p', packUrl: '/p',
  });
  assert.deepEqual(expanded.records.map(record => record.name), ['ok']);
  assert.equal(expanded.issues[0].code, 'record-invalid');
  assert.equal(expanded.issues[0].ordinal, 0);
});
