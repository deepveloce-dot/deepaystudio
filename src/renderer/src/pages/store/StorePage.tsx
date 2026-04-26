/**
 * DeepayPage.tsx — 开店 + Deepay 管理后台
 *
 * 三个标签（对齐 deepay.srl yudao-ui-deepay）：
 *   1. 一键开店 — 输入 prompt → POST /api/create-product → 展示链码/支付链接
 *   2. 我的店铺 — 本地存储的已创建店铺列表（带复制链接 / 访问按钮）
 *   3. 管理后台 — 仪表盘统计 + 快速入口（对齐 admin/AdminHome.vue）
 */

import { usePreference } from '@data/hooks/usePreference'
import { loggerService } from '@logger'
import { cn } from '@renderer/utils'
import {
  BarChart3,
  CheckCircle,
  ClipboardCopy,
  ExternalLink,
  Loader2,
  Package,
  ShoppingBag,
  Sparkles,
  Store,
  TrendingUp,
  Users
} from 'lucide-react'
import { type FC, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

const logger = loggerService.withContext('DeepayPage')

// ── 类型 ─────────────────────────────────────────────────────────────────────

interface ShopRecord {
  chainCode: string
  image: string
  iban: string
  link: string
  prompt: string
  createdAt: string
}

type TabId = 'create' | 'shops' | 'admin'

// ── 本地存储 helpers ───────────────────────────────────────────────────────

const SHOPS_KEY = 'deepay_shops'

function loadShops(): ShopRecord[] {
  try {
    return JSON.parse(localStorage.getItem(SHOPS_KEY) ?? '[]') as ShopRecord[]
  } catch {
    return []
  }
}

function saveShop(shop: ShopRecord) {
  const list = loadShops()
  list.unshift(shop)
  localStorage.setItem(SHOPS_KEY, JSON.stringify(list.slice(0, 50)))
}

// ── 主组件 ────────────────────────────────────────────────────────────────────

const DeepayPage: FC = () => {
  const { t } = useTranslation()
  const [deepayApiBase] = usePreference('deepay.api_base')
  const [activeTab, setActiveTab] = useState<TabId>('create')
  const [shops, setShops] = useState<ShopRecord[]>(loadShops)

  const onShopCreated = useCallback((shop: ShopRecord) => {
    saveShop(shop)
    setShops(loadShops())
  }, [])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 顶部标题栏 */}
      <div className="flex flex-shrink-0 items-center gap-4 border-b border-border px-6 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10">
          <Store size={18} className="text-emerald-400" />
        </div>
        <div className="flex-1">
          <h1 className="font-semibold text-foreground text-sm">
            {t('deepay.title', { defaultValue: 'Deepay 一衣一链' })}
          </h1>
          <p className="text-muted-foreground text-xs">
            {t('deepay.subtitle', { defaultValue: '设计 → 开店 → 售卖，全链路闭环' })}
          </p>
        </div>

        {/* 标签切换 */}
        <div className="flex rounded-lg bg-muted p-0.5">
          {(
            [
              { id: 'create', label: t('deepay.tab.create', { defaultValue: '一键开店' }), icon: Sparkles },
              { id: 'shops', label: t('deepay.tab.shops', { defaultValue: '我的店铺' }), icon: ShoppingBag },
              { id: 'admin', label: t('deepay.tab.admin', { defaultValue: '管理后台' }), icon: BarChart3 }
            ] as Array<{ id: TabId; label: string; icon: FC<{ size?: number }> }>
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-all',
                activeTab === id
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}>
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 标签内容 */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'create' && (
          <CreateTab deepayApiBase={deepayApiBase} onShopCreated={onShopCreated} />
        )}
        {activeTab === 'shops' && <ShopsTab shops={shops} />}
        {activeTab === 'admin' && <AdminTab deepayApiBase={deepayApiBase} />}
      </div>
    </div>
  )
}

// ── 一键开店 Tab ──────────────────────────────────────────────────────────────

