import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MigrationContext } from '../../core/MigrationContext'
import { ProviderModelMigrator } from '../ProviderModelMigrator'

const { loggerWarnMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn()
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn(() => ({
      info: vi.fn(),
      warn: loggerWarnMock,
      error: vi.fn(),
      debug: vi.fn()
    }))
  }
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory()
})

function createMockContext(
  reduxState: Record<string, unknown> = {},
  dexieTables: Record<string, unknown[]> = {}
): MigrationContext {
  const insertValues: unknown[][] = []

  const mockTx = {
    insert: vi.fn(() => ({
      values: vi.fn((vals: unknown) => {
        insertValues.push(Array.isArray(vals) ? vals : [vals])
        return Promise.resolve()
      })
    }))
  }

  return {
    sources: {
      reduxState: {
        getCategory: vi.fn((cat: string) => reduxState[cat])
      },
      dexieExport: {
        tableExists: vi.fn((table: string) =>
          Promise.resolve(Object.prototype.hasOwnProperty.call(dexieTables, table))
        ),
        createStreamReader: vi.fn((table: string) => ({
          readInBatches: vi.fn(
            async (_batchSize: number, callback: (items: unknown[], index: number) => Promise<void>) => {
              await callback(dexieTables[table] ?? [], 0)
            }
          )
        }))
      }
    },
    db: {
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          get: vi.fn(() => Promise.resolve({ count: 0 }))
        }))
      }))
    },
    _insertValues: insertValues
  } as unknown as MigrationContext & { _insertValues: unknown[][] }
}

function makeProvider(id: string, models: Array<{ id: string }> = []) {
  return {
    id,
    name: `Provider ${id}`,
    type: 'openai',
    enabled: true,
    models
  }
}

