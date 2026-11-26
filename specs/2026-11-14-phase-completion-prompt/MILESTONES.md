# 实施记录

- 确认插入块原先排除当前子任务的所有祖先，导致已完成子任务的阶段被后续任务掩盖；阶段仍须独立验收并显式完成。
- 改为按任务树后序推导当前和下一项，优先提示持久焦点之前已具备收尾条件的阶段；不改变持久化焦点或自动完成任务。轻量子任务保持原语义。
- 覆盖跨阶段收尾顺序、嵌套阶段、跳过子任务、轻量子任务，以及同一运行内完成显示阶段后刷新插入块。
- 验证：`npm test` 通过 1255 项；`npm run check`、`npm run lint` 和 `git diff --check` 通过。新增跳过子任务测试后另行运行相关测试。
- 用户反馈真实场景中完成当前阶段会清空持久焦点，导致只显示 Next pending，缺少当前阶段及验收条件；之前的测试错误地保留了后续任务的焦点。修复为无焦点时推导当前任务，同时保留明确的 start 提示，不修改持久状态。
- 增加真实工具调用的连续阶段回归：启动并完成阶段一后显示阶段二及验收条件、下一项 3.2；启动并完成阶段二后显示 3.2。完整测试 1256 项通过，类型检查和 lint 通过。
- UI 对齐：确认共享面板模型仍按持久焦点或前序首项选择当前任务，未采用注入块的阶段收尾规则。改为直接复用 `derivedTaskCursor`，使紧凑/展开面板及状态输出的 Current、当前验收条件和任务树高亮保持一致；详细状态树也使用模型中的当前任务。推导结果与持久焦点不同则标记 inferred，提示不再错误声称不存在持久焦点。
- 回归验证先复现 6 个 UI 与注入块不一致的失败；修复后相关 88 项通过。覆盖后续持久焦点之前的父阶段收尾、无焦点时先处理兄弟子任务再回到父任务、嵌套阶段由内向外收尾、轻量子任务及原地状态变更刷新，确认显示不修改持久状态。新增父任务收尾在各宽度下的布局及完整子任务进度验证。
- 完整测试：在临时干净源码副本中应用本次全部代码及测试改动，1259/1259 项通过。原工作目录的自定义 `keybindings.dashboard.toggleExpand` 为 `ctrl+alt+d`，导致 5 个使用默认快捷键的测试失败；修改前源码在相同工作目录复现相同 5 个失败，确认属于既有本地配置干扰，保留用户配置。
- 本次类型检查、lint 和 `git diff --check` 通过。
- 上游 0.35.2 的 `phaseToWrapUp`（`14d7f09`，PR #180，Fixes #176 #178）只用 `goal.currentTaskId ? undefined : …` 短路，覆盖“焦点为空”；合入 dev 时丢弃该实现，保留 `derivedTaskCursor`（焦点落在后续阶段时同样回卷到更早的待收尾阶段）。
- 修补由此暴露的第二个缺陷：光标已正确选中待收尾阶段，但 `nextStepBlock` 仍输出 `Mark it current with update_goal_task({task_id:"…", status:"start"})`，把「去收尾」说成「去开工」。新增 `cursorAction(task)` 复用 cursor 自身的 `actionableTask(task).id === task.id` 判据（子任务全部 complete/skipped 且自身 pending），仅在该分支改说 `Close the phase whose subtasks have all ended: …` / `Run update_goal_task({task_id:"…", status:"complete"}) once its own acceptance is met.`。
- 实现放在 `nextStepBlock` 消费端而非改动 `workUnits`/`taskCursor`：后者会改变 UI 判定，须整树重算 `baseline-main.json`，且 `workUnits` 既不排除已完成子任务也不排除 lightweight 子任务状态，前置判据反而更容易放宽。
- 先加测试后改代码：新增用例在未改实现时失败（`The input did not match /Close the phase whose subtasks have all ended: p1 · Phase one/`），改后 `tests/goal-phase-completion.test.ts` 9/9 通过。
- 验证：`tsc --noEmit -p .` 通过；`npm test` 1324 项、1323 通过、唯一失败为上游同样失败的 `experiment harness shell tests pass`；`npm run context:gate` PASS（24 fixtures）；`npm run context:cache-gate` PASS（408 scenarios / 1000 transitions）；`eslint` 两个改动文件无问题。
