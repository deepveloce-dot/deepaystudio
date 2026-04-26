/**
 * FashionPage.tsx — AI 服装设计
 *
 * 功能闭环（对齐 deepay.srl yudao-ui-deepay Generate.vue + AiDesign.vue）：
 *   ① 选品类 / 风格 / 市场
 *   ② 点击生成 → 调用 deepay 后台 POST /api/design/generate → 轮询结果
 *   ③ 展示 AI 生成的设计图（模拟时显示占位图）
 *   ④ 选图 → AI 生成商品信息（标题/卖点/价格）
 *   ⑤ 一键开店 → 调用 POST /api/create-product → 返回店铺链接
 *
 * 后台地址默认 http://localhost:8080，可在应用设置中配置 DEEPAY_API_BASE。
 */

import { usePreference } from '@data/hooks/usePreference'
import { loggerService } from '@logger'
import { cn } from '@renderer/utils'
import {
  CheckCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  Wand2
} from 'lucide-react'
import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('FashionPage')

// ── 类型 ─────────────────────────────────────────────────────────────────────

interface ProductInfo {
  title: string
  sellingPoints: string[]
  price: string
  estimatedRevenue: string
}

interface GenerateResult {
  chainCode?: string
  image?: string
  iban?: string
  link?: string
  images?: string[]
  taskId?: string
  status?: string
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const CATEGORIES = ['外套', '连衣裙', '裤子', '上衣', '运动', '内衣']
const STYLES = ['欧美', '工装', '韩系', '极简', '性感', '休闲']
const MARKETS = ['欧美', '东南亚', '国内', '中东']

const STYLE_CHIPS = [
  { label: '红点缀', value: 'red accent details' },
  { label: '白LOGO', value: 'white logo print' },
  { label: '图案更大', value: 'bigger graphic print' },
  { label: '极简', value: 'minimalist clean design' },
  { label: '高级感', value: 'luxury premium feel' },
  { label: '街头风', value: 'urban streetwear style' }
]

// 生成用于开发/演示的 mock 设计图 URL（灰色色块 + 品类标签）
function mockImageUrl(category: string, style: string, index: number): string {
  const colors = ['1a1a2e', '16213e', '0f3460', '1b262c', '252941', '2c3e50']
  const bg = colors[index % colors.length]
  return `https://via.placeholder.com/400x500/${bg}/1abc9c?text=${encodeURIComponent(`${category}·${style}·${index + 1}`)}`
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

const FashionPage: FC = () => {
  const { t } = useTranslation()
  const [deepayApiBase] = usePreference('deepay.api_base')

  // 筛选项
  const [category, setCategory] = useState('外套')
  const [style, setStyle] = useState('欧美')
  const [market, setMarket] = useState('欧美')
  const [extraChips, setExtraChips] = useState<string[]>([])
  const [extraPrompt, setExtraPrompt] = useState('')

  // 生成状态
  const [images, setImages] = useState<string[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMsg, setLoadingMsg] = useState('')
  const [error, setError] = useState('')

  // 商品信息 & 开店
  const [productInfo, setProductInfo] = useState<ProductInfo | null>(null)
  const [shopResult, setShopResult] = useState<GenerateResult | null>(null)
  const [opening, setOpening] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // ── chip 切换 ──────────────────────────────────────────────────────────────
  function toggleChip(chip: (typeof STYLE_CHIPS)[0]) {
    setExtraChips((prev) => {
      if (prev.includes(chip.label)) {
        const next = prev.filter((c) => c !== chip.label)
        setExtraPrompt(next.map((c) => STYLE_CHIPS.find((s) => s.label === c)?.value ?? '').join(', '))
        return next
      }
      if (prev.length >= 3) {
        setExtraPrompt(chip.value)
        return [chip.label]
      }
      const next = [...prev, chip.label]
      setExtraPrompt(next.map((c) => STYLE_CHIPS.find((s) => s.label === c)?.value ?? '').join(', '))
      return next
    })
  }

  // ── 生成图片 ──────────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    if (loading) return
    setLoading(true)
    setError('')
    setImages([])
    setSelected(null)
    setProductInfo(null)
    setShopResult(null)
    setLoadingMsg('AI 正在分析趋势…')

    try {
      const uid = localStorage.getItem('deepay_uid') || crypto.randomUUID()
      localStorage.setItem('deepay_uid', uid)

      const res = await fetch(`${deepayApiBase}/api/design/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
        body: JSON.stringify({ userId: uid, category, style, market, priceLevel: extraPrompt || null })
      })
        .then((r) => r.json())
        .catch(() => null)

      if (res?.data?.taskId) {
        setLoadingMsg('正在生成设计款式…')
        startPoll(res.data.taskId, uid)
        return
      }

      // 后台不可用时退化为 mock 数据
      logger.warn('Deepay backend not available, using mock images')
      const mocks = Array.from({ length: 6 }, (_, i) => mockImageUrl(category, style, i))
      setImages(mocks)
    } catch (err) {
      logger.error('generate error', err)
      // 退化 mock
      const mocks = Array.from({ length: 6 }, (_, i) => mockImageUrl(category, style, i))
      setImages(mocks)
    } finally {
      setLoading(false)
      setLoadingMsg('')
    }
  }, [loading, deepayApiBase, category, style, market, extraPrompt])

  function startPoll(taskId: string, uid: string) {
    let count = 0
    pollRef.current = setInterval(async () => {
      count++
      if (count > 60) {
        clearInterval(pollRef.current!)
        setLoading(false)
        setError('生成超时，请重试')
        return
      }
      try {
        const res = await fetch(`${deepayApiBase}/api/design/result/${taskId}`, {
          headers: { 'X-User-Id': uid }
        }).then((r) => r.json())
        const data = res?.data ?? res
        if (data?.status === 'done' && data?.images?.length) {
          clearInterval(pollRef.current!)
          setImages(data.images)
          setLoading(false)
          setLoadingMsg('')
        }
      } catch {
        // 继续轮询
      }
    }, 2000)
  }

  // ── 选图后生成商品信息 ────────────────────────────────────────────────────
  async function selectImage(img: string) {
    setSelected(img)
    setProductInfo(null)
    try {
      const uid = localStorage.getItem('deepay_uid') ?? ''
      const res = await fetch(`${deepayApiBase}/api/product/generate-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
        body: JSON.stringify({ image: img, category, style, market })
      })
        .then((r) => r.json())
        .catch(() => null)
      const data = res?.data ?? res
      if (data?.title) {
        setProductInfo(data as ProductInfo)
        return
      }
    } catch {
      // ignore
    }
    // mock
    setProductInfo({
      title: `${style}风${category}爆款`,
      sellingPoints: [`${market}市场热卖`, '高品质面料', '限量设计款'],
      price: '€29.99',
      estimatedRevenue: '€1,200 / 月'
    })
  }

