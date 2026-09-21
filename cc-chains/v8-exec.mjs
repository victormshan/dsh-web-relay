// v8-exec 链条（由 gen-exec-specs.mjs 生成）：8 轮 × 2 臂 = 16 项，交错排列。
// 判定由隐藏探针**执行**给出（probes/run-probe.mjs），无模型裁判。
export const chain = {
  id: 'v8-exec',
  items: [
    { label: 'P 第 1 轮（散文反证）', spec: 'cc-specs/exec-p01.mjs', taskId: 'ccexec-20260917-p01' },
    { label: 'E 第 1 轮（可执行反例）', spec: 'cc-specs/exec-e01.mjs', taskId: 'ccexec-20260917-e01' },
    { label: 'P 第 2 轮（散文反证）', spec: 'cc-specs/exec-p02.mjs', taskId: 'ccexec-20260917-p02' },
    { label: 'E 第 2 轮（可执行反例）', spec: 'cc-specs/exec-e02.mjs', taskId: 'ccexec-20260917-e02' },
    { label: 'P 第 3 轮（散文反证）', spec: 'cc-specs/exec-p03.mjs', taskId: 'ccexec-20260917-p03' },
    { label: 'E 第 3 轮（可执行反例）', spec: 'cc-specs/exec-e03.mjs', taskId: 'ccexec-20260917-e03' },
    { label: 'P 第 4 轮（散文反证）', spec: 'cc-specs/exec-p04.mjs', taskId: 'ccexec-20260917-p04' },
    { label: 'E 第 4 轮（可执行反例）', spec: 'cc-specs/exec-e04.mjs', taskId: 'ccexec-20260917-e04' },
    { label: 'P 第 5 轮（散文反证）', spec: 'cc-specs/exec-p05.mjs', taskId: 'ccexec-20260917-p05' },
    { label: 'E 第 5 轮（可执行反例）', spec: 'cc-specs/exec-e05.mjs', taskId: 'ccexec-20260917-e05' },
    { label: 'P 第 6 轮（散文反证）', spec: 'cc-specs/exec-p06.mjs', taskId: 'ccexec-20260917-p06' },
    { label: 'E 第 6 轮（可执行反例）', spec: 'cc-specs/exec-e06.mjs', taskId: 'ccexec-20260917-e06' },
    { label: 'P 第 7 轮（散文反证）', spec: 'cc-specs/exec-p07.mjs', taskId: 'ccexec-20260917-p07' },
    { label: 'E 第 7 轮（可执行反例）', spec: 'cc-specs/exec-e07.mjs', taskId: 'ccexec-20260917-e07' },
    { label: 'P 第 8 轮（散文反证）', spec: 'cc-specs/exec-p08.mjs', taskId: 'ccexec-20260917-p08' },
    { label: 'E 第 8 轮（可执行反例）', spec: 'cc-specs/exec-e08.mjs', taskId: 'ccexec-20260917-e08' },
  ],
};
