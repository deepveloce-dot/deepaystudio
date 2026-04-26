import type { IconComponent } from '@modauistudio/ui/icons'
import type { codeCLI } from '@shared/config/constant'

export interface CodeToolMeta {
  id: codeCLI
  label: string
  icon: IconComponent | null | undefined
}
