import FashionPage from '@renderer/pages/fashion/FashionPage'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/app/fashion')({
  component: FashionPage
})
