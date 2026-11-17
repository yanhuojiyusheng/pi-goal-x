# UI 任务顺序对齐

复用 `extensions/prompts/goal-prompts.ts` 已导出的 `derivedTaskCursor(goal, settings)`，不复制任务遍历或重构注入块。`extensions/widgets/goal-dashboard-model.ts` 的 `deriveCurrentTask` 用推导出的当前 id 查找已有树节点，继续从节点获取深度、契约和子任务进度；与持久焦点不同则标记 inferred。禁用任务仍由现有展示入口处理。

`extensions/widgets/goal-dashboard-renderer.ts` 的推导提示改为按任务顺序推导，避免错误声称没有持久焦点。`extensions/goal-status.ts` 详细模式用 model.currentTask 的 id 高亮任务树。

实施与验证：

1. 在现有阶段收尾测试中同时断言 UI、注入块的任务 id、契约、唯一高亮一致，持久状态不变；增加无焦点、嵌套收尾、兄弟任务和状态输出场景，先确认失败。
2. 修改共享模型及两个展示入口，更新依赖旧规则的测试期望。
3. 运行相关测试、完整单元测试、类型检查、lint 和 diff 检查；在 MILESTONES.md 记录结果。
