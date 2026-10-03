// assistant — the v2 vocabulary, the read surface, the agent loop, the reply and the prompt. Server only.
// V1 D5a part 3 (2026-10-03). Only what someone outside this folder uses is here; everything else in
// the folder is private, and check:boundaries fails an import that reaches past this file.
export { runAgent, MAX_STEPS, FALSE_CLAIM_NUDGE, type AgentTurn, type AgentRunResult, type ModelFn, type TranscriptEntry } from "./agentLoop";
export { runReadTool, isReadTool, READ_TOOL_NAMES, MAX_ROWS, type AgentContext } from "./agentTools";
export {
  applyPrimitives, memoryContext, allergensInFact, expandConstrain, applyRemember,
  AssistantTurnV2Schema, AgentTurnSchema, type AssistantTurnV2, type PrimitiveOp,
} from "./primitives";
export { assistantV2SystemPrompt } from "./promptV2";
export { composeReply, describeOperations, planWasChanged, claimsChange, NOTHING_CHANGED_REPLY, READ_ONLY_TOOLS } from "./reply";
