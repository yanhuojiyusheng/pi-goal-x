import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, type GoalTaskList } from "../extensions/goal-record.ts";
import { goalPromptParts, taskListBlock } from "../extensions/prompts/goal-prompts.ts";

/**
 * Spec 2026-11-14-phase-completion-prompt: a phase whose subtasks have all
 * ended but which is itself still pending must be promoted to the displayed
 * current task, in tree order, even when the persisted focus already moved to
 * a later phase.
 */

function phaseGoal(): ReturnType<typeof createGoal> {
 const goal = createGoal({objective: "Ship the three phases", autoContinue: true, sisyphus: false});
 goal.id = "phase-goal";
 goal.taskList = {blockCompletion: false, proposedAt: "2026-11-14T00:00:00.000Z", tasks: [
  {id: "p1", title: "Phase one", status: "pending", verificationContract: "Phase one acceptance", subtasks: [
   {id: "1.1", title: "Step one one", status: "complete", completedAt: "2026-11-13T00:00:00.000Z"},
  ]},
  {id: "p2", title: "Phase two", status: "pending", verificationContract: "Phase two acceptance", subtasks: [
   {id: "2.1", title: "Step two one", status: "complete", completedAt: "2026-11-13T00:00:00.000Z"},
  ]},
  {id: "p3", title: "Phase three", status: "pending", verificationContract: "Phase three acceptance", subtasks: [
   {id: "3.1", title: "Step three one", status: "complete", completedAt: "2026-11-13T00:00:00.000Z"},
   {id: "3.2", title: "Step three two", status: "pending", verificationContract: "Step three two acceptance"},
  ]},
 ]} as GoalTaskList;
 goal.currentTaskId = "3.2";
 return goal;
}

test("an earlier wrap-up phase becomes current ahead of a later persisted focus", () => {
 const goal = phaseGoal();
 const state = goalPromptParts(goal).state;
 assert.match(state.split("\n")[0]!, / taskId=p1\]/, "the ACTIVE header names the phase awaiting wrap-up");
 assert.match(state, /\[TASKS — 3\/7 complete\]/);
 assert.match(state, /Current: p1 · Phase one\nDone when: Phase one acceptance/, "Done when carries the phase's own acceptance");
 assert.doesNotMatch(state, /Current: 3\.2/, "the later persisted focus is not displayed as current");
 assert.doesNotMatch(state, /^Parent /m, "a first-level task has no parent contract");
 assert.match(state, /Next pending: p2 · Phase two/, "the next wrap-up phase follows in tree order");
});

test("completing the first wrap-up phase promotes the next one and then the pending step", () => {
 const goal = phaseGoal();
 goal.taskList!.tasks[0]!.status = "complete";
 const afterFirst = goalPromptParts(goal).state;
 assert.match(afterFirst.split("\n")[0]!, / taskId=p2\]/);
 assert.match(afterFirst, /Current: p2 · Phase two\nDone when: Phase two acceptance/);
 assert.match(afterFirst, /Next pending: 3\.2 · Step three two/, "the next item is the pending step, not the completed 3.1 or the open phase");
 assert.doesNotMatch(afterFirst, /Next pending: 3\.1/);

 goal.taskList!.tasks[1]!.status = "complete";
 const afterSecond = goalPromptParts(goal).state;
 assert.match(afterSecond.split("\n")[0]!, / taskId=3\.2\]/);
 assert.match(afterSecond, /Current: 3\.2 · Step three two\nDone when: Step three two acceptance/);
 assert.match(afterSecond, /Parent p3 contract: Phase three acceptance/, "the open ancestor still contributes its contract");
});

test("skipped children allow their phase to be offered for wrap-up", () => {
 const goal = phaseGoal();
 goal.taskList!.tasks[0]!.subtasks![0]!.status = "skipped";
 const state = goalPromptParts(goal).state;
 assert.match(state, /taskId=p1\]/);
 assert.match(state, /Current: p1 · Phase one/);
 assert.match(state, /Next pending: p2 · Phase two/);
});

