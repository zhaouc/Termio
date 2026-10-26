import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { api } from '../services/api'
import type { HistoryPoint, Snapshot } from '../types/models'
import { getCachedTrendHistory, loadCachedTrendHistory } from '../utils/trendHistoryCache'
import { TrendChart } from './TrendChart'

type Metric = 'utl' | 'mem'

const TREND_WINDOW_SECONDS = 15 * 60
const TREND_BUCKET_SECONDS = 60
const TREND_REFRESH_INTERVAL_MS = 60_000

function coverageLabel(points: HistoryPoint[]) {
  if (points.length < 2) return '等待更多样本'
  const seconds = Math.max(0, points.at(-1)!.timestamp - points[0].timestamp)
  return `最近 ${Math.max(1, Math.round(seconds / 60))} 分钟`
}

export function ResourceTrend({ snapshot, kind, gpuUuid, title, animate }: { snapshot: Snapshot; kind: 'gpu' | 'cpu'; gpuUuid?: string; title: string; animate: boolean }) {
  const [metric, setMetric] = useState<Metric>(kind === 'gpu' ? 'mem' : 'utl')
  const [points, setPoints] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const cacheKey = `${snapshot.serverId}:15m:${TREND_BUCKET_SECONDS}`
    const cached = getCachedTrendHistory(cacheKey)
    setPoints(cached ?? [])
    setLoading(!cached)
    setError(null)
    const load = () => loadCachedTrendHistory(
      cacheKey,
      () => api.getHistory(snapshot.serverId, Math.floor(Date.now() / 1000) - TREND_WINDOW_SECONDS, TREND_BUCKET_SECONDS),
      TREND_REFRESH_INTERVAL_MS,
    ).then((value) => { if (!cancelled) setPoints(value) }).catch((reason) => { if (!cancelled) setError(String(reason)) }).finally(() => { if (!cancelled) setLoading(false) })
    void load()
    const interval = window.setInterval(() => void load(), TREND_REFRESH_INTERVAL_MS)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [snapshot.serverId])
  const mode = kind === 'cpu' ? (metric === 'utl' ? 'cpu' : 'systemMemory') : (metric === 'utl' ? 'gpu' : 'gpuMemory')
  return <section className="panel panel--chart resource-trend"><header className="resource-trend__header"><div><strong>{title}</strong><small>{error ?? coverageLabel(points)}</small></div><div className="resource-trend__controls"><span>{(['utl', 'mem'] as const).map((value) => <button key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{value.toUpperCase()}</button>)}</span></div></header>{loading && points.length === 0 ? <div className="resource-trend__loading"><RefreshCw className="spin" size={15} />正在读取…</div> : <TrendChart points={points} snapshot={snapshot} mode={mode} gpuUuid={gpuUuid} height={220} animate={animate} />}</section>
}
