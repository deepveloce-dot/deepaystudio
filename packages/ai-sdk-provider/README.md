# @modauistudio/ai-sdk-provider

ModauiIN provider bundle for the [Vercel AI SDK](https://ai-sdk.dev/).  
It exposes the ModauiIN OpenAI-compatible entrypoints and dynamically routes Anthropic and Gemini model ids to their ModauiIN upstream equivalents.

## Installation

```bash
npm install ai @modauistudio/ai-sdk-provider @ai-sdk/anthropic @ai-sdk/google @ai-sdk/openai
# or
pnpm add ai @modauistudio/ai-sdk-provider @ai-sdk/anthropic @ai-sdk/google @ai-sdk/openai
```

> **Note**: This package requires peer dependencies `ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, and `@ai-sdk/openai` to be installed.

## Usage

```ts
import { createCherryIn, cherryIn } from '@modauistudio/ai-sdk-provider'

const cherryInProvider = createCherryIn({
  apiKey: process.env.CHERRYIN_API_KEY,
  // optional overrides:
  // baseURL: 'https://open.modauiin.net/v1',
  // anthropicBaseURL: 'https://open.modauiin.net/anthropic',
  // geminiBaseURL: 'https://open.modauiin.net/gemini/v1beta',
})

// Chat models will auto-route based on the model id prefix:
const openaiModel = cherryInProvider.chat('gpt-4o-mini')
const anthropicModel = cherryInProvider.chat('claude-3-5-sonnet-latest')
const geminiModel = cherryInProvider.chat('gemini-2.0-pro-exp')

const { text } = await openaiModel.invoke('Hello ModauiIN!')
```

The provider also exposes `completion`, `responses`, `embedding`, `image`, `transcription`, and `speech` helpers aligned with the upstream APIs.

See [AI SDK docs](https://ai-sdk.dev/providers/community-providers/custom-providers) for configuring custom providers.
