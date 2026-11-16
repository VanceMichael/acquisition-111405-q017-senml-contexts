import {digest} from './archive.mjs';
import {expandPack} from './senml.mjs';
import {createTransport} from './transport.mjs';

const isNonEmptyString = value => typeof value === 'string' && value.length > 0;
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 问题分类：仍待补齐、无法解释、身份冲突、来源不可用。
// 这些问题可以和可用观测同时存在，所以 complete 不能只看 records 是否为空。
const CATEGORY = {
  pending: 'pending',
  unexplained: 'unexplained',
  conflict: 'conflict',
  unavailable: 'unavailable',
};

function issue(code, category, message, extra = {}) {
  return {code, category, message, ...extra};
}

function packIdFromUrl(packUrl) {
  let pathname;
  try { pathname = new URL(packUrl, 'http://source.invalid').pathname; }
  catch { return packUrl; }
  const segments = pathname.split('/').filter(Boolean);
  return segments.length ? decodeURIComponent(segments.at(-1)) : pathname;
}

// 业务身份由来源位置决定：同一投递（或同一包）在同一位置上的同一条读数，在重试
// 与原文重放时得到相同 id；重复接收只命中同一修订，不会产生副本。
function recordId(record) {
  const identity = record.deliveryId !== undefined
    ? {kind: 'delivery', deliveryId: record.deliveryId, ordinal: record.ordinal, name: record.name, time: record.time}
    : {kind: 'pack', packId: record.packId, ordinal: record.ordinal, name: record.name, time: record.time};
  return 'obs-' + digest(Buffer.from(JSON.stringify(identity))).slice(0, 32);
}

const withIds = records => records.map(record => ({...record, id: recordId(record)}));

async function processPack({packUrl, transport, save, issues}) {
  const packId = packIdFromUrl(packUrl);
  const location = {source: {kind: 'pack', packId, packUrl}, packId, packUrl};

  let response;
  try {
    response = await transport.request(packUrl);
  } catch (error) {
    // 单个包读取失败不中断其余包；原文证据仍由 save 一并归档。
    issues.push(issue('pack-unavailable', CATEGORY.unavailable,
      '资料包无法读取', {...location, detail: error.message}));
    await save({});
    return {records: [], rejected: [{...location, reason: 'pack-unavailable'}]};
  }

  if (!response.ok) {
    issues.push(issue('pack-unavailable', CATEGORY.unavailable,
      '资料包暂时无法读取', {...location, status: response.status}));
    await save({});
    return {records: [], rejected: [{...location, reason: 'pack-unavailable'}]};
  }

  let entries;
  try { entries = response.json(); }
  catch (error) {
    issues.push(issue('pack-invalid', CATEGORY.unexplained,
      '资料包正文不是合法 JSON，无法解释', {...location, detail: error.message}));
    await save({});
    return {records: [], rejected: [{...location, reason: 'pack-invalid'}]};
  }

  // 基准只在本包这一次展开内有效，包结束即重置。
  const expanded = expandPack(entries, {kind: 'pack', packId, packUrl});
  const records = withIds(expanded.records);
  issues.push(...expanded.issues);
  await save({records});
  return {
    records,
    rejected: expanded.issues.map(item => ({
      source: item.source, packId, ordinal: item.ordinal, reason: item.code,
    })),
  };
}