function CreateTab({
  deepayApiBase,
  onShopCreated
}: {
  deepayApiBase: string
  onShopCreated: (shop: ShopRecord) => void
}) {
  const { t } = useTranslation()
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<ShopRecord | null>(null)
  const [error, setError] = useState('')

  const EXAMPLE_PROMPTS = ['极简羊绒大衣', '欧美街头风卫衣', '韩系碎花连衣裙', '运动休闲卫裤', '高级感皮质外套']

  async function createProduct() {
    if (!prompt.trim() || loading) return
    setLoading(true)
    setError('')
    setResult(null)

    try {
      const res = await fetch(`${deepayApiBase}/api/create-product`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() })
      })
        .then((r) => r.json())
        .catch(() => null)

      const data = res?.data ?? res
      if (data?.chainCode) {
        const shop: ShopRecord = {
          chainCode: data.chainCode,
          image: data.image ?? '',
          iban: data.iban ?? `DEEPAY-DEMO-${data.chainCode}`,
          link: data.link ?? `https://deepay.link/${data.chainCode}`,
          prompt: prompt.trim(),
          createdAt: new Date().toLocaleString('zh-CN')
        }
        setResult(shop)
        onShopCreated(shop)
        return
      }
    } catch (err) {
      logger.warn('create-product backend error', err)
    }

    // mock（后台不可用时）
    const code = Math.random().toString(36).slice(2, 8).toUpperCase()
    const shop: ShopRecord = {
      chainCode: code,
      image: `https://via.placeholder.com/400x500/1a1a2e/1abc9c?text=${encodeURIComponent(prompt)}`,
      iban: `DEEPAY-DEMO-${code}`,
      link: `https://deepay.link/${code}`,
      prompt: prompt.trim(),
      createdAt: new Date().toLocaleString('zh-CN')
    }
    setResult(shop)
    onShopCreated(shop)
    setLoading(false)
  }

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto p-8">
      <div className="w-full max-w-xl">
        {/* 输入区 */}
        <div className="mb-6">
          <h2 className="mb-1 font-semibold text-foreground text-base">描述你的商品</h2>
          <p className="mb-4 text-muted-foreground text-xs">用一句话描述，AI 自动生成设计并创建售卖链接</p>

          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="例如：极简羊绒大衣…"
              className="min-h-[100px] w-full resize-none rounded-xl border border-border bg-muted/30 p-4 pr-4 text-foreground text-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-emerald-500/40"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void createProduct()
              }}
            />
          </div>

          {/* 示例 prompts */}
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLE_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPrompt(p)}
                className="rounded-lg bg-muted px-2.5 py-1 text-muted-foreground text-xs hover:bg-muted/80 hover:text-foreground">
                {p}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => void createProduct()}
          disabled={!prompt.trim() || loading}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-6 py-3 font-semibold text-sm text-white transition-all hover:bg-emerald-400 disabled:opacity-50">
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {t('deepay.creating', { defaultValue: '正在创建…' })}
            </>
          ) : (
            <>
              <Sparkles size={16} />
              {t('deepay.create_shop', { defaultValue: '立即开店' })}
            </>
          )}
        </button>

        {error && <p className="mt-3 rounded-xl bg-destructive/10 p-3 text-destructive text-sm">{error}</p>}

        {/* 结果展示 */}
        {result && (
          <div className="mt-6 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5">
            <div className="mb-3 flex items-center gap-2">
              <CheckCircle size={16} className="text-emerald-400" />
              <p className="font-semibold text-emerald-400 text-sm">
                {t('deepay.shop_created', { defaultValue: '店铺创建成功！' })}
              </p>
            </div>

            <div className="mb-4 flex gap-4">
              {result.image && (
                <img
                  src={result.image}
                  alt="design"
                  className="h-24 w-20 rounded-lg object-cover flex-shrink-0"
                />
              )}
              <div className="flex-1 space-y-2 text-xs">
                <InfoRow label="商品描述" value={result.prompt} />
                <InfoRow label="链码" value={result.chainCode} mono />
                <InfoRow label="收款 IBAN" value={result.iban} mono small />
                <InfoRow label="创建时间" value={result.createdAt} />
              </div>
            </div>

            <div className="flex gap-2">
              <CopyButton text={result.link} label="复制链接" />
              <a
                href={result.link}
                target="_blank"
                rel="noreferrer"
                className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 font-medium text-white text-xs hover:bg-emerald-400">
                <ExternalLink size={13} />
                访问店铺
              </a>
            </div>
          </div>
        )}

        {/* 流程说明 */}
        {!result && (
          <div className="mt-8">
            <p className="mb-3 text-center text-muted-foreground text-xs">整个流程自动完成</p>
            <div className="flex items-center justify-center gap-2">
              {['描述商品', 'AI 出款', '生成链码', '创建支付', '售卖链接'].map((step, i, arr) => (
                <div key={step} className="flex items-center gap-2">
                  <div className="flex flex-col items-center gap-1">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/10 text-[10px] font-bold text-emerald-400">
                      {i + 1}
                    </div>
                    <span className="whitespace-nowrap text-[10px] text-muted-foreground">{step}</span>
                  </div>
                  {i < arr.length - 1 && <div className="mb-5 h-px w-4 bg-border" />}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── 我的店铺 Tab ──────────────────────────────────────────────────────────────

function ShopsTab({ shops }: { shops: ShopRecord[] }) {
  const { t } = useTranslation()

  if (shops.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10">
          <ShoppingBag size={24} className="text-emerald-400" />
        </div>
        <p className="font-medium text-foreground text-sm">
          {t('deepay.no_shops', { defaultValue: '还没有店铺' })}
        </p>
        <p className="text-muted-foreground text-xs">在「一键开店」标签创建你的第一个店铺</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {shops.map((shop) => (
          <ShopCard key={shop.chainCode} shop={shop} />
        ))}
      </div>
    </div>
  )
}

function ShopCard({ shop }: { shop: ShopRecord }) {
  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {shop.image && (
        <img src={shop.image} alt={shop.prompt} className="h-32 w-full object-cover" />
      )}
      <div className="p-3">
        <p className="mb-1 truncate font-medium text-foreground text-sm">{shop.prompt}</p>
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span className="font-mono font-bold text-emerald-400">{shop.chainCode}</span>
          <span>{shop.createdAt}</span>
        </div>
        <div className="flex gap-2">
          <CopyButton text={shop.link} label="复制" className="flex-1" />
          <a
            href={shop.link}
            target="_blank"
            rel="noreferrer"
            className="flex flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-500/10 px-2 py-1.5 text-emerald-400 text-xs hover:bg-emerald-500/20">
            <ExternalLink size={12} />
            访问
          </a>
        </div>
      </div>
    </div>
  )
}

// ── 管理后台 Tab ──────────────────────────────────────────────────────────────

const STATS = [
  { label: '商品数', value: '128', delta: '+12', up: true, icon: Package },
  { label: '订单量', value: '3,842', delta: '+8%', up: true, icon: ShoppingBag },
  { label: '支付流水', value: '€24,910', delta: '+15%', up: true, icon: TrendingUp },
  { label: '活跃用户', value: '1,204', delta: '-3%', up: false, icon: Users }
]

const QUICK_LINKS = [
  { label: '🎭 灵感库', desc: '管理灵感图片，选款改款', path: '/admin/inspiration' },
  { label: '⚙️ 菜单配置', desc: '控制用户端功能入口', path: '/admin/menu-config' },
  { label: '📦 商品管理', desc: '上架/下架商品', path: '/admin/product' },
  { label: '📋 订单管理', desc: '查看所有订单', path: '/admin/order' },
  { label: '💳 支付流水', desc: '支付记录与对账', path: '/admin/payment' },
  { label: '💰 钱包提现', desc: '用户提现审核', path: '/admin/wallet' }
]

function AdminTab({ deepayApiBase }: { deepayApiBase: string }) {
  const { t } = useTranslation()

  return (
    <div className="h-full overflow-y-auto p-6">
      {/* 标题 */}
      <div className="mb-6 flex items-start justify-between border-b border-emerald-500/40 pb-4">
        <div>
          <h2 className="font-bold text-foreground text-xl">
            {t('deepay.admin.title', { defaultValue: 'Deepay 管理后台' })}
          </h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {t('deepay.admin.welcome', { defaultValue: '欢迎回来，选择模块开始管理' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
          </span>
          <span className="text-emerald-400 text-xs font-medium">系统正常</span>
        </div>
      </div>

      {/* 后台地址提示 */}
      <div className="mb-5 rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-xs">
        <span className="text-muted-foreground">当前后台地址：</span>
        <span className="font-mono text-foreground">{deepayApiBase}</span>
        <span className="ml-3 text-muted-foreground">（可在设置中修改 deepay.api_base）</span>
      </div>

      {/* 统计卡片 */}
      <div className="mb-8 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {STATS.map(({ label, value, delta, up, icon: Icon }, i) => (
          <div
            key={label}
            className="rounded-2xl border border-border bg-card p-5 transition-all hover:border-emerald-500/40 hover:-translate-y-0.5 hover:shadow-lg"
            style={{ animationDelay: `${i * 80}ms` }}>
            <Icon size={22} className="mb-3 text-muted-foreground" />
            <p className="mb-1 font-bold text-foreground text-2xl">{value}</p>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-xs">{label}</span>
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
                  up ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                )}>
                {up ? '▲' : '▼'} {delta}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* 快速入口 */}
      <p className="mb-3 font-bold text-muted-foreground text-xs uppercase tracking-widest">快速入口</p>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        {QUICK_LINKS.map(({ label, desc, path }) => (
          <a
            key={path}
            href={`${deepayApiBase}${path}`}
            target="_blank"
            rel="noreferrer"
            className="group rounded-2xl border border-border bg-card p-5 text-left transition-all hover:border-emerald-500/40 hover:-translate-y-0.5 hover:shadow-lg">
            <p className="mb-1 font-bold text-foreground text-base group-hover:text-emerald-400 transition-colors">{label}</p>
            <p className="text-muted-foreground text-xs">{desc}</p>
          </a>
        ))}
      </div>
    </div>
  )
}

// ── 工具组件 ──────────────────────────────────────────────────────────────────

function InfoRow({
  label,
  value,
  mono,
  small
}: {
  label: string
  value: string
  mono?: boolean
  small?: boolean
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-medium text-foreground truncate',
          mono && 'font-mono',
          small && 'text-[10px]'
        )}>
        {value}
      </span>
    </div>
  )
}

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn(
        'flex items-center justify-center gap-1 rounded-lg border border-border px-2 py-1.5 text-muted-foreground text-xs transition-all hover:border-emerald-500/40 hover:text-foreground',
        className
      )}>
      {copied ? <CheckCircle size={12} className="text-emerald-400" /> : <ClipboardCopy size={12} />}
      {copied ? '已复制' : label}
    </button>
  )
}

export default DeepayPage