  // ── 一键开店 ──────────────────────────────────────────────────────────────
  async function openShop() {
    if (!selected || opening) return
    setOpening(true)
    setError('')
    try {
      const res = await fetch(`${deepayApiBase}/api/create-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: `${category} ${style} ${extraPrompt}`.trim() })
      })
        .then((r) => r.json())
        .catch(() => null)
      const data = res?.data ?? res
      if (data?.chainCode) {
        setShopResult(data as GenerateResult)
        return
      }
    } catch {
      // ignore
    }
    // mock
    const code = Math.random().toString(36).slice(2, 8).toUpperCase()
    setShopResult({
      chainCode: code,
      image: selected,
      iban: `DEEPAY-DEMO-${code}`,
      link: `https://deepay.link/${code}`
    })
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 顶部标题栏 */}
      <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10">
            <Wand2 size={18} className="text-emerald-400" />
          </div>
          <div>
            <h1 className="font-semibold text-foreground text-sm">
              {t('fashion.title', { defaultValue: 'AI 服装设计' })}
            </h1>
            <p className="text-muted-foreground text-xs">
              {t('fashion.subtitle', { defaultValue: '一句话 → AI 出款 → 一键开店' })}
            </p>
          </div>
        </div>
      </div>

      {/* 主体内容 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左栏：筛选区 */}
        <div className="flex w-64 flex-shrink-0 flex-col gap-5 overflow-y-auto border-r border-border p-4">
          <FilterGroup
            label={t('fashion.category', { defaultValue: '品类' })}
            items={CATEGORIES}
            selected={category}
            onSelect={setCategory}
          />
          <FilterGroup
            label={t('fashion.style', { defaultValue: '风格' })}
            items={STYLES}
            selected={style}
            onSelect={setStyle}
          />
          <FilterGroup
            label={t('fashion.market', { defaultValue: '目标市场' })}
            items={MARKETS}
            selected={market}
            onSelect={setMarket}
          />