describe('ProviderModelMigrator', () => {
  let migrator: ProviderModelMigrator

  beforeEach(() => {
    migrator = new ProviderModelMigrator()
    loggerWarnMock.mockClear()
  })

  describe('prepare', () => {
    it('returns success with provider count', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('openai'), makeProvider('anthropic')]
        }
      })

      const result = await migrator.prepare(ctx)

      expect(result.success).toBe(true)
      expect(result.itemCount).toBe(2)
    })

    it('handles missing providers gracefully', async () => {
      const ctx = createMockContext({ llm: {} })

      const result = await migrator.prepare(ctx)

      expect(result.success).toBe(true)
      expect(result.itemCount).toBe(0)
    })

    it('deduplicates providers by ID', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('openai'), makeProvider('openai'), makeProvider('anthropic')]
        }
      })

      const result = await migrator.prepare(ctx)

      expect(result.success).toBe(true)
      expect(result.itemCount).toBe(2) // deduplicated
      expect(result.warnings).toBeDefined()
      expect(result.warnings?.some((w) => w.includes('duplicate'))).toBe(true)
    })
  })

  describe('execute', () => {
    it('returns success with zero count when no providers', async () => {
      const ctx = createMockContext({ llm: {} })
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      expect(result.processedCount).toBe(0)
    })

    it('inserts provider row and model rows', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('openai', [{ id: 'gpt-4o' }, { id: 'gpt-4' }])]
        }
      })
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      expect(result.processedCount).toBe(1)

      // First insert: 1 provider, second insert: 2 models (batch)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      expect(inserted).toHaveLength(2)
      expect(inserted[0]).toHaveLength(1) // 1 provider row
      expect(inserted[1]).toHaveLength(2) // 2 model rows
      expect((inserted[0][0] as Record<string, unknown>).providerId).toBe('openai')
    })

    it('deduplicates models within a provider', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('openai', [{ id: 'gpt-4o' }, { id: 'gpt-4o' }])]
        }
      })
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)

      // Should insert only 1 unique model, not 2
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] // second insert is the model batch
      expect(modelInsert).toHaveLength(1)
    })

    it('adds llm default-model references that are missing from provider.models', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('openai', [{ id: 'gpt-4o' }])],
          defaultModel: {
            id: 'gpt-5.1',
            provider: 'openai',
            name: 'GPT 5.1',
            group: 'OpenAI'
          }
        }
      })
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toContain('openai::gpt-5.1')
    })

    it('adds assistant-referenced models that are missing from provider.models', async () => {
      const providerId = 'a17b6846-e129-4508-b81a-b6e11a5efb85'
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider(providerId, [{ id: 'gpt-4o' }])]
        },
        assistants: {
          assistants: [
            {
              id: 'assistant-1',
              name: 'Assistant',
              model: {
                id: '[L]gemini-2.5-pro',
                provider: providerId,
                name: 'Gemini 2.5 Pro',
                group: 'Gemini'
              }
            }
          ],
          presets: []
        }
      })
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toContain(`${providerId}::[L]gemini-2.5-pro`)
    })

    it('does not collect defaultAssistant models because defaultAssistant is not migrated', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
        },
        assistants: {
          assistants: [],
          presets: [],
          defaultAssistant: {
            id: 'default-assistant',
            name: 'Default Assistant',
            model: {
              id: 'gpt-5.1',
              provider: 'openai',
              name: 'GPT 5.1',
              group: 'OpenAI'
            }
          }
        }
      })
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toEqual(['openai::gpt-4o'])
    })

    it('adds chat message model references that are missing from provider.models', async () => {
      const ctx = createMockContext(
        {
          llm: {
            providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
          }
        },
        {
          topics: [
            {
              id: 'topic-1',
              messages: [
                {
                  id: 'message-1',
                  role: 'assistant',
                  model: { id: 'gpt-5.1', provider: 'openai', name: 'GPT 5.1', group: 'OpenAI' }
                }
              ]
            }
          ]
        }
      )
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toContain('openai::gpt-5.1')
    })

    it('adds chat message fallback modelId references that are already composite', async () => {
      const ctx = createMockContext(
        {
          llm: {
            providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
          }
        },
        {
          topics: [
            {
              id: 'topic-1',
              messages: [
                {
                  id: 'message-1',
                  role: 'assistant',
                  modelId: 'openai::gpt-5.1'
                }
              ]
            }
          ]
        }
      )
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toContain('openai::gpt-5.1')
    })

    it('skips bare chat message modelId values that have no provider info', async () => {
      const ctx = createMockContext(
        {
          llm: {
            providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
          }
        },
        {
          topics: [
            {
              id: 'topic-1',
              messages: [
                {
                  id: 'message-1',
                  role: 'assistant',
                  modelId: 'gpt-5.1'
                }
              ]
            }
          ]
        }
      )
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toEqual(['openai::gpt-4o'])
    })

    it('aggregates skipped bare chat message modelId warnings', async () => {
      const ctx = createMockContext(
        {
          llm: {
            providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
          }
        },
        {
          topics: [
            {
              id: 'topic-1',
              messages: [
                { id: 'message-1', role: 'assistant', modelId: 'gpt-5.1' },
                { id: 'message-2', role: 'assistant', modelId: 'claude-3.7-sonnet' }
              ]
            }
          ]
        }
      )

      const prepareResult = await migrator.prepare(ctx)

      expect(prepareResult.success).toBe(true)
      expect(loggerWarnMock).toHaveBeenCalledWith('Skipped legacy bare modelId references during migration', {
        count: 2,
        samples: ['message-1:gpt-5.1', 'message-2:claude-3.7-sonnet']
      })
    })

    it('still registers mentions when a message has only a bare modelId', async () => {
      const ctx = createMockContext(
        {
          llm: {
            providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
          }
        },
        {
          topics: [
            {
              id: 'topic-1',
              messages: [
                {
                  id: 'message-1',
                  role: 'assistant',
                  modelId: 'gpt-5.1',
                  mentions: [{ id: 'gpt-5.1', provider: 'openai', name: 'GPT 5.1', group: 'OpenAI' }]
                }
              ]
            }
          ]
        }
      )
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toEqual(['openai::gpt-4o', 'openai::gpt-5.1'])
      expect(loggerWarnMock).toHaveBeenCalledWith('Skipped legacy bare modelId references during migration', {
        count: 1,
        samples: ['message-1:gpt-5.1']
      })
    })

    it('registers composite modelId fallback when message.model is incomplete', async () => {
      const ctx = createMockContext(
        {
          llm: {
            providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
          }
        },
        {
          topics: [
            {
              id: 'topic-1',
              messages: [
                {
                  id: 'message-1',
                  role: 'assistant',
                  model: { id: 'gpt-5.1' },
                  modelId: 'openai::gpt-5.1'
                }
              ]
            }
          ]
        }
      )
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toContain('openai::gpt-5.1')
    })

    it('tolerates null topics and topics with non-array messages field', async () => {
      const ctx = createMockContext(
        {
          llm: {
            providers: [makeProvider('openai', [{ id: 'gpt-4o' }])]
          }
        },
        {
          topics: [null, { id: 'topic-broken', messages: 'corrupted' }, { id: 'topic-ok', messages: undefined }]
        }
      )

      const prepareResult = await migrator.prepare(ctx)

      expect(prepareResult.success).toBe(true)
      const result = await migrator.execute(ctx)
      expect(result.success).toBe(true)
    })

    it('adds knowledge base model references that are missing from provider.models', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('silicon', [{ id: 'qwen' }])]
        },
        knowledge: {
          bases: [
            {
              id: 'knowledge-1',
              name: 'Knowledge',
              model: {
                id: 'BAAI/bge-m3',
                provider: 'silicon',
                name: 'BGE M3',
                group: 'Embedding'
              },
              rerankModel: {
                id: 'BAAI/bge-reranker',
                provider: 'silicon',
                name: 'BGE Reranker',
                group: 'Rerank'
              }
            }
          ]
        }
      })
      await migrator.prepare(ctx)

      const result = await migrator.execute(ctx)

      expect(result.success).toBe(true)
      const inserted = (ctx as unknown as { _insertValues: unknown[][] })._insertValues
      const modelInsert = inserted[1] as Array<Record<string, unknown>>
      expect(modelInsert.map((row) => row.id)).toEqual(
        expect.arrayContaining(['silicon::BAAI/bge-m3', 'silicon::BAAI/bge-reranker'])
      )
    })
  })

  describe('reset', () => {
    it('clears internal state', async () => {
      const ctx = createMockContext({
        llm: {
          providers: [makeProvider('openai')]
        }
      })
      await migrator.prepare(ctx)

      migrator.reset()

      const result = await migrator.execute(ctx)
      expect(result.processedCount).toBe(0)
    })
  })
})
