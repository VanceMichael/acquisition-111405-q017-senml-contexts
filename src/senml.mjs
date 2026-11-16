// 本地来源声明的 SenML 子集展开。
//
// 只解释 docs/source-contract.md 明确列出的字段与语法；未声明的字段不会被
// 当成业务事实。以 `_` 结尾的未知字段是强制扩展：该条记录整条隔离，且该条
// 携带的基准切换也不生效，避免把无法完整理解的记录拆成半条有效信息。

export const MAX_RELATIVE_SECONDS = 268435456;

const KNOWN_FIELDS = new Set([
  'bn', 'bt', 'bu', 'bv', 'bs', 'n', 't', 'u', 'v', 'vs', 'vb', 'vd', 's',
]);
const VALUE_FIELDS = ['v', 'vs', 'vb', 'vd'];
const VALUE_TYPES = {v: 'number', vs: 'string', vb: 'boolean', vd: 'data'};

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const FIELD_RULES = [
  ['bn', value => typeof value === 'string', '必须是字符串'],
  ['bt', isFiniteNumber, '必须是有限数字'],
  ['bu', value => typeof value === 'string', '必须是字符串'],
  ['bv', isFiniteNumber, '必须是有限数字'],
  ['bs', isFiniteNumber, '必须是有限数字'],
  ['n', value => typeof value === 'string', '必须是字符串'],
  ['t', isFiniteNumber, '必须是有限数字'],
  ['u', value => typeof value === 'string', '必须是字符串'],
  ['v', isFiniteNumber, '必须是有限数字'],
  ['vs', value => typeof value === 'string', '必须是字符串'],
  ['vb', value => typeof value === 'boolean', '必须是布尔值'],
  ['vd', value => typeof value === 'string', '必须是字符串'],
  ['s', isFiniteNumber, '必须是有限数字'],
];

function packageLocation(context) {
  return context.kind === 'pack'
    ? {source: {kind: 'pack', packId: context.packId, packUrl: context.packUrl},
      packId: context.packId, packUrl: context.packUrl}
    : {source: {kind: 'delivery', deliveryId: context.deliveryId, anchor: context.anchor},
      deliveryId: context.deliveryId, anchor: context.anchor};
}

function recordLocation(context, ordinal) {
  return {
    source: context.kind === 'pack'
      ? {kind: 'pack', packId: context.packId, packUrl: context.packUrl, ordinal}
      : {kind: 'delivery', deliveryId: context.deliveryId, anchor: context.anchor, ordinal},
    ...(context.kind === 'pack' ? {packId: context.packId, packUrl: context.packUrl} : {anchor: context.anchor}),
    ...(context.kind === 'delivery' ? {deliveryId: context.deliveryId} : {}),
    ordinal,
  };
}

function recordIssue(context, ordinal, code, message, details = {}) {
  return {code, message, ...recordLocation(context, ordinal), ...details};
}

/**
 * 展开一个完整资料包。`entries` 必须是解析后的 JSON 数组。
 *
 * context:
 *   {kind: 'pack', packId, packUrl}                旧 /packs 接口，bt 缺省按 0 展开
 *   {kind: 'delivery', deliveryId, anchor}         投递接口，anchor 为耐久化的 firstSeenAt
 *
 * 返回本次包内可用的观测与逐位置问题；基准只在本调用内有效，包结束即重置。
 */
export function expandPack(entries, context) {
  if (!Array.isArray(entries)) {
    return {
      records: [],
      issues: [{
        code: 'pack-not-array',
        message: '资料包正文不是记录数组',
        ...packageLocation(context),
      }],
    };
  }

  const records = [];
  const issues = [];

  // 包级基准：默认 bn=""、bt/bv/bs=0、bu 未知。
  // 投递接口省略 bt 时以已固定的 firstSeenAt 为基时；旧 packs 接口以 0 为基时。
  let baseName = '';
  let baseUnit;
  let baseValue = 0;
  let baseSum = 0;
  let baseTime = context.kind === 'delivery' ? context.anchor : 0;

  for (let ordinal = 0; ordinal < entries.length; ordinal++) {
    const entry = entries[ordinal];
    if (!isPlainObject(entry)) {
      issues.push(recordIssue(context, ordinal, 'record-not-object', '记录不是对象'));
      continue;
    }

    const problems = [];
    for (const [field, predicate, description] of FIELD_RULES) {
      if (field in entry && !predicate(entry[field])) problems.push(`${field} ${description}`);
    }

    const valueFields = VALUE_FIELDS.filter(field => field in entry);
    if (valueFields.length > 1) problems.push('v/vs/vb/vd 至多只能出现一种');

    const unsupported = Object.keys(entry).filter(field => field.endsWith('_') && !KNOWN_FIELDS.has(field));

    if (problems.length || unsupported.length) {
      issues.push(recordIssue(context, ordinal,
        unsupported.length ? 'record-unsupported-extension' : 'record-invalid',
        unsupported.length ? '记录含未支持的强制扩展，整条隔离' : '记录字段无法解释，整条隔离', {
          problems,
          ...(unsupported.length ? {fields: unsupported} : {}),
        }));
      // 无法完整解释的记录不参与基准演进，避免它的 bn/bt/bu/bv/bs 影响后续记录。
      continue;
    }

    if ('bn' in entry) baseName = entry.bn;
    if ('bt' in entry) {
      const relative = context.kind === 'delivery' && Math.abs(entry.bt) < MAX_RELATIVE_SECONDS;
      baseTime = relative ? context.anchor + entry.bt : entry.bt;
    }
    if ('bu' in entry) baseUnit = entry.bu;
    if ('bv' in entry) baseValue = entry.bv;
    if ('bs' in entry) baseSum = entry.bs;

    // 只切换基准、没有观测值也没有累计量的记录是合法的上下文记录。
    if (valueFields.length === 0 && !('s' in entry)) continue;

    const record = {
      ...(context.kind === 'pack'
        ? {packId: context.packId, packUrl: context.packUrl}
        : {deliveryId: context.deliveryId, anchor: context.anchor}),
      ordinal,
      name: baseName + ('n' in entry ? entry.n : ''),
      time: baseTime + ('t' in entry ? entry.t : 0),
      unit: 'u' in entry ? entry.u : (baseUnit ?? null),
    };

    if (valueFields.length === 1) {
      const field = valueFields[0];
      record.value = field === 'v' ? entry.v + baseValue : entry[field];
      record.valueType = VALUE_TYPES[field];
    }
    if ('s' in entry) record.sum = entry.s + baseSum;

    records.push(record);
  }

  return {records, issues};
}
