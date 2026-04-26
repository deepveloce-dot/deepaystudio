import StorePage from '@renderer/pages/store/StorePage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/deepay')({
  component: StorePage
})
