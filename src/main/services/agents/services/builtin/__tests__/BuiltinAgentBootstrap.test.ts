import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockInstallBuiltinSkills,
  mockInitDefaultModauiClawAgent,
  mockInitBuiltinAgent,
  mockListSessions,
  mockCreateSession,
  mockEnsureHeartbeatTask
} = vi.hoisted(() => ({
  mockInstallBuiltinSkills: vi.fn(),
  mockInitDefaultModauiClawAgent: vi.fn(),
  mockInitBuiltinAgent: vi.fn(),
  mockListSessions: vi.fn(),
  mockCreateSession: vi.fn(),
  mockEnsureHeartbeatTask: vi.fn()
}))

vi.mock('@main/utils/builtinSkills', () => ({
  installBuiltinSkills: mockInstallBuiltinSkills
}))

vi.mock('../../AgentService', () => ({
  agentService: {
    initDefaultModauiClawAgent: mockInitDefaultModauiClawAgent,
    initBuiltinAgent: mockInitBuiltinAgent
  }
}))

vi.mock('../../SessionService', () => ({
  sessionService: {
    listSessions: mockListSessions,
    createSession: mockCreateSession
  }
}))

vi.mock('../../SchedulerService', () => ({
  schedulerService: {
    ensureHeartbeatTask: mockEnsureHeartbeatTask
  }
}))

vi.mock('../BuiltinAgentProvisioner', () => ({
  provisionBuiltinAgent: vi.fn()
}))

describe('bootstrapBuiltinAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.resetModules()
    mockInstallBuiltinSkills.mockResolvedValue(undefined)
    mockListSessions.mockResolvedValue({ total: 0 })
    mockCreateSession.mockResolvedValue({ id: 'session_1' })
    mockEnsureHeartbeatTask.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries built-in bootstrap when no model is available yet', async () => {
    mockInitDefaultModauiClawAgent
      .mockResolvedValueOnce({ agentId: null, skippedReason: 'no_model' })
      .mockResolvedValueOnce({ agentId: 'modaui-claw-default' })
    mockInitBuiltinAgent.mockResolvedValue({ agentId: null, skippedReason: 'deleted' })

    const { bootstrapBuiltinAgents } = await import('../BuiltinAgentBootstrap')

    await bootstrapBuiltinAgents()
    expect(mockInitDefaultModauiClawAgent).toHaveBeenCalledTimes(1)
    expect(mockCreateSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5000)

    expect(mockInitDefaultModauiClawAgent).toHaveBeenCalledTimes(2)
    expect(mockListSessions).toHaveBeenCalledWith('modaui-claw-default', { limit: 1 })
    expect(mockCreateSession).toHaveBeenCalledWith('modaui-claw-default', {})
    expect(mockEnsureHeartbeatTask).toHaveBeenCalledWith('modaui-claw-default', 30)
  })

  it('does not retry built-in agents deleted by the user', async () => {
    mockInitDefaultModauiClawAgent.mockResolvedValue({ agentId: null, skippedReason: 'deleted' })
    mockInitBuiltinAgent.mockResolvedValue({ agentId: null, skippedReason: 'deleted' })

    const { bootstrapBuiltinAgents } = await import('../BuiltinAgentBootstrap')

    await bootstrapBuiltinAgents()
    await vi.advanceTimersByTimeAsync(60000)

    expect(mockInitDefaultModauiClawAgent).toHaveBeenCalledTimes(1)
    expect(mockInitBuiltinAgent).toHaveBeenCalledTimes(1)
    expect(mockCreateSession).not.toHaveBeenCalled()
    expect(mockEnsureHeartbeatTask).not.toHaveBeenCalled()
  })
})
