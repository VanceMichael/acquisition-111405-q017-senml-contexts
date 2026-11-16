# 传感器资料包的基准上下文与数值语义接收

这是资料接收服务的独立工作副本。当前版本支持人工摘要的领取、原文归档、重复导入和归档检查，并已接入新来源的 `source` 模式：带基准上下文的资料包、分段领取的投递、耐久时间依据与冲突隔离。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是回归测试，验证现有摘要通路、原文摘要检查、本地来源响应、CLI 在独立进程中的真实领取、重复导入和持久归档检查，以及新来源的边界行为（基准重置、单位切换、强制扩展隔离、时间依据固定、冲突隔离、缺片不确认）。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收。验收文件及断言原样保留，没有跳过、删除或把失败转为成功。交付时执行 `npm run verify:complete`，让基线和新来源验收同时通过；不能只用基线成功说明新功能已完成。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `base-reset`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-senml-contexts:local .
docker run --rm --network none acquisition-senml-contexts:local
docker run --rm --network none acquisition-senml-contexts:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口；`legacy` 与 `source` 两种模式并存。
- `src/source.mjs` 实现新来源：领取清单、旧 `packs` 逐包展开、投递的耐久登记与分段领取、冲突隔离。
- `src/senml.mjs` 展开来源声明的 SenML 子集：包内基准持续、包结束重置，`bv` 只叠加普通值、`bs` 只叠加累计量。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文、记录修订、投递登记与冲突区；存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`collect(..., {mode: 'source'})` 返回 `{records, complete, issues, evidenceCount, pending, rejected}`：`records` 是可使用的观测，`issues` 是带来源位置的逐条问题，`pending` 是仍待补齐的投递，`rejected` 是无法解释或已隔离的来源位置。这三类与 `records` 分开，可同时存在；`complete` 只有在没有任何未决问题时才为 `true`。

时间依据在投递第一次耐久登记时固定，此后重试与原文重放都沿用同一 `anchor`，不采用本次领取的 `firstSeenAt`。同一 `deliveryId` 的完整正文一旦不同，就写入冲突区并拒绝发布新观测，已有观测保持不变。未领齐全部 `parts` 前不会 POST receipt，也不会发布观测。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
