import type { GatewayLanguageModelEntry } from '@ai-sdk/gateway'
import type { Provider } from '@renderer/types'
import { SystemProviderIds } from '@renderer/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetAvailableModels = vi.fn()
const mockCreateGateway = vi.fn()

vi.mock('ai', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    createGateway: (opts: any) => {
      mockCreateGateway(opts)
      return { getAvailableModels: mockGetAvailableModels }
    }
  }
})

vi.mock('@renderer/aiCore/legacy/index', () => ({
  default: vi.fn().mockImplementation(() => ({
    models: vi.fn().mockResolvedValue([])
  }))
}))

vi.mock('@renderer/aiCore/provider/providerConfig', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return {
    ...actual,
    adaptProvider: ({ provider }: { provider: Provider }) => provider,
    providerToAiSdkConfig: vi.fn()
  }
})

vi.mock('@renderer/utils/provider', async (importOriginal) => {
  const actual = (await importOriginal()) as any
  return { ...actual }
})

const makeGatewayProvider = (apiKey: string): Provider =>
  ({
    id: SystemProviderIds.gateway,
    name: 'Vercel AI Gateway',
    type: 'gateway',
    apiKey,
    apiHost: 'https://ai-gateway.vercel.sh/v1/ai',
    models: [],
    isSystem: true,
    enabled: true
  }) as unknown as Provider

describe('ModernAiProvider.models() — gateway provider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('passes the configured apiKey to createGateway', async () => {
    const { default: ModernAiProvider } = await import('@renderer/aiCore/index_new')

    mockGetAvailableModels.mockResolvedValue({ models: [] })

    const provider = makeGatewayProvider('my-real-api-key')
    const ai = new ModernAiProvider(provider)
    await ai.models()

    expect(mockCreateGateway).toHaveBeenCalledWith({ apiKey: 'my-real-api-key' })
  })

  it('returns normalized models on success', async () => {
    const { default: ModernAiProvider } = await import('@renderer/aiCore/index_new')

    const fakeEntries: GatewayLanguageModelEntry[] = [
      { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI GPT-4o' } as GatewayLanguageModelEntry,
      { id: 'anthropic/claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' } as GatewayLanguageModelEntry
    ]
    mockGetAvailableModels.mockResolvedValue({ models: fakeEntries })

    const provider = makeGatewayProvider('valid-key')
    const ai = new ModernAiProvider(provider)
    const models = await ai.models()

    expect(models).toHaveLength(2)
    expect(models[0].id).toBe('openai/gpt-4o')
    expect(models[0].provider).toBe(SystemProviderIds.gateway)
    expect(models[1].id).toBe('anthropic/claude-3-5-sonnet')
  })

  it('propagates error when getAvailableModels fails', async () => {
    const { default: ModernAiProvider } = await import('@renderer/aiCore/index_new')

    mockGetAvailableModels.mockRejectedValue(new Error('401 Invalid Token'))

    const provider = makeGatewayProvider('bad-key')
    const ai = new ModernAiProvider(provider)

    await expect(ai.models()).rejects.toThrow('401 Invalid Token')
  })

  it('does not fall back to legacy provider for gateway', async () => {
    const LegacyAiProvider = (await import('@renderer/aiCore/legacy/index')).default
    const { default: ModernAiProvider } = await import('@renderer/aiCore/index_new')

    mockGetAvailableModels.mockResolvedValue({ models: [] })

    const provider = makeGatewayProvider('any-key')
    const ai = new ModernAiProvider(provider)
    await ai.models()

    const legacyInstance = vi.mocked(LegacyAiProvider).mock.results[0].value
    expect(legacyInstance.models).not.toHaveBeenCalled()
  })
})