test("nested phases wrap up from the inside out", () => {
 const goal = createGoal({objective: "Nested phases", autoContinue: true, sisyphus: false});
 goal.id = "nested-phase-goal";
 goal.taskList = {blockCompletion: false, proposedAt: "2026-11-14T00:00:00.000Z", tasks: [
  {id: "outer", title: "Outer phase", status: "pending", verificationContract: "Outer acceptance", subtasks: [
   {id: "inner", title: "Inner phase", status: "pending", verificationContract: "Inner acceptance", subtasks: [
    {id: "leaf", title: "Inner step", status: "complete", completedAt: "2026-11-13T00:00:00.000Z"},
   ]},
  ]},
  {id: "later", title: "Later step", status: "pending"},
 ]} as GoalTaskList;
 goal.currentTaskId = "later";

 const inner = goalPromptParts(goal).state;
 assert.match(inner, /Current: inner · Inner phase\nDone when: Inner acceptance/);
 assert.match(inner, /Parent outer contract: Outer acceptance/);
 assert.match(inner, /Next pending: outer · Outer phase/);

 goal.taskList!.tasks[0]!.subtasks![0]!.status = "complete";
 const outer = goalPromptParts(goal).state;
 assert.match(outer, /Current: outer · Outer phase/);
 assert.doesNotMatch(outer, /^Parent /m, "the outermost phase is first level");
 assert.match(outer, /Next pending: later · Later step/);
});

test("the last pending child points to its parent before moving to the next phase", () => {
 const goal = phaseGoal();
 goal.taskList!.tasks[0]!.subtasks![0]!.status = "pending";
 goal.currentTaskId = "1.1";
 const state = goalPromptParts(goal).state;
 assert.match(state, /Current: 1\.1 · Step one one/);
 assert.match(state, /Next pending: p1 · Phase one/);
});

test("lightweight subtasks stay notes on their parent and never trigger wrap-up", () => {
 const goal = createGoal({objective: "Lightweight notes", autoContinue: true, sisyphus: false});
 goal.id = "lightweight-phase-goal";
 goal.taskList = {blockCompletion: false, proposedAt: "2026-11-14T00:00:00.000Z", tasks: [
  {id: "p1", title: "Phase one", status: "pending", lightweightSubtasks: true, subtasks: [
   {id: "1.1", title: "Note one", status: "complete", completedAt: "2026-11-13T00:00:00.000Z"},
  ]},
  {id: "next", title: "Next step", status: "pending"},
 ]} as GoalTaskList;
 goal.currentTaskId = "next";
 const state = goalPromptParts(goal).state;
 assert.match(state, /Current: next · Next step/, "the persisted focus stays current");
 assert.match(state, /Next pending: p1 · Phase one \(lightweight\)/);
});

test("the derived order preserves ordinary sequential work and refreshes the cached fragment", () => {
 const goal = createGoal({objective: "Ordinary order", autoContinue: true, sisyphus: false});
 goal.id = "ordered-goal";
 goal.taskList = {blockCompletion: false, proposedAt: "2026-11-14T00:00:00.000Z", tasks: [
  {id: "t1", title: "First", status: "pending"},
  {id: "t2", title: "Second", status: "pending"},
  {id: "t3", title: "Third", status: "pending"},
 ]} as GoalTaskList;
 goal.currentTaskId = "t1";
 const first = goalPromptParts(goal).state;
 assert.match(first, /Current: t1 · First\nNext pending: t2 · Second/);
 assert.equal(goalPromptParts(goal).state, first, "an unchanged task tree reuses the cached fragment");
 assert.equal(taskListBlock(goal), taskListBlock(goal));

 goal.taskList!.tasks[0]!.status = "complete";
 const advanced = goalPromptParts(goal).state;
 assert.doesNotMatch(advanced.split("\n")[0]!, /taskId=/);
 goal.currentTaskId = "t2";
 assert.match(goalPromptParts(goal).state, /Current: t2 · Second\nNext pending: t3 · Third/);
});