async function processDelivery({delivery, transport, save, issues, pending, rejected, registration}) {
  const deliveryId = delivery.deliveryId;
  const anchor = registration.anchor;
  const source = {kind: 'delivery', deliveryId};
  const location = {deliveryId, anchor, source};
  const parts = Array.isArray(delivery.parts) ? delivery.parts : null;
  const receiptUrl = isNonEmptyString(delivery.receipt) ? delivery.receipt : null;

  if (!parts || parts.length === 0 || !parts.every(isNonEmptyString) || !receiptUrl) {
    issues.push(issue('delivery-listing-invalid', CATEGORY.unexplained,
      '投递登记缺少分片或回执地址，无法领取正文', location));
    rejected.push({...location, reason: 'delivery-listing-invalid'});
    await save({});
    return {records: []};
  }

  // 时间依据只来自首次耐久登记，绝不采用本次领取里的 firstSeenAt。
  const expectedBodyHash = registration.bodyHash ?? null;

  const assembled = [];
  const missing = [];
  for (let index = 0; index < parts.length; index++) {
    try {
      const response = await transport.request(parts[index]);
      if (!response.ok) { missing.push({index, part: parts[index], status: response.status}); continue; }
      assembled.push({index, bytes: response.bytes});
    } catch (error) {
      missing.push({index, part: parts[index], error: error.message});
    }
  }

  // 未领齐：登记为部分收件，绝不确认整包，也不发布任何观测。
  // 已确认过的投递若来源已释放原文，不降级为“待补齐”，也不改动既有观测。
  if (missing.length) {
    if (registration.status === 'received') {
      issues.push(issue('delivery-replay-incomplete', CATEGORY.unavailable,
        '已确认投递的原文重放不完整，既有观测保持不变', {
          ...location, expectedParts: parts.length, receivedParts: assembled.length, missing,
        }));
      await save({});
      return {records: []};
    }
    issues.push(issue('delivery-parts-incomplete', CATEGORY.pending,
      '投递分片尚未领齐，不能确认整包收件', {
        ...location, expectedParts: parts.length, receivedParts: assembled.length, missing,
      }));
    pending.push({deliveryId, anchor, expectedParts: parts.length, receivedParts: assembled.length, missing});
    await save({deliveries: [{deliveryId, status: 'partial', firstSeenAt: delivery.firstSeenAt}]});
    return {records: []};
  }

  const body = Buffer.concat(assembled.sort((left, right) => left.index - right.index).map(item => item.bytes));
  const bodyHash = digest(body);

  // 已隔离的投递保持隔离：不发布、不确认，也不因重放而自动恢复。
  if (registration.status === 'conflict') {
    const sameAsQuarantined = bodyHash === expectedBodyHash;
    issues.push(issue('delivery-quarantined', CATEGORY.conflict,
      '投递已因正文冲突被隔离，本次重放不发布也不确认', {
        ...location, expectedBodyHash, receivedBodyHash: bodyHash,
      }));
    rejected.push({...location, reason: 'delivery-body-conflict', receivedBodyHash: bodyHash});
    await save(sameAsQuarantined ? {} : {
      conflicts: [{deliveryId, anchor, expectedBodyHash, receivedBodyHash: bodyHash, detectedAt: new Date().toISOString()}],
    });
    return {records: []};
  }

  // 同一投递号一旦出现不同完整正文，就隔离这次投递，不把新正文发布成当前观测。
  if (expectedBodyHash && expectedBodyHash !== bodyHash) {
    issues.push(issue('delivery-body-conflict', CATEGORY.conflict,
      '同一投递号出现不同正文，已隔离冲突而不是更新既有观测', {
        ...location, expectedBodyHash, receivedBodyHash: bodyHash,
      }));
    rejected.push({...location, reason: 'delivery-body-conflict', receivedBodyHash: bodyHash});
    await save({
      deliveries: [{deliveryId, status: 'conflict', firstSeenAt: delivery.firstSeenAt, bodyHash: expectedBodyHash}],
      conflicts: [{deliveryId, anchor, expectedBodyHash, receivedBodyHash: bodyHash, detectedAt: new Date().toISOString()}],
    });
    return {records: []};
  }

  let entries;
  try { entries = JSON.parse(body.toString('utf8')); }
  catch (error) {
    issues.push(issue('delivery-body-invalid', CATEGORY.unexplained,
      '投递正文不是合法 JSON，无法解释', {...location, bodyHash, detail: error.message}));
    rejected.push({...location, reason: 'delivery-body-invalid'});
    await save({deliveries: [{deliveryId, status: 'invalid', firstSeenAt: delivery.firstSeenAt}]});
    return {records: []};
  }

  // 只有整包字节完整且身份无冲突时才确认收件；已确认的投递重放不再重复确认。
  if (registration.status !== 'received') {
    let receipt;
    try {
      receipt = await transport.request(receiptUrl, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({deliveryId, bodyHash}),
      });
    } catch (error) {
      issues.push(issue('delivery-receipt-failed', CATEGORY.pending,
        '收件确认请求失败，投递未确认', {...location, detail: error.message}));
      pending.push({deliveryId, anchor, expectedParts: parts.length, receivedParts: assembled.length, receipt: false});
      // 未确认的正文不登记为投递身份，避免来源补发不同正文时被误判成冲突。
      await save({deliveries: [{deliveryId, status: 'partial', firstSeenAt: delivery.firstSeenAt}]});
      return {records: []};
    }
    if (!receipt.ok) {
      issues.push(issue('delivery-receipt-rejected', CATEGORY.pending,
        '来源拒绝收件确认，投递未确认', {...location, status: receipt.status}));
      pending.push({deliveryId, anchor, expectedParts: parts.length, receivedParts: assembled.length, receipt: false});
      await save({deliveries: [{deliveryId, status: 'partial', firstSeenAt: delivery.firstSeenAt}]});
      return {records: []};
    }
  }

  // 收件确认后才解释正文；相对时间一律以耐久登记的 anchor 为基时。
  const expanded = expandPack(entries, {kind: 'delivery', deliveryId, anchor});
  const records = withIds(expanded.records);
  issues.push(...expanded.issues);
  rejected.push(...expanded.issues.map(item => ({
    source: item.source, deliveryId, ordinal: item.ordinal, reason: item.code,
  })));
  await save({
    records,
    deliveries: [{
      deliveryId, status: 'received', firstSeenAt: delivery.firstSeenAt, bodyHash,
      partHashes: [...assembled].sort((left, right) => left.index - right.index).map(item => digest(item.bytes)),
    }],
  });
  return {records};
}

