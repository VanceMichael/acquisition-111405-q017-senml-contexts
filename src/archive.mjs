import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename} from 'node:fs/promises';
import {join} from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.partial`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 投递状态只允许单调向前：登记 < 部分收件/无法解释 < 收件确认 < 已隔离冲突。
// 冲突高于收件确认，避免后续重放把隔离记录改写回正常收件。
const STATUS_RANK = {registered: 0, partial: 1, invalid: 1, received: 2, conflict: 3};

function validateDelivery(delivery, {requireAnchor}) {
  if (!isPlainObject(delivery)) throw new Error('投递登记不是对象');
  if (typeof delivery.deliveryId !== 'string' || !delivery.deliveryId.trim()) throw new Error('投递登记缺少标识');
  if (requireAnchor) {
    if (typeof delivery.firstSeenAt !== 'number' || !Number.isFinite(delivery.firstSeenAt)) {
      throw new Error('投递登记缺少有效的首次看到时间');
    }
  }
}

export async function openArchive(directory) {
  await mkdir(join(directory, 'raw'), {recursive: true});
  const indexPath = join(directory, 'index.json');
  let state = {schema: 1, records: [], evidence: [], issues: [], deliveries: [], conflicts: []};
  try { state = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.schema !== 1 || !Array.isArray(state.records) || !Array.isArray(state.evidence)) {
    throw new Error('资料索引版本或结构无效');
  }
  // schema 1 的增量扩展：旧索引没有投递登记与冲突区，读取时补齐即可继续使用。
  if (!Array.isArray(state.deliveries)) state.deliveries = [];
  if (!Array.isArray(state.conflicts)) state.conflicts = [];
  for (const item of state.evidence) {
    if (!/^[a-f0-9]{64}$/.test(item.hash)) throw new Error('资料索引摘要无效');
    if (digest(await readFile(join(directory, 'raw', item.hash))) !== item.hash) throw new Error('原文摘要不匹配');
  }
  let tail = Promise.resolve();
  return {
    snapshot: () => structuredClone(state),
    async raw(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('原文引用无效');
      const bytes = await readFile(join(directory, 'raw', hash));
      if (digest(bytes) !== hash) throw new Error('原文损坏');
      return bytes;
    },
    commit({records = [], exchanges = [], issues = [], deliveries = [], conflicts = []}) {
      const operation = tail.then(async () => {
        const next = structuredClone(state);
        for (const exchange of exchanges) {
          const hash = digest(exchange.bytes);
          await atomicWrite(join(directory, 'raw', hash), exchange.bytes);
          const item = {url: exchange.url, method: exchange.method, status: exchange.status, headers: exchange.headers, hash};
          const receipt = digest(Buffer.from(JSON.stringify(item)));
          if (!next.evidence.some(previous => previous.receipt === receipt)) next.evidence.push({...item, receipt});
        }
        for (const incoming of deliveries) {
          const existing = next.deliveries.find(item => item.deliveryId === incoming.deliveryId);
          if (!existing) {
            validateDelivery(incoming, {requireAnchor: true});
            next.deliveries.push({
              deliveryId: incoming.deliveryId,
              // 首次耐久登记时固定时间依据；此后任何重试或原文重放都只沿用该值。
              anchor: incoming.firstSeenAt,
              firstSeenAt: incoming.firstSeenAt,
              lastFirstSeenAt: incoming.firstSeenAt,
              parts: Array.isArray(incoming.parts) ? structuredClone(incoming.parts) : [],
              receiptUrl: typeof incoming.receiptUrl === 'string' ? incoming.receiptUrl : null,
              status: typeof incoming.status === 'string' ? incoming.status : 'registered',
              bodyHash: typeof incoming.bodyHash === 'string' ? incoming.bodyHash : null,
              // 每个分片的原文摘要，供来源释放原文后的重放核对与重建。
              partHashes: Array.isArray(incoming.partHashes) ? incoming.partHashes.slice() : null,
            });
          } else {
            validateDelivery({...incoming, firstSeenAt: 0}, {requireAnchor: false});
            // anchor / firstSeenAt 永不改写；只更新本次领取的状态与证据。
            if (typeof incoming.firstSeenAt === 'number' && Number.isFinite(incoming.firstSeenAt)) {
              existing.lastFirstSeenAt = incoming.firstSeenAt;
            }
            if (Array.isArray(incoming.parts)) existing.parts = structuredClone(incoming.parts);
            if (typeof incoming.receiptUrl === 'string') existing.receiptUrl = incoming.receiptUrl;
            // 投递状态只向前推进，后续部分重试不能把已确认或已隔离的投递降级。
            if (typeof incoming.status === 'string' && STATUS_RANK[incoming.status] >= STATUS_RANK[existing.status]) {
              existing.status = incoming.status;
            }
            if (typeof incoming.bodyHash === 'string') existing.bodyHash = incoming.bodyHash;
            if (Array.isArray(incoming.partHashes)) existing.partHashes = incoming.partHashes.slice();
            if (typeof incoming.receiptHash === 'string') existing.receiptHash = incoming.receiptHash;
          }
        }
        for (const conflict of conflicts) {
          if (!next.conflicts.some(previous =>
            previous.deliveryId === conflict.deliveryId &&
            previous.expectedBodyHash === conflict.expectedBodyHash &&
            previous.receivedBodyHash === conflict.receivedBodyHash)) {
            next.conflicts.push(structuredClone(conflict));
          }
        }
        for (const record of records) {
          if (typeof record.id !== 'string' || !record.id) throw new Error('资料缺少归档标识');
          const revision = digest(Buffer.from(JSON.stringify(record)));
          if (!next.records.some(previous => previous.id === record.id && previous.revision === revision)) {
            next.records.push({...structuredClone(record), revision});
          }
        }
        // 同一缺口在反复重试时不无限重复；内容相同的问题只保留一份。
        for (const item of structuredClone(issues)) {
          const key = digest(Buffer.from(JSON.stringify(item)));
          if (!next.issues.some(previous => digest(Buffer.from(JSON.stringify(previous))) === key)) next.issues.push(item);
        }
        await atomicWrite(indexPath, JSON.stringify(next, null, 2) + '\n');
        state = next;
        return structuredClone(state);
      });
      tail = operation.catch(() => {});
      return operation;
    }
  };
}
