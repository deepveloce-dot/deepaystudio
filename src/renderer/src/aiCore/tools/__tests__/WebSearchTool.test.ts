import { webSearchService } from '@renderer/services/WebSearchService'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { webSearchToolWithPreExtractedKeywords } from '../WebSearchTool'

const getWebSearchProviderAsyncMock = vi.fn()
const processWebsearchMock = vi.fn()
const loggerWarnMock = vi.fn()

vi.mock('@renderer/services/WebSearchService', () => ({
  webSearchService: {
    getWebSearchProviderAsync: getWebSearchProviderAsyncMock,
    processWebsearch: processWebsearchMock
  }
}))

vi.mock('@logger', () => ({
  loggerService: {
    withContext: vi.fn(() => ({
      warn: loggerWarnMock
    }))
  }
}))

describe('webSearchToolWithPreExtractedKeywords', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWebSearchProviderAsyncMock.mockResolvedValue({ id: 'tavily' } as any)
    processWebsearchMock.mockResolvedValue({
      query: 'first | second',
      results: [
        {
          title: 'Result',
          content: 'Content',
          url: 'https://example.com/path?utm_source=newsletter#details'
        }
      ]
    })
  })

  it('returns an empty result when the configured provider is unavailable', async () => {
    getWebSearchProviderAsyncMock.mockResolvedValue(undefined)

    const searchTool = webSearchToolWithPreExtractedKeywords(
      'tavily',
      { question: ['latest cherry studio'] },
      'request-1'
    ) as any

    await expect(searchTool.execute({ additionalContext: undefined })).resolves.toEqual({
      query: '',
      results: []
    })

    expect(processWebsearchMock).not.toHaveBeenCalled()
    expect(loggerWarnMock).toHaveBeenCalledWith('Skip web search because provider is unavailable', {
      webSearchProviderId: 'tavily',
      requestId: 'request-1'
    })
  })

  it('deduplicates queries, limits them, keeps full URLs in output, and shortens model URLs', async () => {
    const searchTool = webSearchToolWithPreExtractedKeywords(
      'tavily',
      {
        question: [' first ', 'FIRST', 'second', 'third', 'fourth']
      },
      'request-1'
    ) as any

    const firstResult = await searchTool.execute({})
    const secondResult = await searchTool.execute({ additionalContext: 'new context' })

    expect(webSearchService.processWebsearch).toHaveBeenCalledTimes(1)
    expect(webSearchService.processWebsearch).toHaveBeenCalledWith(
      { id: 'tavily' },
      {
        websearch: {
          question: ['first', 'second', 'third'],
          links: undefined
        }
      },
      'request-1'
    )
    expect(firstResult.results[0].url).toBe('https://example.com/path?utm_source=newsletter#details')
    expect(secondResult).toBe(firstResult)

    const modelOutput = searchTool.toModelOutput({ output: firstResult })
    const modelText = modelOutput.value.map((part: { text: string }) => part.text).join('\n')

    expect(modelText).toContain('"url": "https://example.com"')
    expect(modelText).not.toContain('utm_source')
  })

  it('reuses the in-flight search request for concurrent executions', async () => {
    const searchResponse = {
      query: 'first',
      results: [
        {
          title: 'Result',
          content: 'Content',
          url: 'https://example.com/path?utm_source=newsletter#details'
        }
      ]
    }
    processWebsearchMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(searchResponse), 0))
    )

    const searchTool = webSearchToolWithPreExtractedKeywords(
      'tavily',
      {
        question: ['first']
      },
      'request-1'
    ) as any

    const [firstResult, secondResult] = await Promise.all([
      searchTool.execute({ additionalContext: 'first context' }),
      searchTool.execute({ additionalContext: 'second context' })
    ])

    expect(webSearchService.processWebsearch).toHaveBeenCalledTimes(1)
    expect(webSearchService.processWebsearch).toHaveBeenCalledWith(
      { id: 'tavily' },
      {
        websearch: {
          question: ['first context'],
          links: undefined
        }
      },
      'request-1'
    )
    expect(firstResult).toBe(searchResponse)
    expect(secondResult).toBe(searchResponse)
  })
})