          {/* AI 修改 chips */}
          <div>
            <p className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-widest">
              {t('fashion.ai_modify', { defaultValue: 'AI 微调' })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {STYLE_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={() => toggleChip(chip)}
                  className={cn(
                    'rounded-lg px-2.5 py-1 text-xs transition-all',
                    extraChips.includes(chip.label)
                      ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  )}>
                  {chip.label}
                </button>
              ))}
            </div>
          </div>

          {/* 生成按钮 */}
          <button
            type="button"
            onClick={generate}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 font-semibold text-sm text-white transition-all hover:bg-emerald-400 disabled:opacity-50">
            {loading ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                {loadingMsg || '生成中…'}
              </>
            ) : (
              <>
                <Sparkles size={15} />
                {t('fashion.generate', { defaultValue: '生成系列' })}
              </>
            )}
          </button>

          {error && <p className="rounded-lg bg-destructive/10 p-2 text-destructive text-xs">{error}</p>}
        </div>

        {/* 中栏：图片展示 */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {images.length === 0 && !loading ? (
            <EmptyState onGenerate={generate} />
          ) : (
            <div className="flex-1 overflow-y-auto p-4">
              {loading && images.length === 0 ? (
                <LoadingGrid />
              ) : (
                <div className="grid grid-cols-3 gap-3">
                  {images.map((img, i) => (
                    <ImageCard
                      key={img + i}
                      src={img}
                      isSelected={selected === img}
                      onSelect={() => void selectImage(img)}
                    />
                  ))}
                </div>
              )}
              {images.length > 0 && (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={generate}
                    disabled={loading}
                    className="flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-muted-foreground text-xs hover:bg-muted/80 disabled:opacity-50">
                    <RefreshCw size={12} />
                    {t('fashion.regenerate', { defaultValue: '重新生成' })}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 右栏：商品信息 + 开店 */}
        {selected && (
          <div className="flex w-72 flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
            <img
              src={selected}
              alt="selected"
              className="w-full rounded-xl object-cover"
              style={{ aspectRatio: '4/5' }}
            />

            {productInfo ? (
              <ProductInfoCard info={productInfo} />
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground text-xs">
                <Loader2 size={13} className="animate-spin" />
                AI 分析商品信息…
              </div>
            )}

            {shopResult ? (
              <ShopResultCard result={shopResult} />
            ) : (
              <button
                type="button"
                onClick={() => void openShop()}
                disabled={opening || !productInfo}
                className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 font-semibold text-sm text-white transition-all hover:bg-emerald-400 disabled:opacity-50">
                {opening ? (
                  <>
                    <Loader2 size={15} className="animate-spin" />
                    开店中…
                  </>
                ) : (
                  <>
                    <ShoppingBag size={15} />
                    {t('fashion.open_shop', { defaultValue: '一键开店' })}
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── 子组件 ────────────────────────────────────────────────────────────────────

function FilterGroup({
  label,
  items,
  selected,
  onSelect
}: {
  label: string
  items: string[]
  selected: string
  onSelect: (v: string) => void
}) {
  return (
    <div>
      <p className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-widest">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => onSelect(item)}
            className={cn(
              'rounded-lg px-2.5 py-1 text-xs transition-all',
              selected === item
                ? 'bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            )}>
            {item}
          </button>
        ))}
      </div>
    </div>
  )
}

function ImageCard({
  src,
  isSelected,
  onSelect
}: {
  src: string
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'relative overflow-hidden rounded-xl transition-all',
        isSelected ? 'ring-2 ring-emerald-500' : 'ring-1 ring-border hover:ring-emerald-500/50'
      )}
      style={{ aspectRatio: '4/5' }}>
      <img src={src} alt="" className="h-full w-full object-cover" />
      {isSelected && (
        <div className="absolute right-2 top-2 rounded-full bg-emerald-500 p-0.5">
          <CheckCircle size={14} className="text-white" />
        </div>
      )}
    </button>
  )
}

function LoadingGrid() {
  return (
    <div className="grid grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="animate-pulse rounded-xl bg-muted"
          style={{ aspectRatio: '4/5' }}
        />
      ))}
    </div>
  )
}

function EmptyState({ onGenerate }: { onGenerate: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
        <Wand2 size={28} className="text-emerald-400" />
      </div>
      <div>
        <p className="font-semibold text-foreground text-sm">选择品类和风格，开始 AI 设计</p>
        <p className="mt-1 text-muted-foreground text-xs">AI 将自动生成 6 款热卖样式</p>
      </div>
      <button
        type="button"
        onClick={onGenerate}
        className="flex items-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-2 text-emerald-400 text-sm hover:bg-emerald-500/20">
        <Sparkles size={14} />
        立即生成
      </button>
    </div>
  )
}

function ProductInfoCard({ info }: { info: ProductInfo }) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <p className="font-semibold text-foreground text-sm">{info.title}</p>
      <ul className="mt-2 space-y-0.5">
        {info.sellingPoints.map((sp, i) => (
          <li key={i} className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="h-1 w-1 rounded-full bg-emerald-400 flex-shrink-0" />
            {sp}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-between">
        <div>
          <p className="text-muted-foreground text-xs">建议售价</p>
          <p className="font-bold text-emerald-400 text-sm">{info.price}</p>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground text-xs">预估收益</p>
          <p className="font-semibold text-foreground text-sm">{info.estimatedRevenue}</p>
        </div>
      </div>
    </div>
  )
}

function ShopResultCard({ result }: { result: GenerateResult }) {
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <CheckCircle size={15} className="text-emerald-400" />
        <p className="font-semibold text-emerald-400 text-sm">店铺已创建</p>
      </div>
      <div className="space-y-1 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">链码</span>
          <span className="font-mono font-bold text-foreground">{result.chainCode}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">IBAN</span>
          <span className="font-mono text-foreground text-[10px]">{result.iban}</span>
        </div>
      </div>
      {result.link && (
        <a
          href={result.link}
          target="_blank"
          rel="noreferrer"
          className="mt-3 flex items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 font-medium text-white text-xs hover:bg-emerald-400">
          <ExternalLink size={12} />
          访问店铺
        </a>
      )}
    </div>
  )
}

export default FashionPage
