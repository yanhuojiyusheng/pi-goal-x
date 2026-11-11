import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, type GoalTaskList } from "../extensions/goal-record.ts";
import { goalPromptBlock, goalPromptParts } from "../extensions/prompts/goal-prompts.ts";

function fixture() {
 const goal = createGoal({objective: "Ship the importer", autoContinue: true, sisyphus: false});
 goal.id = "compact-example";
 goal.usage = {tokensUsed: 2502207, activeSeconds: 2049};
 goal.currentTaskId = "phase";
 goal.taskList = {blockCompletion: true, tasks: [
  {id: "done", title: "Done", status: "complete"},
  {id: "phase", title: "Import phase", status: "pending", verificationContract: "Typecheck passes", subtasks: [
   {id: "current", title: "Fix identity reuse", status: "pending", verificationContract: "Changed identity imports again"},
   {id: "next", title: "Back up upgrades", status: "pending", verificationContract: "Backup exists before migration"},
  ]},
  {id: "later", title: "Lint", status: "pending"},
 ]} as GoalTaskList;
 return goal;
}

test("regular active block merges fresh telemetry and actionable focus into one first header", () => {
 const goal = fixture();
 const text = goalPromptBlock(goal);
 assert.equal(text.split("\n")[0], "[PI GOAL ACTIVE goalId=compact-example taskId=current 34m9s · 2502207 tokens]");
 assert.equal((text.match(/\[PI GOAL ACTIVE/g) ?? []).length, 1);
 assert.doesNotMatch(text, /PI GOAL NOW|Status: running|Mode: regular|Limits:|OUTCOMES|SISYPHUS|Missing decisions/);
 assert.match(text, /\[RULES\]/);
 assert.match(text, /Usage is cumulative across goal turns, not context occupancy/);
 assert.match(text, /Continue automatically; no scheduling declaration is required/);
 assert.match(text, /same blocker recurs on 3 consecutive goal turns/);
 assert.match(text, /<untrusted_objective>\nShip the importer\n<\/untrusted_objective>/);
 goal.usage = {tokensUsed: 2502307, activeSeconds: 2050};
 assert.match(goalPromptParts(goal).state.split("\n")[0]!, /34m10s · 2502307 tokens/);
 assert.doesNotMatch(goalPromptParts(goal).pointer, /PI GOAL/);
});

test("current details agree with the header and retain ancestor contracts and next-task retrieval", () => {
 const text = goalPromptBlock(fixture());
 assert.match(text, /\[TASKS — 1\/5 complete\]/);
 assert.match(text, /Current: current · Fix identity reuse\nDone when: Changed identity imports again/);
 assert.match(text, /Parent phase contract: Typecheck passes/);
 assert.match(text, /Next pending: next · Back up upgrades/);
 assert.doesNotMatch(text, /Backup exists before migration|^\[ \]/m);
 assert.match(text, /2 other pending task entries omitted/);
 assert.match(text, /Before starting a task whose details or contract are omitted, retrieve them with get_goal\(section="tasks"\)/);
 assert.match(text, /TASK GATE/);
});

test("limits and mode guidance update without leaking into ordinary prompts", () => {
 const goal = fixture();
 const ordinary = goalPromptBlock(goal);
 assert.match(goalPromptBlock(goal, {strictExecutionContract: true}), /Missing decisions allow one repair/);
 assert.match(goalPromptBlock({...goal, sisyphus: true}), /SISYPHUS STYLE/);
 assert.match(goalPromptBlock({...goal, tokenBudget: 3000000}), /Limits: lifetime tokens=3000000\./);
 assert.match(goalPromptBlock(goal, {maxAutonomousRuns: 4}), /Limits: runs=4\./);
 assert.match(goalPromptBlock(goal, {maxAutonomousRuns: 0}), /automatic continuation disabled/);
 assert.doesNotMatch(goalPromptBlock({...goal, autoContinue: false}), /Continue automatically|no scheduling declaration/);
 assert.equal(goalPromptBlock(goal), ordinary);
});

test("nested leaf focus preserves every ancestor contract; lightweight notes are not next tasks", () => {
 const goal = fixture();
 goal.taskList!.tasks[1]!.subtasks![0]!.subtasks = [{id: "leaf", title: "Handle replacement", status: "pending", verificationContract: "Replacement imports"}];
 goal.currentTaskId = "leaf";
 const nested = goalPromptBlock(goal);
 assert.match(nested, /Parent phase contract: Typecheck passes/);
 assert.match(nested, /Parent current contract: Changed identity imports again/);
 assert.match(nested, /taskId=leaf /);
 const parent = goal.taskList!.tasks[1]!;
 parent.lightweightSubtasks = true;
 goal.currentTaskId = parent.id;
 const lightweight = goalPromptBlock(goal);
 assert.match(lightweight, /taskId=phase /);
 assert.match(lightweight, /Next pending: later · Lint/);
});