export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const records = [];
  const issues = [];
  const pending = [];
  const rejected = [];

  // 每次提交只带走尚未归档的交换与尚未持久化的问题，避免重复写入同一证据。
  let persistedIssues = 0;
  async function save(payload = {}) {
    const fresh = issues.slice(persistedIssues);
    const result = await archive.commit({...payload, issues: fresh, exchanges: transport.takeExchanges()});
    persistedIssues = issues.length;
    transport.markArchived();
    return result;
  }

  async function finish() {
    await save({});
    return {
      records,
      complete: issues.length === 0,
      issues,
      evidenceCount: transport.exchanges.length,
      pending,
      rejected,
    };
  }

  // 1. 领取清单本身也是一次收件，原文与请求证据一并归档。
  let listing;
  try {
    const response = await transport.request('/packs');
    if (!response.ok) {
      issues.push(issue('listing-unavailable', CATEGORY.unavailable,
        '资料清单暂时无法读取', {status: response.status}));
      return finish();
    }
    listing = response.json();
  } catch (error) {
    issues.push(issue('listing-unavailable', CATEGORY.unavailable,
      '资料清单无法读取', {detail: error.message}));
    return finish();
  }

  if (!isPlainObject(listing)) {
    issues.push(issue('listing-invalid', CATEGORY.unexplained, '资料清单不是对象'));
    return finish();
  }

  const hasPacks = Array.isArray(listing.packs);
  const hasDeliveries = Array.isArray(listing.deliveries);
  if (!hasPacks && !hasDeliveries) {
    issues.push(issue('listing-invalid', CATEGORY.unexplained, '资料清单没有可领取的包或投递'));
    return finish();
  }

  // 清单里无法识别的条目要留下位置，而不是被静默跳过。
  if (hasPacks) {
    for (const [index, packUrl] of listing.packs.entries()) {
      if (!isNonEmptyString(packUrl)) {
        issues.push(issue('listing-invalid', CATEGORY.unexplained, '资料清单包含无效的包地址', {
          source: {kind: 'pack-listing', index}, packOrdinal: index,
        }));
        rejected.push({source: {kind: 'pack-listing', index}, reason: 'listing-invalid'});
      }
    }
  }
  if (hasDeliveries) {
    for (const [index, delivery] of listing.deliveries.entries()) {
      if (!isPlainObject(delivery) || !isNonEmptyString(delivery.deliveryId)) {
        issues.push(issue('listing-invalid', CATEGORY.unexplained, '资料清单包含无效的投递登记', {
          source: {kind: 'delivery-listing', index}, deliveryOrdinal: index,
        }));
        rejected.push({source: {kind: 'delivery-listing', index}, reason: 'listing-invalid'});
      }
    }
  }
  await save({});

  // 2. 旧 packs 接口：与投递互不影响，基准在每个包内独立展开后重置。
  if (hasPacks) {
    for (const packUrl of listing.packs.filter(isNonEmptyString)) {
      const result = await processPack({packUrl, transport, save, issues});
      records.push(...result.records);
      rejected.push(...result.rejected);
    }
  }

  // 3. 投递接口：先耐久登记时间依据，再分段领取正文。
  if (hasDeliveries) {
    const candidates = listing.deliveries.filter(item => isPlainObject(item) && isNonEmptyString(item.deliveryId));
    const before = archive.snapshot();
    const registrations = [];
    const usable = [];

    // 登记阶段：在领取任何分片之前，把时间依据与投递身份写入耐久索引。
    // 已有登记绝不改写 anchor；重试或原文重放只能沿用第一次的 firstSeenAt。
    for (const delivery of candidates) {
      const stored = before.deliveries.find(item => item.deliveryId === delivery.deliveryId);
      if (stored) continue;
      if (!isFiniteNumber(delivery.firstSeenAt)) {
        issues.push(issue('delivery-missing-first-seen', CATEGORY.unexplained,
          '投递登记缺少可固定的首次看到时间，无法解释相对时间', {
            deliveryId: delivery.deliveryId, anchor: null,
            source: {kind: 'delivery', deliveryId: delivery.deliveryId},
          }));
        rejected.push({deliveryId: delivery.deliveryId, reason: 'delivery-missing-first-seen'});
        continue;
      }
      registrations.push({
        deliveryId: delivery.deliveryId,
        firstSeenAt: delivery.firstSeenAt,
        parts: Array.isArray(delivery.parts) ? delivery.parts : [],
        receiptUrl: isNonEmptyString(delivery.receipt) ? delivery.receipt : null,
        status: 'registered',
      });
    }

    let snapshot = before;
    if (registrations.length) snapshot = await save({deliveries: registrations});
    for (const delivery of candidates) {
      const registration = snapshot.deliveries.find(item => item.deliveryId === delivery.deliveryId);
      if (registration) usable.push({delivery, registration});
    }

    // 领取阶段：逐份领取分片，领齐并确认后才发布观测。
    const seen = new Set();
    for (const {delivery, registration} of usable) {
      if (seen.has(delivery.deliveryId)) {
        issues.push(issue('listing-duplicate-delivery', CATEGORY.unexplained,
          '同一清单内重复登记了投递号，只处理第一次', {
            deliveryId: delivery.deliveryId, anchor: registration.anchor,
            source: {kind: 'delivery', deliveryId: delivery.deliveryId},
          }));
        continue;
      }
      seen.add(delivery.deliveryId);
      const result = await processDelivery({delivery, transport, save, issues, pending, rejected, registration});
      records.push(...result.records);
    }
  }

  return finish();
}
