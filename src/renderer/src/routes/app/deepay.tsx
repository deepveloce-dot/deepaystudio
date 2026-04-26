import DeepayPage from '@renderer/pages/deepay/DeepayPage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/deepay')({
  component: DeepayPage
})
