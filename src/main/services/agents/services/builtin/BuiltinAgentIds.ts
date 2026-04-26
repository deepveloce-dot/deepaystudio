export const CHERRY_CLAW_AGENT_ID = 'modaui-claw-default'
export const CHERRY_ASSISTANT_AGENT_ID = 'modaui-assistant-default'

const BUILTIN_AGENT_IDS = new Set([CHERRY_CLAW_AGENT_ID, CHERRY_ASSISTANT_AGENT_ID])

export function isBuiltinAgentId(id: string): boolean {
  return BUILTIN_AGENT_IDS.has(id)
}
