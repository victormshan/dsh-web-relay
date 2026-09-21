// 落盘记录 + 触发 watchdog 接管重启（激活重启后自检钩子）
import fs from 'node:fs';

const TRACE = 'D:\\dsh relay test\\web-relay\\traces\\expr-2026-09-13_17-36-07.md';
const REQ = 'D:\\dsh-web-relay\\bin\\restart.request.json';

const body = `
【重启后自检钩子落地（方案 B）：提交 78d433b + 一个必现缺陷的复核拦截 + 变异验证】

一、交付
- cc 任务 ccfeat-20260915-selfcheck **跑满 900s 被硬杀**（result.json: errorCode=cc-timeout, exit=124,
  claude.log 因缓冲为空）。按既有纪律**以产物而非标记判定**：产物完整可用，经独立复核后收下。
- 独立验收 ACCEPT 7/7；全量 538 → **559/559**；写入范围与声明完全一致（5 文件，无需放行）。
- 内容：lib/selfcheck.mjs（纯函数：漂移比对/契约判定/通知判定/外部结果映射/bootId 幂等）+
  lib/index.js 的 bootSelfCheck（与 bootResumeScan 同批次异步、绝不阻塞、全程 fail-open、
  每 boot 幂等、仅在异常时复用 wakeMainAgent 唤醒）+ /health-check 暴露 selfCheck 字段 +
  外部重回归严格 opt-in（DSH_RELAY_SELFCHECK_CMD，**异步 spawn + 超时 kill，严禁 execSync**）。

二、复核拦截到一个「每次重启都会假唤醒主 agent」的必现缺陷
- 现象：契约自检的 health handler 源码切片用
  src.indexOf('const healthCheckHandler = async') **从文件开头**找锚点。
- 根因：该锚点字面量**恰好出现在那个函数自己的源码里**（作为搜索字面量），且位置（L1990）**早于**
  真实定义（L2307）→ indexOf 命中的是「搜索字面量自己」→ 切片退化成 **96 字符** → 14 个必需字段
  **全部**判为缺失 → 契约检查恒失败 → **每次宿主重启都假唤醒一次**，与规格「无问题绝不打扰」相反。
  实测：修正前 11/14 字段缺失；改 lastIndexOf 后切片 1681 字符、0 缺失。
- **为何 18 个单测全绿却漏掉**：它们全是「喂内存 fake」的纯函数用例，**从未触碰真实提取路径**——
  单测全绿、集成必坏。这正是机械验收的边界（OPS §6「审计盲点」）在本次的具体体现。
- 修法（根因层面）：把切片逻辑与必需清单下移到 lib/selfcheck.mjs（纯函数 sliceHandlerSource +
  导出 SELFCHECK_REQUIRED_ROUTES/HEALTH_FIELDS），index.js 只调用——锚点字面量因此**不再存在于
  被搜索的文件中**；再取 lastIndexOf 作双保险。补 3 条测试，其中一条**对真实 lib/index.js**
  跑「路由提取 + 切片 + 契约判定」并断言必须通过。

三、变异验证抓出**我自己的守卫是无效的**（本次最有价值的一步）
- 首版守卫测试在把实现变异回 indexOf 后**依然 21/21 全绿 → 守卫无效**。两个原因：
  ① 修复后切片逻辑已搬离 lib/index.js，真实文件里不再有 decoy（根因已消除）；
  ② 断言写成 includes，而 maxLen 兜底会把锚点之后的真实定义一并吞进来，断言恒成立。
- 遂把断言改为**位置性** startsWith('const healthCheckHandler = async (req, res)')；复验：
  变异版下「切片守卫」精确失败（fail=1），自动还原后 sha 一致（45E045855E82A5B8）、全量复绿。
- 结论（值得进教训库）：**「测试通过」不等于「守卫生效」**；对关键守卫必须做变异验证，
  且断言要落在**能区分缺陷形态的性质**上（此处是切片起点位置），而非宽容的包含关系。
  （「端到端契约」那条已如实标注为守「字段漂移/处理器改名」，不夸大为守本陷阱。）

四、交付与风险规避
- deliver-three-copies --apply：4 文件 × 3 副本、回读校验通过；交付后漂移 **0 待更新**（自检会报干净）。
- **关键风险已排除**：lib/selfcheck.mjs 是**新文件**，运行时副本若缺它 → 宿主重启时 import 失败
  → 插件加载报错（即本次事故同款报错）。已确认三副本均存在且哈希一致 45E045855E82A5B8。
- 用户已选定**方案 B**：**不设置** DSH_RELAY_SELFCHECK_CMD（只跑进程内漂移+契约，不跑外部全量回归），
  理由：接全量会让每次重启有 1-2 分钟 CPU 开销，与宿主争 CPU 且探针本就偶发 timeout，有诱发重启风暴风险。

五、本次动作
经用户确认，写 signal 文件由 watchdog 接管重启以**激活**该自检（插件代码需重启才加载）。
重启后核验：/health-check 的 selfCheck 应为
{ drift:{checked:52,differing:[]}, contract:{ok:true,failed:[]}, external:{ran:false,ok:null}, notified:false }
——different:[] + contract.ok:true + notified:false 即「一切正常且未打扰主 agent」的证据。
`;

fs.appendFileSync(TRACE, `\n## [主agent] ${new Date().toISOString()}\n\n${body.trimEnd()}\n`, 'utf8');
console.log(`[trace] 已追加 ${Buffer.byteLength(body, 'utf8')} 字节 → 轨迹共 ${fs.statSync(TRACE).size} 字节`);

const delaySecs = 60;
const requestedAt = Date.now();
fs.writeFileSync(REQ, JSON.stringify({
  at: requestedAt + delaySecs * 1000,
  requestedAt,
  delaySecs,
  reason: '主 agent：用户确认重启以激活「重启后自检钩子」（提交 78d433b，已交付三副本）',
  by: 'pid:' + process.pid,
}, null, 2), 'utf8');
console.log(`[restart] 已写重启信号，计划 ${new Date(requestedAt + delaySecs * 1000).toLocaleTimeString()} 执行（watchdog 接管）`);
console.log('[restart] 重启后请核验 /health-check 的 selfCheck 字段（见轨迹第五节）。');
