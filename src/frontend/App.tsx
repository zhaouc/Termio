import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  Activity,
  AlertCircle,
  Bell,
  BellOff,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Download,
  Gauge,
  GripVertical,
  KeyRound,
  LayoutDashboard,
  MemoryStick,
  Minus,
  MoreHorizontal,
  Network,
  OctagonX,
  Plus,
  RefreshCw,
  Search,
  Server as ServerIcon,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Square,
  TerminalSquare,
  Trash2,
  Upload,
  UserRound,
  WifiOff,
  X,
  Zap,
} from 'lucide-react'
import { api } from './services/api'
import type { AppSettings, DetailTab, GpuMemoryStallWarning, HistoryPoint, HostKeyInfo, LinkedProjectResourcePlan, Project, ProjectDraft, ProjectSyncProgress, Server, ServerDraft, Snapshot } from './types/models'
import { DeleteServerDialog } from './components/DeleteServerDialog'
import { MetricBar } from './components/MetricBar'
import { ProcessBlocks, type ProcessTerminationTarget } from './components/ProcessBlocks'
import { ProjectForm } from './components/ProjectForm'
import { ProjectConflictDialog, ProjectDeleteDialog, ProjectView, syncableProjectTargets } from './components/ProjectView'
import { ResourceTrend } from './components/ResourceTrend'
import { ServerForm } from './components/ServerForm'
import { SshTerminal } from './components/SshTerminal'
import { StatusPill } from './components/StatusPill'
import { TrendChart } from './components/TrendChart'
import { aggregateGpuMemoryPercent, aggregateGpuSmUtilization, clampPercent, countOtherUserGpuWorkloads, displayedGpuMemoryPercent, gpuLoadAccent, gpuLoadLevel, gpuMemoryLevel, gpuMemoryPercent, isGpuAvailable, isGpuIdle } from './utils/gpu'
import { canDisplayServerDetails, offlineFailureThreshold, serverStatusAfterSyncAwareFailure, shouldShowConnectingOnAttempt } from './utils/connectionStatus'
import { displayedFreeMemoryGb, formatGpuOccupiedDuration, gpuOccupiedDurationSeconds, rankIdleGpuItems, type IdleGpuItem } from './utils/idleGpu'
import { canOfferNvidiaDriverInstall, clearResolvedNvidiaWarningId, displayedNvidiaServerStatus, loadIgnoredNvidiaWarningIds, nvidiaIssueGuidance, nvidiaIssueTitle, saveIgnoredNvidiaWarningIds } from './utils/nvidiaStatus'
import { DISK_STATUS_INTERVAL_MS, FOREGROUND_STATUS_INTERVAL_MS, shouldCollectDetailData, shouldIncludeProcesses, shouldRecordHistory, statusRefreshIntervalMs } from './utils/refreshCadence'
import { deriveGpuMemoryStallWarnings, ignoredGpuMemoryStallGpus } from './utils/gpuMemoryWarnings'
import { currentUserProcessCount } from './utils/processRelations'
import { previewServerOrder, serverDropTarget, type ServerDropPlacement } from './utils/serverOrder'
import { serverMatchesSearch } from './utils/serverSearch'
import { serverDisplayName } from './utils/serverName'
import { detectAppPlatform } from './utils/platform'
import { acceleratorLabel } from './utils/accelerator'
import packageInfo from '../../package.json'

const appPlatform = detectAppPlatform(api.isDesktop, navigator.userAgent)

const REALTIME_TREND_WINDOW_SECONDS = 15 * 60

const tabs: Array<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'gpu', label: 'GPU' },
  { value: 'processes', label: '进程' },
  { value: 'cpu', label: 'CPU' },
  { value: 'network', label: '网络' },
  { value: 'terminal', label: navigator.userAgent.includes('Windows') ? '命令行' : '终端' },
]

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function formatDataBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function formatNetworkRate(bytesPerSecond: number) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < 1024 ** 2) return `${(bytesPerSecond / 1024).toFixed(bytesPerSecond < 10 * 1024 ? 1 : 0)} KB/s`
  if (bytesPerSecond < 1024 ** 3) return `${(bytesPerSecond / 1024 ** 2).toFixed(bytesPerSecond < 10 * 1024 ** 2 ? 1 : 0)} MB/s`
  return `${(bytesPerSecond / 1024 ** 3).toFixed(2)} GB/s`
}

function formatClock(mhz: number) {
  if (!Number.isFinite(mhz) || mhz <= 0) return '0 MHz'
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, operation: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await operation(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

function relativeTime(timestamp?: number | null) {
  if (!timestamp) return '尚未刷新'
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (seconds < 5) return '刚刚'
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

function startWindowDrag(event: MouseEvent<HTMLElement>) {
  if (!api.isDesktop || event.button !== 0 || event.detail !== 1) return
  if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [role="button"]')) return
  void getCurrentWindow().startDragging()
}

async function toggleWindowMaximize(event: MouseEvent<HTMLElement>) {
  if (!api.isDesktop || event.button !== 0) return
  if ((event.target as HTMLElement).closest('button, input, select, textarea, a, [role="button"]')) return
  event.preventDefault()
  await getCurrentWindow().toggleMaximize()
}

function WindowsWindowControls() {
  if (appPlatform !== 'windows') return null
  return (
    <div className="window-controls" aria-label="窗口控制" onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('window_minimize') }} aria-label="最小化窗口" title="最小化窗口"><Minus size={15} /></button>
      <button type="button" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('window_toggle_maximize') }} aria-label="最大化或还原窗口"><Square size={12} /></button>
      <button type="button" className="window-controls__close" onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); void invoke('window_close') }} aria-label="关闭窗口" title="关闭窗口"><X size={15} /></button>
    </div>
  )
}

function serverToDraft(server: Server): Partial<ServerDraft> {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    port: server.port,
    username: server.username,
    samplingIntervalSeconds: server.samplingIntervalSeconds,
    historyRetentionDays: server.historyRetentionDays,
    authMethod: server.authMethod,
  }
}

function App() {
  const [servers, setServers] = useState<Server[]>([])
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({})
  const [history, setHistory] = useState<Record<string, HistoryPoint[]>>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [selectedTab, setSelectedTab] = useState<DetailTab>('overview')
  const [selectedGpuUuid, setSelectedGpuUuid] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [draggedServerId, setDraggedServerId] = useState<string | null>(null)
  const draggedServerIdRef = useRef<string | null>(null)
  const dragOriginalServersRef = useRef<Server[] | null>(null)
  const dragPreviewServersRef = useRef<Server[] | null>(null)
  const dragMouseRef = useRef<{ sourceId: string; startY: number; pointerY: number; grabOffsetY: number; active: boolean; rows: Array<{ id: string; top: number; bottom: number }> } | null>(null)
  const dragMouseCleanupRef = useRef<(() => void) | null>(null)
  const suppressServerClickRef = useRef(false)
  const serverRowRefs = useRef(new Map<string, HTMLButtonElement>())
  const [showServerForm, setShowServerForm] = useState(false)
  const [editingServer, setEditingServer] = useState<Server | null>(null)
  const [serverDraftPreset, setServerDraftPreset] = useState<Partial<ServerDraft> | null>(null)
  const [importingConfig, setImportingConfig] = useState(false)
  const [importDrafts, setImportDrafts] = useState<ServerDraft[] | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [mainView, setMainView] = useState<'server' | 'fleet' | 'idle' | 'projects'>('fleet')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectEditor, setProjectEditor] = useState<Project | null | 'new'>(null)
  const [projectPendingDelete, setProjectPendingDelete] = useState<Project | null>(null)
  const [projectConflictTarget, setProjectConflictTarget] = useState<{ project: Project; targetServerId: string } | null>(null)
  const [busyProjectTargets, setBusyProjectTargets] = useState<Set<string>>(new Set())
  const [projectSyncProgress, setProjectSyncProgress] = useState<ProjectSyncProgress[]>([])
  const projectsRef = useRef<Project[]>([])
  const busyProjectTargetsRef = useRef<Set<string>>(new Set())
  const projectSyncProgressRef = useRef<ProjectSyncProgress[]>([])
  const [preparingProjectIds, setPreparingProjectIds] = useState<Set<string>>(new Set())
  const [gpuMemoryStallWarnings, setGpuMemoryStallWarnings] = useState<GpuMemoryStallWarning[]>([])
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [manualRefreshingAll, setManualRefreshingAll] = useState(false)
  const [manualRefreshProgress, setManualRefreshProgress] = useState<{ completed: number; total: number } | null>(null)
  const [manualRefreshRevision, setManualRefreshRevision] = useState(0)
  const [manualRefreshingServers, setManualRefreshingServers] = useState<Set<string>>(new Set())
  const [paused, setPaused] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [ignoredNvidiaWarnings, setIgnoredNvidiaWarnings] = useState<Set<string>>(loadIgnoredNvidiaWarningIds)
  const [pendingHostKey, setPendingHostKey] = useState<HostKeyInfo | null>(null)
  const [serverPendingDelete, setServerPendingDelete] = useState<Server | null>(null)
  const [processPendingTermination, setProcessPendingTermination] = useState<(ProcessTerminationTarget & { serverId: string; serverName: string }) | null>(null)
  const [terminatingProcess, setTerminatingProcess] = useState<{ serverId: string; pid: number } | null>(null)
  const initialLoad = useRef(false)
  const manualRefreshFeedbackTimerRef = useRef<number | null>(null)
  const snapshotsRef = useRef<Record<string, Snapshot>>({})
  const ignoredNvidiaWarningsRef = useRef(ignoredNvidiaWarnings)
  const failureCounts = useRef<Record<string, number>>({})
  const lastAttemptAt = useRef<Record<string, number>>({})
  const lastProcessAttemptAt = useRef<Record<string, number>>({})
  const lastDiskAttemptAt = useRef<Record<string, number>>({})
  const lastHistoryRecordedAt = useRef<Record<string, number>>({})
  const remoteCleanupNoticeKeys = useRef(new Set<string>())
  const nextRetryAt = useRef<Record<string, number>>({})
  const inFlightServers = useRef(new Set<string>())
  const deletedServerIds = useRef(new Set<string>())
  const gpuMemoryStallSince = useRef<Record<string, number>>((() => {
    try {
      const value = JSON.parse(localStorage.getItem('termio.gpuMemoryStallSince.v1') ?? '{}')
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  })())
  const notifiedGpuMemoryStalls = useRef(new Set<string>())
  const [ignoredGpuMemoryStallWarningIds, setIgnoredGpuMemoryStallWarningIds] = useState<Set<string>>(() => {
    if (typeof localStorage === 'undefined') return new Set<string>()
    try {
      const value = JSON.parse(localStorage.getItem('termio.ignoredGpuMemoryStallWarnings.v1') ?? '[]')
      return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
    } catch { return new Set() }
  })

  const selectedServer = servers.find((server) => server.id === selectedServerId)
  const selectedSnapshot = selectedServerId ? snapshots[selectedServerId] : undefined

  useEffect(() => { projectsRef.current = projects }, [projects])
  useEffect(() => { busyProjectTargetsRef.current = busyProjectTargets }, [busyProjectTargets])
  useEffect(() => { projectSyncProgressRef.current = projectSyncProgress }, [projectSyncProgress])

  const refreshServer = useCallback(async (serverId: string, quiet = false) => {
    if (inFlightServers.current.has(serverId)) return
    const nowMs = Date.now()
    const serverConfig = servers.find((server) => server.id === serverId)
    if (quiet && serverConfig) {
      const fastStatusView = mainView === 'fleet' || (mainView === 'server' && selectedTab === 'overview' && selectedServerId === serverId)
      const refreshIntervalMs = statusRefreshIntervalMs(fastStatusView, document.hidden, serverConfig.samplingIntervalSeconds, settings?.backgroundSamplingIntervalSeconds ?? 15)
      if (nowMs - (lastAttemptAt.current[serverId] ?? 0) < refreshIntervalMs || nowMs < (nextRetryAt.current[serverId] ?? 0)) return
    }
    lastAttemptAt.current[serverId] = nowMs
    if (!quiet) delete nextRetryAt.current[serverId]
    inFlightServers.current.add(serverId)
    setBusy((current) => new Set(current).add(serverId))
    const activeProjectSync = projectSyncProgressRef.current.some((progress) => {
      const project = projectsRef.current.find((item) => item.id === progress.projectId)
      return progress.targetServerId === serverId || project?.sourceServerId === serverId
    }) || [...busyProjectTargetsRef.current].some((key) => {
      const separator = key.lastIndexOf(':')
      const projectId = separator >= 0 ? key.slice(0, separator) : key
      const targetServerId = separator >= 0 ? key.slice(separator + 1) : ''
      const project = projectsRef.current.find((item) => item.id === projectId)
      return targetServerId === serverId || project?.sourceServerId === serverId
    })
    if (!activeProjectSync && shouldShowConnectingOnAttempt(quiet, Boolean(snapshotsRef.current[serverId]), failureCounts.current[serverId] ?? 0)) {
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: 'connecting', lastError: null } : server))
    }
    try {
      const previous = snapshotsRef.current[serverId]
      const fastStatusView = !document.hidden && (mainView === 'fleet' || (mainView === 'server' && selectedTab === 'overview' && selectedServerId === serverId))
      const collectDetailData = shouldCollectDetailData(quiet, Boolean(previous))
      const includeProcesses = shouldIncludeProcesses(Boolean(previous), collectDetailData, quiet, fastStatusView, lastProcessAttemptAt.current[serverId], nowMs, settings?.processIntervalSeconds ?? 5)
      const includeDisks = collectDetailData && (!quiet || nowMs - (lastDiskAttemptAt.current[serverId] ?? 0) >= DISK_STATUS_INTERVAL_MS)
      const recordHistory = !serverConfig || shouldRecordHistory(lastHistoryRecordedAt.current[serverId], nowMs, serverConfig.samplingIntervalSeconds)
      const collected = await api.collectServer(serverId, includeProcesses, includeDisks, recordHistory, !quiet)
      if (deletedServerIds.current.has(serverId)) return
      if (collected.processesSampled) lastProcessAttemptAt.current[serverId] = nowMs
      if (includeDisks) lastDiskAttemptAt.current[serverId] = nowMs
      const snapshot = {
        ...collected,
        ...(!collected.processesSampled ? { processes: previous?.processes ?? [], cpuProcesses: previous?.cpuProcesses ?? [] } : {}),
        ...(!includeDisks ? { disks: previous?.disks ?? [] } : {}),
        ...(collected.network && !collected.network.usersSampled ? { network: { ...collected.network, users: previous?.network?.users ?? [] } } : {}),
      }
      snapshotsRef.current = { ...snapshotsRef.current, [serverId]: snapshot }
      failureCounts.current[serverId] = 0
      delete nextRetryAt.current[serverId]
      const retainedNvidiaWarnings = clearResolvedNvidiaWarningId(ignoredNvidiaWarningsRef.current, serverId, snapshot.nvidiaSmi)
      if (retainedNvidiaWarnings !== ignoredNvidiaWarningsRef.current) {
        ignoredNvidiaWarningsRef.current = retainedNvidiaWarnings
        setIgnoredNvidiaWarnings(retainedNvidiaWarnings)
        saveIgnoredNvidiaWarningIds(retainedNvidiaWarnings)
      }
      setSnapshots((current) => ({ ...current, [serverId]: snapshot }))
      setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: displayedNvidiaServerStatus(snapshot, retainedNvidiaWarnings.has(serverId)), lastSeenAt: snapshot.timestamp, lastError: snapshot.nvidiaMessage } : server))
      if (recordHistory) {
        lastHistoryRecordedAt.current[serverId] = nowMs
        const from = snapshot.timestamp - REALTIME_TREND_WINDOW_SECONDS
        try {
          const points = await api.getHistory(serverId, from)
          if (!deletedServerIds.current.has(serverId)) setHistory((current) => ({ ...current, [serverId]: points }))
        } catch (historyError) {
          if (!quiet) setToast(`历史数据读取失败：${String(historyError)}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failureCounts.current[serverId] = (failureCounts.current[serverId] ?? 0) + 1
      const failureCount = failureCounts.current[serverId]
      const retryDelays = [1, 2, 5, 10, 30]
      nextRetryAt.current[serverId] = Date.now() + retryDelays[Math.min(failureCount - 1, retryDelays.length - 1)] * 1000
      setServers((current) => current.map((server) => server.id === serverId ? {
        ...server,
        status: serverStatusAfterSyncAwareFailure(server.status, failureCount, activeProjectSync, Boolean(snapshotsRef.current[serverId])),
        lastError: activeProjectSync && failureCount < offlineFailureThreshold(true)
          ? `大文件同步期间采集暂时延迟 · ${retryDelays[Math.min(failureCount - 1, retryDelays.length - 1)]} 秒后重试`
          : `${message} · ${retryDelays[Math.min(failureCount - 1, retryDelays.length - 1)]} 秒后重试`,
      } : server))
      if (message.includes('主机指纹')) {
        try {
          setPendingHostKey(await api.scanHostKey(serverId))
        } catch (scanError) {
          if (!quiet) setToast(String(scanError))
        }
      }
      if (!quiet) setToast(message)
    } finally {
      inFlightServers.current.delete(serverId)
      setBusy((current) => {
        const next = new Set(current)
        next.delete(serverId)
        return next
      })
    }
  }, [mainView, selectedServerId, selectedTab, settings, servers])

  const setNvidiaWarningIgnored = useCallback((serverId: string, ignored: boolean) => {
    const next = new Set(ignoredNvidiaWarningsRef.current)
    if (ignored) next.add(serverId)
    else next.delete(serverId)
    ignoredNvidiaWarningsRef.current = next
    setIgnoredNvidiaWarnings(next)
    saveIgnoredNvidiaWarningIds(next)
    const snapshot = snapshotsRef.current[serverId]
    if (snapshot) setServers((current) => current.map((server) => server.id === serverId ? { ...server, status: displayedNvidiaServerStatus(snapshot, ignored) } : server))
    setToast(ignored ? '已忽略此服务器的 GPU 异常提醒，可在连接页恢复' : '已恢复 GPU 异常提醒')
  }, [])

  const refreshAll = useCallback(async (quiet = false, onSettled?: () => void) => {
    await Promise.allSettled(servers.map(async (server) => {
      try { await refreshServer(server.id, quiet) } finally { onSettled?.() }
    }))
  }, [servers, refreshServer])

  const runManualRefreshAll = useCallback(async () => {
    if (manualRefreshingAll) return
    if (manualRefreshFeedbackTimerRef.current !== null) window.clearTimeout(manualRefreshFeedbackTimerRef.current)
    setManualRefreshingAll(true)
    setManualRefreshProgress({ completed: 0, total: servers.length })
    try {
      await refreshAll(false, () => setManualRefreshProgress((current) => current ? { ...current, completed: current.completed + 1 } : current))
      setManualRefreshRevision((value) => value + 1)
    } finally {
      setManualRefreshingAll(false)
      manualRefreshFeedbackTimerRef.current = window.setTimeout(() => {
        setManualRefreshProgress(null)
        manualRefreshFeedbackTimerRef.current = null
      }, 900)
    }
  }, [manualRefreshingAll, refreshAll, servers.length])

  useEffect(() => () => {
    if (manualRefreshFeedbackTimerRef.current !== null) window.clearTimeout(manualRefreshFeedbackTimerRef.current)
  }, [])

  const runManualRefreshServer = useCallback(async (serverId: string) => {
    setManualRefreshingServers((current) => new Set(current).add(serverId))
    try { await refreshServer(serverId, false) } finally {
      setManualRefreshingServers((current) => {
        const next = new Set(current)
        next.delete(serverId)
        return next
      })
    }
  }, [refreshServer])

  useEffect(() => {
    void Promise.all([api.listServers(), api.getSettings(), api.listProjects()]).then(([loadedServers, loadedSettings, loadedProjects]) => {
      setServers(loadedServers)
      setSettings(loadedSettings)
      setProjects(loadedProjects)
      setSelectedServerId((current) => current ?? loadedServers[0]?.id ?? null)
    })
  }, [])

  useEffect(() => {
    if (!api.isDesktop || (mainView !== 'projects' && busyProjectTargets.size === 0)) return
    let cancelled = false
    const load = () => void api.listProjectSyncProgress().then((progress) => { if (!cancelled) setProjectSyncProgress(progress) }).catch(() => {})
    load()
    const interval = window.setInterval(load, 500)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [mainView, busyProjectTargets.size])

  useEffect(() => {
    if (mainView !== 'projects' || projects.length === 0 || busyProjectTargets.size > 0 || preparingProjectIds.size > 0) return
    let cancelled = false
    void mapWithConcurrency(projects, 2, (project) => api.inspectProjectSource(project.id).catch(() => null)).then((inspected) => {
      if (cancelled) return
      const inspectedById = new Map(inspected.filter((project): project is Project => Boolean(project)).map((project) => [project.id, project]))
      if (inspectedById.size > 0) setProjects((current) => current.map((project) => inspectedById.get(project.id) ?? project))
    })
    return () => { cancelled = true }
  }, [mainView, projects.length, busyProjectTargets.size, preparingProjectIds.size])

  useEffect(() => {
    if (!api.isDesktop) return
    let cancelled = false
    const retryRemoteCleanups = async () => {
      try {
        const result = await api.retryRemoteCleanups()
        if (cancelled) return
        if (result.pendingNames.length > 0 && !remoteCleanupNoticeKeys.current.has('pending')) {
          remoteCleanupNoticeKeys.current.add('pending')
          const names = result.pendingNames.map(serverDisplayName).join('、')

          setToast(`${names} 的远端数据清理等待重连，自动重试最多 24 小时`)
        }
        if (result.expiredNames.length > 0 && !remoteCleanupNoticeKeys.current.has('expired')) {
          remoteCleanupNoticeKeys.current.add('expired')
          const names = result.expiredNames.map(serverDisplayName).join('、')

          setToast(`${names} 的远端自动清理已超过 24 小时，请手动清理旧版远端数据`)
        }
      } catch (error) {
        if (!cancelled) setToast(`远端删除任务检查失败：${String(error)}`)
      }
    }
    void retryRemoteCleanups()
    const interval = window.setInterval(() => void retryRemoteCleanups(), 5 * 60 * 1000)
    return () => { cancelled = true; window.clearInterval(interval) }
  }, [])

  useEffect(() => {
    if (servers.length === 0 || initialLoad.current) return
    initialLoad.current = true
    void refreshAll(true)
  }, [servers.length, refreshAll])

  useEffect(() => {
    if (!settings || servers.length === 0 || paused) return
    const interval = window.setInterval(() => void refreshAll(true), FOREGROUND_STATUS_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [settings, servers.length, refreshAll, paused])


  useEffect(() => {
    if (!api.isDesktop) return
    const unlistenMenu = listen<string>('app-menu-action', ({ payload }) => {
      if (payload === 'menu-about') setShowAbout(true)
      else if (payload === 'menu-settings') setShowSettings(true)
      else if (payload === 'menu-add-server') { setEditingServer(null); setServerDraftPreset(null); setShowServerForm(true) }
      else if (payload === 'menu-refresh-all') void runManualRefreshAll()
      else if (payload === 'menu-view-fleet') setMainView('fleet')
      else if (payload === 'menu-view-idle') setMainView('idle')
    })
    return () => { void unlistenMenu.then((dispose) => dispose()) }
  }, [runManualRefreshAll])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    if (!settings) return
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--own-accent', settings.currentUserAccent)
  }, [settings])

  useEffect(() => {
    const now = Math.max(...Object.values(snapshots).map((snapshot) => snapshot.timestamp), 0)
    const result = deriveGpuMemoryStallWarnings(servers, snapshots, gpuMemoryStallSince.current, ignoredGpuMemoryStallWarningIds, now)
    gpuMemoryStallSince.current = result.since
    localStorage.setItem('termio.gpuMemoryStallSince.v1', JSON.stringify(result.since))
    setGpuMemoryStallWarnings(result.warnings)
    let ignoredChanged = false
    const retainedIgnoredIds = new Set(ignoredGpuMemoryStallWarningIds)
    for (const id of ignoredGpuMemoryStallWarningIds) {
      if (id in result.since) continue
      retainedIgnoredIds.delete(id)
      ignoredChanged = true
    }
    if (ignoredChanged) {
      setIgnoredGpuMemoryStallWarningIds(retainedIgnoredIds)
      localStorage.setItem('termio.ignoredGpuMemoryStallWarnings.v1', JSON.stringify([...retainedIgnoredIds]))
    }
    for (const warning of result.warnings) notifiedGpuMemoryStalls.current.add(warning.id)
    for (const id of notifiedGpuMemoryStalls.current) {
      if (!(id in result.since)) notifiedGpuMemoryStalls.current.delete(id)
    }
  }, [servers, snapshots, ignoredGpuMemoryStallWarningIds])

  const visibleServers = useMemo(() => {
    return servers.filter((server) => serverMatchesSearch(server, snapshots[server.id], search))
  }, [servers, snapshots, search])

  const idleGpuItems = useMemo(() => rankIdleGpuItems(servers, snapshots), [servers, snapshots])
  const idleAvailableCount = idleGpuItems.filter((item) => item.available).length

  const totals = useMemo(() => {
    const values = Object.values(snapshots)
    const gpus = values.flatMap((snapshot) => snapshot.gpus)
    const online = servers.filter((server) => server.status === 'online' || server.status === 'warning').length
    return {
      online,
      offline: servers.filter((server) => server.status === 'offline').length,
      gpus: gpus.length,
      idle: idleAvailableCount,
      latestRefresh: values.length ? Math.max(...values.map((snapshot) => snapshot.timestamp)) : null,
    }
  }, [snapshots, servers, idleAvailableCount])
  const restoreGpuMemoryStallWarning = useCallback((warningId: string) => {
    setIgnoredGpuMemoryStallWarningIds((current) => {
      const next = new Set(current)
      next.delete(warningId)
      localStorage.setItem('termio.ignoredGpuMemoryStallWarnings.v1', JSON.stringify([...next]))
      return next
    })
    notifiedGpuMemoryStalls.current.delete(warningId)
    setToast('已恢复显存占用预警')
  }, [])

  async function saveServer(draft: ServerDraft) {
    const previous = draft.id ? servers.find((item) => item.id === draft.id) : undefined
    const saved = await api.saveServer(draft)
    deletedServerIds.current.delete(saved.id)
    setServers((current) => previous ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved])
    setSelectedServerId(saved.id)
    setShowServerForm(false)
    setEditingServer(null)
    setServerDraftPreset(null)
    setToast('服务器已保存，正在连接…')
    await refreshServer(saved.id)
  }

  async function importConfig() {
    if (importingConfig) return
    setImportingConfig(true)
    try {
      const drafts = await api.importSshConfig()
      if (drafts.length === 0) {
        setToast('已读取 ~/.ssh/config，但没有找到可导入的 Host；通配符 Host 会被忽略')
        return
      }
      setImportDrafts(drafts)
    } catch (error) {
      setToast(`SSH Config 导入失败：${String(error)}`)
    } finally {
      setImportingConfig(false)
    }
  }

  async function saveProject(draft: ProjectDraft, syncAfterSave: boolean, linkedResources: LinkedProjectResourcePlan[]) {
    const saved = await api.saveProject(draft)
    setProjects((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
    setProjectEditor(null)
    const prepareLinkedResources = async () => {
      const prepared: Array<{ project: Project; syncTargetIds: string[] }> = []
      for (const plan of linkedResources.filter((item) => item.syncOnSave)) {
        const resource = projects.find((item) => item.id === plan.resourceId && item.kind === plan.kind)
        if (!resource) continue
        setPreparingProjectIds((current) => new Set(current).add(resource.id))
        try {
          const plannedIds = new Set(plan.targets.map((target) => target.serverId))
          const configured = await api.saveProject({
            id: resource.id,
            name: resource.name,
            kind: resource.kind,
            sourceServerId: resource.sourceServerId,
            sourcePath: resource.sourcePath,
            datasetIds: [],
            modelIds: [],
            targets: [...resource.targets.filter((target) => !plannedIds.has(target.serverId)).map(({ serverId, path }) => ({ serverId, path })), ...plan.targets],
          })
          const inspected = await api.inspectProject(configured.id)
          setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))
          prepared.push({ project: inspected, syncTargetIds: plan.targets.map((target) => target.serverId) })
        } catch (reason) {
          setPreparingProjectIds((current) => { const next = new Set(current); next.delete(resource.id); return next })
          throw reason
        }
      }
      return prepared
    }
    if (syncAfterSave) {
      setPreparingProjectIds((current) => new Set(current).add(saved.id))
      setToast(`“${saved.name}”已保存，正在准备同步`)
      try {
        const [inspected, preparedResources] = await Promise.all([api.inspectProject(saved.id), prepareLinkedResources()])
        setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))
        if (!inspected.sourceExists) throw new Error('主目录不存在，无法开始同步')
        const projectTargetTotal = syncableProjectTargets(inspected).length
        const syncing = syncAllProjectTargets(inspected, false)
        setPreparingProjectIds((current) => { const next = new Set(current); next.delete(saved.id); return next })
        const completed = await syncing
        let resourceCompleted = 0
        let resourceTotal = 0
        for (const prepared of preparedResources) {
          resourceTotal += prepared.syncTargetIds.length
          try {
            const results = await Promise.all(prepared.syncTargetIds.map((serverId) => syncProjectTarget(prepared.project, serverId, false)))
            resourceCompleted += results.filter(Boolean).length
          } finally {
            setPreparingProjectIds((current) => { const next = new Set(current); next.delete(prepared.project.id); return next })
          }
        }
        const resourceMessage = resourceTotal > 0 ? `；关联资源 ${resourceCompleted} / ${resourceTotal} 个目标同步成功` : ''
        setToast(completed === projectTargetTotal ? `“${saved.name}”已更新 ${completed} 个目标${resourceMessage}` : `“${saved.name}”已保存；${completed} / ${projectTargetTotal} 个目标同步成功${resourceMessage}`)
      } catch (reason) {
        setToast(`“${saved.name}”已保存，准备同步失败：${String(reason)}`)
      } finally {
        setPreparingProjectIds((current) => {
          const next = new Set(current)
          next.delete(saved.id)
          linkedResources.forEach((plan) => next.delete(plan.resourceId))
          return next
        })
      }
      return
    }
    setToast(`“${saved.name}”已保存`)
    void api.inspectProject(saved.id).then((inspected) => setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))).catch((reason) => setToast(`“${saved.name}”已保存，路径检测失败：${String(reason)}`))
  }

  async function inspectProject(project: Project) {
    try {
      const inspected = await api.inspectProject(project.id)
      setProjects((current) => current.map((item) => item.id === inspected.id ? inspected : item))
      setToast(`“${project.name}”路径检测完成`)
    } catch (reason) { setToast(`路径检测失败：${String(reason)}`) }
  }

  async function syncProjectTarget(project: Project, targetServerId: string, showToast = true, force = false) {
    const key = `${project.id}:${targetServerId}`
    if (busyProjectTargetsRef.current.has(key)) return false
    const nextBusyTargets = new Set(busyProjectTargetsRef.current).add(key)
    busyProjectTargetsRef.current = nextBusyTargets
    setBusyProjectTargets(nextBusyTargets)
    try {
      const result = await api.syncProject(project.id, targetServerId, force)
      setProjects(await api.listProjects())
      if (showToast) setToast(`${result.message} · ${formatDataBytes(result.transferredBytes)}`)
      return true
    } catch (reason) {
      try {
        const refreshedProjects = await api.listProjects()
        setProjects(refreshedProjects)
      } catch { /* Keep the current list when the failure state cannot be reloaded. */ }
      if (showToast) setToast(`同步失败：${String(reason)}`)
      return false
    } finally {
      const next = new Set(busyProjectTargetsRef.current)
      next.delete(key)
      busyProjectTargetsRef.current = next
      setBusyProjectTargets(next)
    }
  }

  async function cancelProjectTarget(projectId: string, targetServerId: string) {
    try {
      await api.cancelProjectSync(projectId, targetServerId)
      setToast('正在安全暂停同步')
    } catch (reason) { setToast(`无法暂停同步：${String(reason)}`) }
  }

  async function syncAllProjectTargets(project: Project, showCompletion = true) {
    const targets = syncableProjectTargets(project)
    if (targets.length === 0) {
      if (showCompletion) setToast(`“${project.name}”没有待更新的目标服务器`)
      return 0
    }
    const results = await mapWithConcurrency(targets, 2, (target) => syncProjectTarget(project, target.serverId, false))
    const completed = results.filter(Boolean).length
    if (showCompletion) setToast(completed === targets.length ? `“${project.name}”已更新 ${completed} 个目标` : `“${project.name}”同步完成；${completed} / ${targets.length} 个目标成功`)
    return completed
  }

  async function removeServer(server: Server) {
    deletedServerIds.current.add(server.id)
    try {
      const deletion = await api.deleteServer(server.id)
      const remainingProjects = await api.listProjects()
      const nextSelectedId = servers.find((item) => item.id !== server.id)?.id ?? null
      setServers((current) => current.filter((item) => item.id !== server.id))
      setProjects(remainingProjects)
      setSelectedServerId((current) => current === server.id ? nextSelectedId : current)
      setSnapshots((current) => {
        const next = { ...current }
        delete next[server.id]
        snapshotsRef.current = next
        return next
      })
      setHistory((current) => {
        const next = { ...current }
        delete next[server.id]
        return next
      })
      delete failureCounts.current[server.id]
      delete lastAttemptAt.current[server.id]
      delete lastProcessAttemptAt.current[server.id]
      delete lastDiskAttemptAt.current[server.id]
      delete lastHistoryRecordedAt.current[server.id]
      delete nextRetryAt.current[server.id]
      setServerPendingDelete(null)
      setToast(deletion.message)
    } catch (error) {
      deletedServerIds.current.delete(server.id)
      throw error
    }
  }

  function previewServerMove(sourceId: string, targetId: string, placement: ServerDropPlacement) {
    if (!sourceId || search) return
    const original = dragOriginalServersRef.current ?? servers
    const current = dragPreviewServersRef.current ?? original
    const next = previewServerOrder(original, sourceId, targetId, placement)
    if (next.map(({ id }) => id).join('\n') === current.map(({ id }) => id).join('\n')) return
    dragPreviewServersRef.current = next
    const drag = dragMouseRef.current
    if (!drag) return
    const originalTop = new Map(drag.rows.map((row) => [row.id, row.top]))
    next.forEach((server, nextIndex) => {
      if (server.id === sourceId) return
      const element = serverRowRefs.current.get(server.id)
      const naturalTop = originalTop.get(server.id)
      const destinationTop = originalTop.get(original[nextIndex]?.id)
      if (!element || naturalTop === undefined || destinationTop === undefined) return
      animateServerRowTransform(element, destinationTop - naturalTop)
    })
  }

  function animateServerRowTransform(element: HTMLButtonElement, translateY: number) {
    const systemReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const visualTop = element.getBoundingClientRect().top
    element.getAnimations().forEach((animation) => animation.cancel())
    element.style.transform = translateY ? `translateY(${translateY}px)` : ''
    if (systemReduceMotion) return
    const delta = visualTop - element.getBoundingClientRect().top
    element.animate(
      [{ transform: `translateY(${translateY + delta}px)` }, { transform: translateY ? `translateY(${translateY}px)` : 'translateY(0)' }],
      { duration: 210, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
    )
  }

  function positionDraggedServer() {
    const drag = dragMouseRef.current
    const element = drag ? serverRowRefs.current.get(drag.sourceId) : null
    if (!drag?.active || !element) return
    const naturalTop = drag.rows.find((row) => row.id === drag.sourceId)?.top
    if (naturalTop === undefined) return
    element.getAnimations().forEach((animation) => animation.cancel())
    element.style.transform = `translateY(${drag.pointerY - drag.grabOffsetY - naturalTop}px)`
  }

  function settleServerOrder(ordered: Server[]) {
    const visualTops = new Map(Array.from(serverRowRefs.current, ([id, element]) => [id, element.getBoundingClientRect().top]))
    for (const element of serverRowRefs.current.values()) element.getAnimations().forEach((animation) => animation.cancel())
    flushSync(() => {
      setServers(ordered)
      setDraggedServerId(null)
    })
    draggedServerIdRef.current = null
    const systemReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    for (const [id, element] of serverRowRefs.current) {
      element.style.transform = ''
      const visualTop = visualTops.get(id)
      if (systemReduceMotion || visualTop === undefined) continue
      const delta = visualTop - element.getBoundingClientRect().top
      if (Math.abs(delta) >= 0.5) element.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 180, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' })
    }
  }

  function beginServerMouseDrag(event: MouseEvent<HTMLSpanElement>, serverId: string) {
    if (event.button !== 0 || search) return
    event.preventDefault()
    event.stopPropagation()
    dragMouseCleanupRef.current?.()
    const row = event.currentTarget.closest('.server-row') as HTMLButtonElement | null
    if (!row) return
    const rows = servers.map((server) => {
      const bounds = serverRowRefs.current.get(server.id)?.getBoundingClientRect()
      return { id: server.id, top: bounds?.top ?? 0, bottom: bounds?.bottom ?? 0 }
    })
    const drag = { sourceId: serverId, startY: event.clientY, pointerY: event.clientY, grabOffsetY: event.clientY - row.getBoundingClientRect().top, active: false, rows }
    dragMouseRef.current = drag
    dragOriginalServersRef.current = servers
    dragPreviewServersRef.current = servers
    draggedServerIdRef.current = serverId

    const cleanup = () => {
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('mouseup', finish, true)
      window.removeEventListener('blur', cancel)
      document.documentElement.classList.remove('is-server-dragging')
      dragMouseCleanupRef.current = null
    }
    const move = (moveEvent: globalThis.MouseEvent) => {
      if (!drag.active && Math.abs(moveEvent.clientY - drag.startY) < 4) return
      moveEvent.preventDefault()
      drag.pointerY = moveEvent.clientY
      if (!drag.active) {
        drag.active = true
        document.documentElement.classList.add('is-server-dragging')
        setDraggedServerId(drag.sourceId)
      }
      positionDraggedServer()
      const target = serverDropTarget(drag.rows, moveEvent.clientY)
      if (target) previewServerMove(drag.sourceId, target.targetId, target.placement)
    }
    const finish = () => {
      cleanup()
      dragMouseRef.current = null
      if (drag.active) {
        suppressServerClickRef.current = true
        settleServerOrder(dragPreviewServersRef.current ?? dragOriginalServersRef.current ?? servers)
        void commitServerOrder()
      } else {
        dragOriginalServersRef.current = null
        dragPreviewServersRef.current = null
        draggedServerIdRef.current = null
      }
    }
    const cancel = () => {
      cleanup()
      dragMouseRef.current = null
      for (const element of serverRowRefs.current.values()) animateServerRowTransform(element, 0)
      cancelServerOrderPreview()
    }
    dragMouseCleanupRef.current = cleanup
    window.addEventListener('mousemove', move, true)
    window.addEventListener('mouseup', finish, true)
    window.addEventListener('blur', cancel)
  }

  async function commitServerOrder() {
    const ordered = dragPreviewServersRef.current ?? servers
    const previousOrder = dragOriginalServersRef.current ?? servers
    setDraggedServerId(null)
    draggedServerIdRef.current = null
    try {
      await api.reorderServers(ordered.map((server) => server.id))
    } catch (error) {
      setServers(previousOrder)
      setToast(`服务器顺序保存失败：${String(error)}`)
    } finally {
      dragOriginalServersRef.current = null
      dragPreviewServersRef.current = null
    }
  }

  function cancelServerOrderPreview() {
    if (dragOriginalServersRef.current) setServers(dragOriginalServersRef.current)
    dragOriginalServersRef.current = null
    dragPreviewServersRef.current = null
    draggedServerIdRef.current = null
    setDraggedServerId(null)
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${api.isDesktop ? 'sidebar--desktop' : ''}`}>
        <div className="sidebar__titlebar" onMouseDown={startWindowDrag} onDoubleClick={(event) => void toggleWindowMaximize(event)}>
          <div className="traffic-spacer" aria-hidden="true" />
          <button className="brand" onClick={() => setShowAbout(true)} aria-label="关于 Termio">
            <span className="brand__mark"><Activity size={18} strokeWidth={2.4} /></span>
            <div><strong>Termio</strong><small>远程工作台</small></div>
          </button>
        </div>
        <nav className="primary-nav" aria-label="主导航">
          <button className={mainView === 'fleet' ? 'is-active' : ''} onClick={() => setMainView('fleet')}><LayoutDashboard size={17} />总览 <span className="nav-count">{totals.gpus}</span></button>
          <button className={mainView === 'idle' ? 'is-active' : ''} onClick={() => setMainView('idle')}><Zap size={17} />空闲算力 <span className="nav-count">{totals.idle}</span></button>
        </nav>
        <div className="sidebar__section-header"><span>服务器</span><span>{totals.online}/{servers.length}</span></div>
        <div className="search-field"><Search size={14} /><input aria-label="搜索服务器" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索" />{search && <button onClick={() => setSearch('')} aria-label="清除搜索"><X size={13} /></button>}</div>
        <div className="server-list">
          {visibleServers.map((server) => {
            const snapshot = snapshots[server.id]
            return (
              <button
                className={`server-row ${selectedServerId === server.id && mainView === 'server' ? 'is-selected' : ''} ${draggedServerId === server.id ? 'is-dragging' : ''}`}
                key={server.id}
                ref={(element) => { if (element) serverRowRefs.current.set(server.id, element); else serverRowRefs.current.delete(server.id) }}
                onClick={() => { if (suppressServerClickRef.current) { suppressServerClickRef.current = false; return }; setSelectedServerId(server.id); setSelectedGpuUuid(null); setMainView('server') }}
              >
                <span className="server-row__drag" aria-hidden="true" onMouseDown={(event) => beginServerMouseDrag(event, server.id)}><GripVertical size={13} /></span>
                <span className={`server-row__status server-row__status--${server.status}`} />
                <span className="server-row__content">
                  <span className="server-row__title">{server.name || server.host}</span>
                  <span className="server-row__meta">{snapshot ? `${snapshot.gpus.length} ${acceleratorLabel(snapshot)} ${Math.round(aggregateGpuMemoryPercent(snapshot.gpus))}% · CPU ${Math.round(clampPercent(snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0))}%` : server.name.trim() === server.host.trim() ? (server.status === 'offline' ? '暂时离线 · 可重新连接' : '等待首次采样') : server.host}</span>
                </span>
                <span className="server-row__trailing">
                  <ChevronRight size={14} className="server-row__chevron" />
                  {snapshot && currentUserProcessCount(snapshot) > 0 && <span className="own-task-dot" title="有你的任务"><UserRound size={11} /></span>}
                </span>
              </button>
            )
          })}
          {visibleServers.length === 0 && <p className="empty-copy">没有匹配的服务器</p>}
        </div>
        <div className="sidebar__footer">
          <button onClick={() => { setEditingServer(null); setServerDraftPreset(null); setShowServerForm(true) }}><Plus size={16} />添加服务器</button>
          <button onClick={() => void importConfig()} disabled={importingConfig}><Download size={16} />{importingConfig ? '正在读取 SSH Config…' : '从 SSH Config 导入'}</button>
          <button onClick={() => setShowSettings(true)}><Settings size={16} />设置</button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar" onMouseDown={startWindowDrag} onDoubleClick={(event) => void toggleWindowMaximize(event)}>
          <div className="topbar__title">
            {mainView !== 'idle' && <p className="eyebrow">{mainView === 'projects' ? '跨服务器文件同步' : mainView === 'fleet' ? `${totals.online} / ${servers.length} 台在线` : selectedServer ? selectedServer.host : '所有服务器'}</p>}
            <h1>{mainView === 'projects' ? '我的项目' : mainView === 'idle' ? '空闲算力' : mainView === 'fleet' ? '算力总览' : selectedServer ? serverDisplayName(selectedServer.name) : 'Termio 总览'}</h1>
          </div>
          <div className="topbar__actions">
            {manualRefreshProgress && <span className="remote-sync-slot"><span className="remote-sync-status remote-sync-status--syncing" role="status" aria-live="polite"><RefreshCw className={manualRefreshingAll ? 'spin' : ''} size={13} />正在重新连接 · {manualRefreshProgress.completed}/{manualRefreshProgress.total} 台</span></span>}
            <span className={`refresh-label ${paused ? 'is-paused' : ''}`}><Clock3 size={14} />{paused ? '采集已暂停' : mainView === 'server' && selectedServer ? relativeTime(selectedServer.lastSeenAt) : totals.latestRefresh ? relativeTime(totals.latestRefresh) : `${settings?.defaultSamplingIntervalSeconds ?? 2} 秒采样`}</span>
            <button className="button button--secondary" onClick={() => void runManualRefreshAll()} disabled={manualRefreshingAll}><RefreshCw size={16} className={manualRefreshingAll ? 'spin' : ''} />刷新</button>
            <WindowsWindowControls />
          </div>
        </header>

        <div className="workspace__scroll">
          {servers.length === 0 ? (
            <EmptyState onAdd={() => { setEditingServer(null); setServerDraftPreset(null); setShowServerForm(true) }} onImport={() => void importConfig()} />
          ) : mainView === 'projects' ? (
            <ProjectView projects={projects} servers={servers} busyTargets={busyProjectTargets} syncProgress={projectSyncProgress} preparingProjectIds={preparingProjectIds} onAdd={() => setProjectEditor('new')} onEdit={setProjectEditor} onDelete={setProjectPendingDelete} onInspect={inspectProject} onSync={(project, targetServerId) => { const target = project.targets.find((item) => item.serverId === targetServerId); if (target?.status === 'conflict') setProjectConflictTarget({ project, targetServerId }); else void syncProjectTarget(project, targetServerId) }} onCancel={(projectId, targetServerId) => void cancelProjectTarget(projectId, targetServerId)} onSyncAll={(project) => void syncAllProjectTargets(project)} />
          ) : mainView === 'idle' ? (
            <IdleGpuView snapshots={snapshots} items={idleGpuItems} sortRevision={manualRefreshRevision} onSelect={(serverId, gpuUuid) => { setSelectedServerId(serverId); setSelectedGpuUuid(gpuUuid); setSelectedTab('gpu'); setMainView('server') }} />
          ) : mainView === 'fleet' ? (
            <FleetOverview servers={servers} snapshots={snapshots} settings={settings} totals={totals} onSelect={(serverId, tab, gpuUuid) => { setSelectedServerId(serverId); setSelectedGpuUuid(gpuUuid ?? null); setSelectedTab(tab); setMainView('server') }} />
          ) : selectedServer && selectedSnapshot && canDisplayServerDetails(selectedServer.status) ? (
            <ServerDetail
              server={selectedServer}
              snapshot={selectedSnapshot}
              points={history[selectedServer.id] ?? []}
              settings={settings}
              tab={selectedTab}
              selectedGpuUuid={selectedGpuUuid}
              onTab={(tab) => { setSelectedTab(tab); if (tab !== 'gpu') setSelectedGpuUuid(null) }}
              onSelectGpu={(gpuUuid) => { setSelectedGpuUuid(gpuUuid); setSelectedTab('gpu') }}
              onRefresh={() => void runManualRefreshServer(selectedServer.id)}
              onDelete={() => setServerPendingDelete(selectedServer)}
              onEdit={() => { setEditingServer(selectedServer); setShowServerForm(true) }}
              onRequestTerminate={(target) => setProcessPendingTermination({ ...target, serverId: selectedServer.id, serverName: selectedServer.name })}
              terminatingPid={terminatingProcess?.serverId === selectedServer.id ? terminatingProcess.pid : undefined}
              nvidiaWarningIgnored={ignoredNvidiaWarnings.has(selectedServer.id)}
              onIgnoreNvidiaWarning={() => setNvidiaWarningIgnored(selectedServer.id, true)}
              onRestoreNvidiaWarning={() => setNvidiaWarningIgnored(selectedServer.id, false)}
              isRefreshing={manualRefreshingServers.has(selectedServer.id)}
              animateCharts={manualRefreshingAll || manualRefreshingServers.has(selectedServer.id)}
              gpuMemoryWarnings={gpuMemoryStallWarnings.filter((warning) => warning.serverId === selectedServer.id)}
              ignoredGpuMemoryStallWarningIds={ignoredGpuMemoryStallWarningIds}
              onRestoreGpuMemoryStallWarning={restoreGpuMemoryStallWarning}
            />
          ) : (
            <LoadingServer server={selectedServer} isRefreshing={selectedServer ? busy.has(selectedServer.id) : false} onRefresh={() => selectedServer && void refreshServer(selectedServer.id)} onDelete={() => selectedServer && setServerPendingDelete(selectedServer)} />
          )}
        </div>
      </main>

      {showServerForm && <ServerForm initial={editingServer ? serverToDraft(editingServer) : serverDraftPreset ?? undefined} onClose={() => { setShowServerForm(false); setEditingServer(null); setServerDraftPreset(null) }} onSave={saveServer} />}
      {importDrafts && <SshConfigImportSheet drafts={importDrafts} servers={servers} onClose={() => setImportDrafts(null)} onSelect={(draft) => { setImportDrafts(null); setEditingServer(null); setServerDraftPreset(draft); setShowServerForm(true) }} />}
      {projectEditor && <ProjectForm initial={projectEditor === 'new' ? null : projectEditor} projects={projects} servers={servers} activeSyncTargets={new Set([...busyProjectTargets, ...projectSyncProgress.map((progress) => `${progress.projectId}:${progress.targetServerId}`)])} onClose={() => setProjectEditor(null)} onSave={saveProject} />}
      {projectPendingDelete && <ProjectDeleteDialog project={projectPendingDelete} onClose={() => setProjectPendingDelete(null)} onDelete={async () => { await api.deleteProject(projectPendingDelete.id); setProjects((current) => current.filter((item) => item.id !== projectPendingDelete.id)); setProjectPendingDelete(null); setToast(`已移除“${projectPendingDelete.name}”的同步配置，服务器文件未删除`) }} />}
      {projectConflictTarget && <ProjectConflictDialog project={projectConflictTarget.project} server={servers.find((item) => item.id === projectConflictTarget.targetServerId)} onClose={() => setProjectConflictTarget(null)} onConfirm={() => { const pending = projectConflictTarget; setProjectConflictTarget(null); void syncProjectTarget(pending.project, pending.targetServerId, true, true) }} />}
      {showSettings && settings && <SettingsSheet settings={settings} onClose={() => setShowSettings(false)} onSave={async (value) => { setSettings(await api.saveSettings(value)); setShowSettings(false); setToast('设置已保存') }} />}
      {showAbout && <AboutSheet onClose={() => setShowAbout(false)} />}
      {pendingHostKey && <HostKeyDialog info={pendingHostKey} onClose={() => setPendingHostKey(null)} onTrust={async () => { const serverId = pendingHostKey.serverId; await api.trustHostKey(pendingHostKey); setPendingHostKey(null); setToast('已信任服务器指纹'); await refreshServer(serverId) }} />}
      {serverPendingDelete && <DeleteServerDialog server={serverPendingDelete} onClose={() => setServerPendingDelete(null)} onDelete={() => removeServer(serverPendingDelete)} />}
      {processPendingTermination && <TerminateProcessDialog target={processPendingTermination} onClose={() => setProcessPendingTermination(null)} onTerminate={() => { const target = processPendingTermination; setProcessPendingTermination(null); setTerminatingProcess({ serverId: target.serverId, pid: target.process.pid }); void api.terminateProcess(target.serverId, target.process.pid).then(async (result) => { setToast(result); await refreshServer(target.serverId) }).catch((reason) => { setToast(`结束 PID ${target.process.pid} 失败：${String(reason)}`) }).finally(() => setTerminatingProcess(null)) }} />}
      {toast && <div className="toast" role="status"><AlertCircle size={17} /><span>{toast}</span><button onClick={() => setToast(null)} aria-label="关闭"><X size={14} /></button></div>}
    </div>
  )
}

export function EmptyState({ onAdd, onImport }: { onAdd: () => void; onImport: () => void }) {
  return (
    <div className="empty-fleet">
      <div className="empty-state">
        <span className="empty-state__icon"><ServerIcon size={28} /></span>
        <h2>连接第一台服务器</h2>
        <p>添加 SSH 主机，或从本机 OpenSSH Config 导入 Host。认证支持 SSH Config 或密码。</p>
        <div><button className="button button--primary" onClick={onAdd}><Plus size={17} />添加服务器</button><button className="button button--secondary" onClick={onImport}><Download size={17} />从 SSH Config 导入</button></div>
      </div>
    </div>
  )
}

function LoadingServer({ server, isRefreshing, onRefresh, onDelete }: { server?: Server; isRefreshing: boolean; onRefresh: () => void; onDelete: () => void }) {
  const isConnecting = isRefreshing || server?.status === 'connecting'
  const isOffline = server?.status === 'offline'
  return (
    <div className="empty-state">
      <span className="empty-state__icon"><Network size={28} /></span>
      <h2>{isConnecting ? `正在连接 ${server ? serverDisplayName(server.name) : ''}` : isOffline ? `${server ? serverDisplayName(server.name) : '服务器'} 当前离线` : '尚无采样数据'}</h2>
      <p>{server?.lastError ?? '通过 SSH 获取第一份指标后，这里会显示完整服务器详情。'}</p>
      <div className="loading-server__actions"><button className="button button--primary" onClick={onRefresh} disabled={isConnecting}><RefreshCw size={17} className={isConnecting ? 'spin' : ''} />{isConnecting ? '连接中…' : isOffline ? '重新连接' : '立即连接'}</button>{server && <button className="button button--danger" onClick={onDelete}><Trash2 size={16} />删除服务器</button>}</div>
    </div>
  )
}

interface ServerDetailProps {
  server: Server
  snapshot: Snapshot
  points: HistoryPoint[]
  settings: AppSettings | null
  tab: DetailTab
  selectedGpuUuid: string | null
  onTab: (tab: DetailTab) => void
  onSelectGpu: (gpuUuid: string) => void
  onRefresh: () => void
  onDelete: () => void
  onEdit: () => void
  onRequestTerminate: (target: ProcessTerminationTarget) => void
  terminatingPid?: number
  nvidiaWarningIgnored: boolean
  onIgnoreNvidiaWarning: () => void
  onRestoreNvidiaWarning: () => void
  isRefreshing: boolean
  animateCharts: boolean
  gpuMemoryWarnings: GpuMemoryStallWarning[]
  ignoredGpuMemoryStallWarningIds: Set<string>
  onRestoreGpuMemoryStallWarning: (warningId: string) => void
}

function ServerDetail({ server, snapshot, points, settings, tab, selectedGpuUuid, onTab, onSelectGpu, onRefresh, onDelete, onEdit, onRequestTerminate, terminatingPid, nvidiaWarningIgnored, onIgnoreNvidiaWarning, onRestoreNvidiaWarning, isRefreshing, animateCharts, gpuMemoryWarnings, ignoredGpuMemoryStallWarningIds, onRestoreGpuMemoryStallWarning }: ServerDetailProps) {
  const [showConnectionSheet, setShowConnectionSheet] = useState(false)
  return (
    <div className={`detail-page ${tab === 'terminal' ? 'detail-page--terminal' : ''}`}>
      <div className="server-identity">
        <div><StatusPill status={server.status} /><span className="server-identity__meta">{snapshot.username}@{snapshot.hostname}</span></div>
        <div className="server-identity__actions">
          <button className="icon-button" aria-label="打开连接" title="连接" aria-haspopup="dialog" onClick={() => setShowConnectionSheet(true)}><MoreHorizontal size={18} /></button>
        </div>
      </div>
      <div className="detail-tabs" role="tablist">
        {tabs.map((item) => <button key={item.value} role="tab" aria-selected={tab === item.value} className={tab === item.value ? 'is-active' : ''} onClick={() => onTab(item.value)}>{item.value === 'gpu' ? acceleratorLabel(snapshot) : item.label}</button>)}
      </div>
      <div className="detail-content">
        {snapshot.acceleratorVendor !== 'ascend' && snapshot.nvidiaSmi !== 'available' && !nvidiaWarningIgnored && <NvidiaWarning snapshot={snapshot} onRefresh={onRefresh} onIgnore={onIgnoreNvidiaWarning} />}
        {tab === 'overview' && <ServerOverview snapshot={snapshot} points={points} idleThreshold={settings?.idleGpuThreshold ?? 10} onSelectGpu={onSelectGpu} onOpenCpu={() => onTab('cpu')} onRequestTerminate={onRequestTerminate} terminatingPid={terminatingPid} animateCharts={animateCharts} gpuMemoryWarnings={gpuMemoryWarnings} />}
        {tab === 'gpu' && <GpuDetail snapshot={snapshot} points={points} selectedGpuUuid={selectedGpuUuid} onSelectGpu={onSelectGpu} animateChart={animateCharts} />}
        {tab === 'cpu' && <CpuDetail snapshot={snapshot} points={points} animateChart={animateCharts} />}
        {tab === 'network' && <NetworkDetail snapshot={snapshot} />}
        {tab === 'processes' && <ProcessBlocks snapshot={snapshot} terminatingPid={terminatingPid} onRequestTerminate={onRequestTerminate} />}
        {tab === 'terminal' && <SshTerminal serverId={server.id} serverName={server.name} />}
      </div>
      {showConnectionSheet && <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && setShowConnectionSheet(false)}>
        <section className="sheet connection-sheet" role="dialog" aria-modal="true" aria-labelledby="connection-sheet-title">
          <header className="sheet__header"><div><p className="eyebrow">服务器</p><h2 id="connection-sheet-title">连接</h2></div><button className="icon-button" onClick={() => setShowConnectionSheet(false)} aria-label="关闭"><X size={18} /></button></header>
          <div className="connection-sheet__body"><ConnectionView server={server} snapshot={snapshot} nvidiaWarningIgnored={nvidiaWarningIgnored} ignoredGpuMemoryStallWarningIds={ignoredGpuMemoryStallWarningIds} onRestoreNvidiaWarning={onRestoreNvidiaWarning} onRestoreGpuMemoryStallWarning={onRestoreGpuMemoryStallWarning} onRefresh={onRefresh} onDelete={onDelete} onEdit={() => { setShowConnectionSheet(false); onEdit() }} isRefreshing={isRefreshing} /></div>
        </section>
      </div>}
    </div>
  )
}

function MetricCard({ icon, label, value, foot, tone, emphasisFoot = false }: { icon: React.ReactNode; label: string; value: string; foot: string; tone: string; emphasisFoot?: boolean }) {
  return <article className="metric-card"><span className={`metric-card__icon metric-card__icon--${tone}`}>{icon}</span><div><span className="metric-card__label">{label}</span><strong>{value}</strong><small className={emphasisFoot ? 'metric-card__own' : ''}>{foot}</small></div></article>
}

function PanelHeader({ icon, title, subtitle, action }: { icon?: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return <header className="panel__header"><div>{icon && <span>{icon}</span>}<div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div></div>{action}</header>
}

type TelemetryItem = {
  label: string
  value: string
  tone?: 'normal' | 'warning' | 'critical'
}

function TelemetryGrid({ items, compact = false }: { items: Array<TelemetryItem | null | false | undefined>; compact?: boolean }) {
  const visibleItems = items.filter(Boolean) as TelemetryItem[]
  if (!visibleItems.length) return null
  return <div className={`resource-telemetry${compact ? ' resource-telemetry--compact' : ''}`}>
    {visibleItems.map((item) => <span className={item.tone && item.tone !== 'normal' ? `is-${item.tone}` : undefined} key={item.label}><small>{item.label}</small><strong title={item.value}>{item.value}</strong></span>)}
  </div>
}

function ServerOverview({ snapshot, points, idleThreshold, onSelectGpu, onOpenCpu, onRequestTerminate, terminatingPid, animateCharts, gpuMemoryWarnings }: { snapshot: Snapshot; points: HistoryPoint[]; idleThreshold: number; onSelectGpu: (gpuUuid: string) => void; onOpenCpu: () => void; onRequestTerminate: (target: ProcessTerminationTarget) => void; terminatingPid?: number; animateCharts: boolean; gpuMemoryWarnings: GpuMemoryStallWarning[] }) {
  const accelerator = acceleratorLabel(snapshot)
  const readableGpus = snapshot.gpus.filter(isGpuAvailable)
  const totalMemoryMb = readableGpus.reduce((sum, gpu) => sum + Math.max(0, gpu.memoryTotalMb), 0)
  const usedMemoryMb = readableGpus.reduce((sum, gpu) => sum + Math.max(0, gpu.memoryUsedMb), 0)
  const gpuAverage = readableGpus.length ? readableGpus.reduce((sum, gpu) => sum + clampPercent(gpu.utilization), 0) / readableGpus.length : 0
  const idleCount = snapshot.gpus.filter((gpu) => isGpuIdle(gpu, idleThreshold)).length
  const systemMemoryPercent = snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0
  const modules = {
    metrics: <section className="metric-grid">
      <MetricCard icon={<Zap />} label={`可用 ${accelerator}`} value={`${idleCount} / ${snapshot.gpus.length}`} foot="显存低于 1% 且核心空闲" tone="green" />
      <MetricCard icon={<MemoryStick />} label={`${accelerator} 显存`} value={`${(usedMemoryMb / 1024).toFixed(1)} GB`} foot={`共 ${(totalMemoryMb / 1024).toFixed(1)} GB`} tone="purple" />
      <MetricCard icon={<Gauge />} label={`${accelerator} 平均 UTL`} value={`${gpuAverage.toFixed(1)}%`} foot={`${readableGpus.length} 块可读取 · 共 ${snapshot.gpus.length} 块`} tone={gpuLoadAccent(gpuAverage)} />
      <MetricCard icon={<TerminalSquare />} label="当前进程" value={`${snapshot.processes.length + snapshot.cpuProcesses.length} 个进程`} foot={`${accelerator} ${snapshot.processes.length} · CPU ${snapshot.cpuProcesses.length}${[...snapshot.processes, ...snapshot.cpuProcesses].some((process) => process.isCurrentUser) ? ' · 包含你的任务' : ''}`} tone="orange" emphasisFoot={[...snapshot.processes, ...snapshot.cpuProcesses].some((process) => process.isCurrentUser)} />
    </section>,
    resources: <section className="overview-section" aria-labelledby="overview-resource-title">
      <div className="overview-section__header"><Gauge size={17} /><div><h2 id="overview-resource-title">{accelerator} 与 CPU 状态</h2></div></div>
      <div className="gpu-grid">{snapshot.gpus.map((gpu) => <GpuCard key={gpu.uuid} gpu={gpu} accelerator={accelerator} processes={snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid)} warning={gpuMemoryWarnings.find((warning) => warning.gpuUuid === gpu.uuid)} onOpen={() => onSelectGpu(gpu.uuid)} />)}<CpuOverviewCard snapshot={snapshot} memoryPercent={systemMemoryPercent} onOpen={onOpenCpu} /></div>
    </section>,
    trends: <section className="overview-section" aria-labelledby="overview-trends-title">
      <div className="overview-section__header"><Activity size={17} /><div><h2 id="overview-trends-title">实时趋势</h2><p>CPU、{accelerator} 显存、系统内存与 Swap、{accelerator} 核心利用率</p></div></div>
      <div className="trend-grid">
        <section className="panel panel--mini-chart"><PanelHeader title="CPU UTL" /><TrendChart points={points} snapshot={snapshot} mode="cpu" height={170} animate={animateCharts} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title={`${accelerator} MEM`} /><TrendChart points={points} snapshot={snapshot} mode="gpuMemory" height={170} animate={animateCharts} seriesOpacity={0.9} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title="系统 MEM / SWP" /><TrendChart points={points} snapshot={snapshot} mode="systemMemory" height={170} animate={animateCharts} /></section>
        <section className="panel panel--mini-chart"><PanelHeader title={`${accelerator} UTL`} /><TrendChart points={points} snapshot={snapshot} mode="gpu" height={170} animate={animateCharts} seriesOpacity={0.9} /></section>
      </div>
    </section>,
    processes: <ProcessBlocks snapshot={snapshot} compact currentLabels terminatingPid={terminatingPid} onRequestTerminate={onRequestTerminate} />,
  }

  return <div className="overview-stack">{modules.metrics}{modules.resources}{modules.processes}{modules.trends}</div>
}

function GpuCard({ gpu, accelerator, processes, warning, onOpen }: { gpu: Snapshot['gpus'][number]; accelerator: string; processes: Snapshot['processes']; warning?: GpuMemoryStallWarning; onOpen: () => void }) {
  const [showWarning, setShowWarning] = useState(false)
  const warningButtonRef = useRef<HTMLButtonElement>(null)
  const closeWarning = () => {
    setShowWarning(false)
    requestAnimationFrame(() => warningButtonRef.current?.focus())
  }
  if (!isGpuAvailable(gpu)) return (
    <button className="panel gpu-card gpu-card--unavailable" onClick={onOpen}>
      <PanelHeader title={`${accelerator} ${gpu.index}`} subtitle={gpu.name.replace('Unavailable GPU ', '')} action={<ChevronRight size={16} />} />
      <div className="gpu-unavailable"><AlertCircle size={19} /><div><strong>无法读取</strong><p>此显卡当前未返回监控数据，不计入空闲算力。</p></div></div>
    </button>
  )
  const memoryPercent = gpuMemoryPercent(gpu)
  const displayedMemoryPercent = displayedGpuMemoryPercent(memoryPercent)
  const memoryLevel = gpuMemoryLevel(memoryPercent)
  const ownMemoryMb = processes.filter((process) => process.isCurrentUser).reduce((sum, process) => sum + process.memoryUsedMb, 0)
  const ownMemoryPercent = gpu.memoryTotalMb ? ownMemoryMb / gpu.memoryTotalMb * 100 : 0
  const totalSmUtilization = aggregateGpuSmUtilization(processes)
  return (
    <article className={`panel gpu-card gpu-card--${memoryLevel}${warning ? ' gpu-card--warning' : ''}`}>
      <button type="button" className="gpu-card__open" onClick={onOpen} aria-label={`查看 ${accelerator} ${gpu.index} 详情`} />
      <PanelHeader title={`${accelerator} ${gpu.index}`} subtitle={gpu.name.replace('NVIDIA ', '')} action={<span className="gpu-card__header-actions">{warning && <button ref={warningButtonRef} type="button" className="gpu-card__warning" aria-label={`查看 ${accelerator} ${gpu.index} 异常详情`} title="查看具体问题" onClick={() => setShowWarning(true)}><AlertCircle size={17} /></button>}<ChevronRight size={16} aria-hidden="true" /></span>} />
      <MetricBar label="MEM" value={displayedMemoryPercent} detail={`${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(0)} GB`} accent="purple" currentUserValue={ownMemoryPercent} currentUserDetail={`${(ownMemoryMb / 1024).toFixed(1)} GB`} />
      <MetricBar label="UTL" value={clampPercent(gpu.utilization)} accent={gpuLoadAccent(gpu.utilization)} />
      <TelemetryGrid compact items={[
        { label: '可用显存', value: `${(Math.max(0, gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024).toFixed(1)} GB` },
        { label: 'MBW', value: `${clampPercent(gpu.memoryUtilization).toFixed(0)}%` },
        { label: 'SM', value: `${totalSmUtilization.toFixed(0)}%` },
        { label: '功率 / 上限', value: gpu.powerLimitWatts ? `${gpu.powerWatts.toFixed(0)} / ${gpu.powerLimitWatts.toFixed(0)} W` : `${gpu.powerWatts.toFixed(0)} W` },
        { label: '温度', value: `${gpu.temperatureCelsius}°C` },
        Boolean(gpu.performanceState) && { label: 'P-State', value: gpu.performanceState! },
        gpu.smClockMhz !== undefined && gpu.smClockMhz > 0 && { label: 'SM 频率', value: formatClock(gpu.smClockMhz) },
        { label: '进程', value: `${processes.length} 个` },
      ]} />
      {showWarning && warning && <GpuMemoryWarningDialog warning={warning} accelerator={accelerator} onClose={closeWarning} />}
    </article>
  )
}

function GpuMemoryWarningDialog({ warning, accelerator, onClose }: { warning: GpuMemoryStallWarning; accelerator: string; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])
  const durationHours = Math.floor(warning.durationSeconds / 3600)
  const durationMinutes = Math.max(1, Math.floor(warning.durationSeconds / 60))
  const duration = durationHours > 0 ? `${durationHours} 小时` : `${durationMinutes} 分钟`
  const hasDefunctProcesses = warning.defunctProcesses.length > 0
  return (
    <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet gpu-warning-sheet" role="dialog" aria-modal="true" aria-labelledby="gpu-warning-title">
        <header className="sheet__header"><div><p className="eyebrow">{accelerator} 异常</p><h2 id="gpu-warning-title">{warning.serverName} · {accelerator} {warning.gpuIndex} · {warning.gpuName.replace('NVIDIA ', '')}</h2></div><button autoFocus className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <div className="gpu-warning-body">
          <span className="gpu-warning-body__icon"><AlertCircle size={23} /></span>
          <div><strong>{hasDefunctProcesses ? '检测到僵尸进程占用显存' : `显存持续占用，但 ${accelerator} 利用率为 0`}</strong><p>{hasDefunctProcesses ? '进程已经退出但仍残留显存占用，建议检查并清理对应父进程。' : '任务可能正在等待数据、排队或已经停止计算，请核对进程状态。'}</p></div>
          <dl>
            <div><dt>{accelerator}</dt><dd>{warning.gpuName.replace('NVIDIA ', '')}</dd></div>
            <div><dt>显存</dt><dd>{(warning.memoryUsedMb / 1024).toFixed(1)} / {(warning.memoryTotalMb / 1024).toFixed(1)} GB</dd></div>
            <div><dt>持续时间</dt><dd>{duration}</dd></div>
            <div><dt>涉及用户</dt><dd>{warning.usernames.length ? warning.usernames.join('、') : '未识别'}</dd></div>
          </dl>
          {hasDefunctProcesses && <div className="gpu-warning-processes"><strong>僵尸进程</strong>{warning.defunctProcesses.map((process) => <span key={process.pid}><code>PID {process.pid}</code><small>{process.username}</small></span>)}</div>}
        </div>
        <footer className="sheet__footer"><button className="button button--primary" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  )
}

function CpuOverviewCard({ snapshot, memoryPercent, onOpen }: { snapshot: Snapshot; memoryPercent: number; onOpen: () => void }) {
  const logicalCores = snapshot.system.cpuLogicalCores
  const normalizedLoad = logicalCores ? snapshot.system.load1 / logicalCores * 100 : null
  return (
    <button className="panel gpu-card cpu-overview-card" onClick={onOpen}>
      <PanelHeader title="CPU" subtitle={snapshot.system.cpuModel || 'CPU'} action={<ChevronRight size={16} />} />
      <MetricBar label="系统 MEM" value={memoryPercent} detail={`${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`} accent="purple" />
      <MetricBar label="CPU UTL" value={snapshot.system.cpuUtilization} currentUserValue={snapshot.system.currentUserCpuUtilization} currentUserDetail={`${snapshot.system.currentUserCpuUtilization.toFixed(1)}%`} />
      <TelemetryGrid compact items={[
        snapshot.system.memoryAvailableBytes !== undefined && { label: '可用内存', value: formatBytes(snapshot.system.memoryAvailableBytes) },
        { label: '负载 / 线程', value: normalizedLoad === null ? snapshot.system.load1.toFixed(2) : `${normalizedLoad.toFixed(1)}%` },
        snapshot.system.cpuPhysicalCores !== undefined && snapshot.system.cpuPhysicalCores > 0 && snapshot.system.cpuLogicalCores !== undefined && snapshot.system.cpuLogicalCores > 0 && { label: '核心 / 线程', value: `${snapshot.system.cpuPhysicalCores} / ${snapshot.system.cpuLogicalCores}` },
        snapshot.system.cpuFrequencyMhz !== undefined && snapshot.system.cpuFrequencyMhz > 0 && { label: '频率 / 上限', value: snapshot.system.cpuMaxFrequencyMhz ? `${formatClock(snapshot.system.cpuFrequencyMhz)} / ${formatClock(snapshot.system.cpuMaxFrequencyMhz)}` : formatClock(snapshot.system.cpuFrequencyMhz) },
        snapshot.system.cpuUserPercent !== undefined && { label: 'User', value: `${snapshot.system.cpuUserPercent.toFixed(1)}%` },
        snapshot.system.cpuSystemPercent !== undefined && { label: 'System', value: `${snapshot.system.cpuSystemPercent.toFixed(1)}%` },
        snapshot.system.cpuIoWaitPercent !== undefined && { label: 'IO Wait', value: `${snapshot.system.cpuIoWaitPercent.toFixed(1)}%`, tone: snapshot.system.cpuIoWaitPercent >= 10 ? 'warning' : 'normal' },
        { label: 'Swap', value: formatBytes(snapshot.system.swapUsedBytes) },
      ]} />
    </button>
  )
}

function GpuDetail({ snapshot, points, selectedGpuUuid, animateChart }: { snapshot: Snapshot; points: HistoryPoint[]; selectedGpuUuid: string | null; onSelectGpu: (gpuUuid: string) => void; animateChart: boolean }) {
  const accelerator = acceleratorLabel(snapshot)
  const orderedGpus = snapshot.gpus
  const [expanded, setExpanded] = useState<{ uuid: string; mode: 'sm' | 'processes' } | null>(() => selectedGpuUuid ? { uuid: selectedGpuUuid, mode: 'sm' } : null)
  useEffect(() => { if (selectedGpuUuid) setExpanded({ uuid: selectedGpuUuid, mode: 'sm' }) }, [selectedGpuUuid])
  const toggleExpanded = (uuid: string, mode: 'sm' | 'processes') => setExpanded((current) => current?.uuid === uuid && current.mode === mode ? null : { uuid, mode })
  return <div className="content-stack">
    <section className="resource-trend-grid">{orderedGpus.filter(isGpuAvailable).map((gpu) => <ResourceTrend key={gpu.uuid} snapshot={snapshot} kind="gpu" gpuUuid={gpu.uuid} title={`${accelerator} ${gpu.index} · ${gpu.name.replace('NVIDIA ', '')}`} animate={animateChart} />)}</section>
    <section className="gpu-detail-list">{orderedGpus.map((gpu) => {
      if (!isGpuAvailable(gpu)) return <article className="panel gpu-detail gpu-detail--unavailable" key={gpu.uuid}><div className="gpu-detail__title"><div><span>{accelerator} {gpu.index}</span><h3>{gpu.name}</h3><small>{gpu.uuid.replace('unavailable-', '').replaceAll('_', ':')}</small></div><strong>无法读取</strong></div><div className="gpu-unavailable"><AlertCircle size={19} /><div><strong>监控数据不可用</strong><p>健康 {accelerator} 仍会继续采集；此卡不参与利用率汇总和空闲判断。</p></div></div></article>
      const gpuProcesses = snapshot.processes.filter((process) => process.gpuUuid === gpu.uuid)
      const attributedMemoryMb = gpuProcesses.reduce((sum, process) => sum + Math.max(0, process.memoryUsedMb), 0)
      const unattributedMemoryMb = Math.max(0, gpu.memoryUsedMb - attributedMemoryMb)
      const hasUnattributedMemory = unattributedMemoryMb >= 256
      const ownMemoryMb = gpuProcesses.filter((process) => process.isCurrentUser).reduce((sum, process) => sum + process.memoryUsedMb, 0)
      const totalSmUtilization = aggregateGpuSmUtilization(gpuProcesses)
      const memory = gpuMemoryPercent(gpu)
      const isExpanded = expanded?.uuid === gpu.uuid
      return <article className={`panel gpu-detail gpu-detail--${gpuMemoryLevel(memory)} ${isExpanded ? 'is-selected' : ''}`} key={gpu.uuid}>
        <div className="gpu-detail__title"><div><span>{accelerator} {gpu.index}{isExpanded ? ' · 已展开' : ''}</span><h3>{gpu.name}</h3><small>{gpu.uuid}</small></div><strong>{displayedGpuMemoryPercent(memory)}%<small> MEM</small></strong></div>
        <div className="gpu-detail__meters"><MetricBar label="MEM" value={displayedGpuMemoryPercent(memory)} detail={`${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(1)} GB`} accent="purple" /><MetricBar label="UTL" value={gpu.utilization} accent={gpuLoadAccent(gpu.utilization)} /></div>
        <div className="stat-row stat-row--gpu"><span><small>MBW</small><strong>{clampPercent(gpu.memoryUtilization).toFixed(0)}%</strong></span><span><small>温度</small><strong>{gpu.temperatureCelsius}°C</strong></span><span><small>功耗</small><strong>{gpu.powerWatts.toFixed(1)} W</strong></span><button type="button" className={expanded?.uuid === gpu.uuid && expanded.mode === 'processes' ? 'is-active' : ''} aria-expanded={expanded?.uuid === gpu.uuid && expanded.mode === 'processes'} onClick={() => toggleExpanded(gpu.uuid, 'processes')}><small>进程</small><strong>{gpuProcesses.length}</strong></button><button type="button" className={expanded?.uuid === gpu.uuid && expanded.mode === 'sm' ? 'is-active' : ''} aria-expanded={expanded?.uuid === gpu.uuid && expanded.mode === 'sm'} onClick={() => toggleExpanded(gpu.uuid, 'sm')}><small>SM</small><strong>{totalSmUtilization.toFixed(0)}%</strong></button></div>
        <TelemetryGrid items={[
          { label: '可用显存', value: `${(Math.max(0, gpu.memoryTotalMb - gpu.memoryUsedMb) / 1024).toFixed(1)} GB` },
          gpu.powerLimitWatts !== undefined && gpu.powerLimitWatts > 0 && { label: '功率上限', value: `${gpu.powerLimitWatts.toFixed(0)} W` },
          gpu.smClockMhz !== undefined && gpu.smClockMhz > 0 && { label: 'SM 频率', value: formatClock(gpu.smClockMhz) },
          gpu.memoryClockMhz !== undefined && gpu.memoryClockMhz > 0 && { label: '显存频率', value: formatClock(gpu.memoryClockMhz) },
          Boolean(gpu.performanceState) && { label: 'P-State', value: gpu.performanceState! },
          gpu.fanSpeedPercent !== undefined && { label: '风扇', value: `${gpu.fanSpeedPercent.toFixed(0)}%` },
          Boolean(gpu.throttleReason) && { label: '限频状态', value: gpu.throttleReason!, tone: gpu.throttleReason === '正常' || gpu.throttleReason === '空闲' ? 'normal' : 'warning' },
          gpu.eccErrors !== undefined && { label: 'ECC 错误', value: `${gpu.eccErrors}`, tone: gpu.eccErrors > 0 ? 'critical' : 'normal' },
        ]} />
        {isExpanded && <div className="gpu-detail__processes"><header><strong>{expanded.mode === 'sm' ? '进程 SM 活跃率' : `${accelerator} ${gpu.index} 进程`}</strong><small>{expanded.mode === 'sm' ? '单次 pmon 采样，不代表算法效率' : `${gpuProcesses.length} 个计算进程`}</small></header>{gpuProcesses.length ? gpuProcesses.map((process) => <div key={process.pid}><code>PID {process.pid}</code><span title={process.command}>{process.command}</span><strong>{expanded.mode === 'sm' ? `SM ${clampPercent(process.smUtilization ?? 0).toFixed(0)}%` : `${(process.memoryUsedMb / 1024).toFixed(1)} GB`}</strong></div>) : <p className="gpu-detail__empty">{hasUnattributedMemory ? `检测到 ${(unattributedMemoryMb / 1024).toFixed(1)} GB 显存占用，但 ${accelerator === 'NPU' ? 'NPU 驱动' : 'NVIDIA 驱动'}未返回可映射的 PID` : `当前没有 ${accelerator} 计算进程`}</p>}</div>}
        {ownMemoryMb > 0 && <div className="gpu-detail__own"><UserRound size={13} /><strong>你的任务</strong><span>占用 {(ownMemoryMb / 1024).toFixed(1)} GB 显存</span></div>}
      </article>
    })}</section>
  </div>
}

function CpuDetail({ snapshot, points, animateChart }: { snapshot: Snapshot; points: HistoryPoint[]; animateChart: boolean }) {
  const memoryPercent = snapshot.system.memoryTotalBytes ? snapshot.system.memoryUsedBytes / snapshot.system.memoryTotalBytes * 100 : 0
  return <div className="content-stack"><ResourceTrend snapshot={snapshot} kind="cpu" title={snapshot.system.cpuModel || 'CPU'} animate={animateChart} /><section className="panel system-resource-panel"><PanelHeader icon={<MemoryStick />} title="系统资源" /><div className="resource-bars"><MetricBar label="CPU" value={snapshot.system.cpuUtilization} currentUserValue={snapshot.system.currentUserCpuUtilization} currentUserDetail={`${snapshot.system.currentUserCpuUtilization.toFixed(1)}%`} /><MetricBar label="内存" value={memoryPercent} detail={`${formatBytes(snapshot.system.memoryUsedBytes)} / ${formatBytes(snapshot.system.memoryTotalBytes)}`} accent="purple" /></div><div className="stat-row stat-row--border"><span><small>1 分钟负载</small><strong>{snapshot.system.load1.toFixed(2)}</strong></span><span><small>5 分钟负载</small><strong>{snapshot.system.load5.toFixed(2)}</strong></span><span><small>15 分钟负载</small><strong>{snapshot.system.load15.toFixed(2)}</strong></span><span><small>Swap</small><strong>{formatBytes(snapshot.system.swapUsedBytes)}</strong></span></div><TelemetryGrid items={[
    snapshot.system.cpuPhysicalCores !== undefined && snapshot.system.cpuPhysicalCores > 0 && snapshot.system.cpuLogicalCores !== undefined && snapshot.system.cpuLogicalCores > 0 && { label: '核心 / 线程', value: `${snapshot.system.cpuPhysicalCores} / ${snapshot.system.cpuLogicalCores}` },
    snapshot.system.cpuFrequencyMhz !== undefined && snapshot.system.cpuFrequencyMhz > 0 && { label: '当前频率', value: formatClock(snapshot.system.cpuFrequencyMhz) },
    snapshot.system.cpuMaxFrequencyMhz !== undefined && snapshot.system.cpuMaxFrequencyMhz > 0 && { label: '最高频率', value: formatClock(snapshot.system.cpuMaxFrequencyMhz) },
    snapshot.system.cpuUserPercent !== undefined && { label: 'User', value: `${snapshot.system.cpuUserPercent.toFixed(1)}%` },
    snapshot.system.cpuSystemPercent !== undefined && { label: 'System', value: `${snapshot.system.cpuSystemPercent.toFixed(1)}%` },
    snapshot.system.cpuIoWaitPercent !== undefined && { label: 'IO Wait', value: `${snapshot.system.cpuIoWaitPercent.toFixed(1)}%`, tone: snapshot.system.cpuIoWaitPercent >= 10 ? 'warning' : 'normal' },
    snapshot.system.cpuStealPercent !== undefined && { label: 'Steal', value: `${snapshot.system.cpuStealPercent.toFixed(1)}%`, tone: snapshot.system.cpuStealPercent >= 5 ? 'warning' : 'normal' },
    snapshot.system.memoryAvailableBytes !== undefined && { label: '可用内存', value: formatBytes(snapshot.system.memoryAvailableBytes) },
    snapshot.system.memoryCacheBytes !== undefined && { label: '缓存', value: formatBytes(snapshot.system.memoryCacheBytes) },
    snapshot.system.cpuTemperatureCelsius !== undefined && { label: 'CPU 温度', value: `${snapshot.system.cpuTemperatureCelsius.toFixed(0)}°C`, tone: snapshot.system.cpuTemperatureCelsius >= 85 ? 'critical' : snapshot.system.cpuTemperatureCelsius >= 75 ? 'warning' : 'normal' },
  ]} /></section></div>
}

function NetworkDetail({ snapshot }: { snapshot: Snapshot }) {
  const network = snapshot.network ?? { downloadBytesPerSecond: 0, uploadBytesPerSecond: 0, users: [], userBreakdownSupported: false, usersSampled: false }
  const users = network.users ?? []
  const own = users.find((user) => user.username === snapshot.username)
  const peak = Math.max(1, ...users.map((user) => user.downloadBytesPerSecond + user.uploadBytesPerSecond))
  return <div className="content-stack network-detail">
    <section className="network-speed-grid">
      <article className="panel network-speed-card"><span className="network-speed-card__icon"><Download /></span><div><small>整机下载</small><strong>{formatNetworkRate(network.downloadBytesPerSecond)}</strong><span>默认路由网卡实时接收速率</span></div></article>
      <article className="panel network-speed-card"><span className="network-speed-card__icon"><Upload /></span><div><small>整机上传</small><strong>{formatNetworkRate(network.uploadBytesPerSecond)}</strong><span>默认路由网卡实时发送速率</span></div></article>
      <article className="panel network-speed-card network-speed-card--own"><span className="network-speed-card__icon"><UserRound /></span><div><small>当前用户 · {snapshot.username}</small><strong>{own ? `↓ ${formatNetworkRate(own.downloadBytesPerSecond)} · ↑ ${formatNetworkRate(own.uploadBytesPerSecond)}` : '暂无活跃传输'}</strong><span>{network.userBreakdownSupported ? 'TCP 用户明细约每 5 秒刷新' : '当前只能读取整机流量'}</span></div></article>
    </section>
    <section className="panel network-users-panel">
      <PanelHeader icon={<Network />} title="用户上传 / 下载" subtitle={network.userBreakdownSupported ? '按已建立 TCP 连接的内核计数估算；不包含 UDP，受系统 socket 可见权限影响' : '服务器当前未提供可用的 socket 字节计数；整机速率仍可正常显示'} />
      {network.userBreakdownSupported && users.length > 0 ? <div className="network-user-table" role="table" aria-label="用户网络速率">
        <div className="network-user-row network-user-row--head" role="row"><span>用户</span><span>下载</span><span>上传</span><span>TCP 连接</span></div>
        {users.map((user) => {
          const total = user.downloadBytesPerSecond + user.uploadBytesPerSecond
          return <div className={`network-user-row${user.username === snapshot.username ? ' is-own' : ''}`} role="row" key={`${user.uid}:${user.username}`} style={{ '--network-share': `${Math.max(2, total / peak * 100)}%` } as React.CSSProperties}>
            <span><strong>{user.username}</strong>{user.username === snapshot.username && <small>你</small>}<i /></span>
            <span>{formatNetworkRate(user.downloadBytesPerSecond)}</span>
            <span>{formatNetworkRate(user.uploadBytesPerSecond)}</span>
            <span>{user.connectionCount}</span>
          </div>
        })}
      </div> : <div className="network-users-empty"><Network size={22} /><strong>{network.userBreakdownSupported ? '当前没有检测到活跃的 TCP 用户流量' : '用户级网络统计不可用'}</strong><p>{network.userBreakdownSupported ? '整机上传下载仍会持续刷新；出现可归属的 TCP 传输后会自动列出用户。' : '这不会影响整机上传、下载速度监控。'}</p></div>}
    </section>
  </div>
}

function ConnectionView({ server, snapshot, nvidiaWarningIgnored, ignoredGpuMemoryStallWarningIds, onRestoreNvidiaWarning, onRestoreGpuMemoryStallWarning, onRefresh, onDelete, onEdit, isRefreshing }: { server: Server; snapshot: Snapshot; nvidiaWarningIgnored: boolean; ignoredGpuMemoryStallWarningIds: Set<string>; onRestoreNvidiaWarning: () => void; onRestoreGpuMemoryStallWarning: (warningId: string) => void; onRefresh: () => void; onDelete: () => void; onEdit: () => void; isRefreshing: boolean }) {
  const accelerator = acceleratorLabel(snapshot)
  const canRestoreNvidiaWarning = nvidiaWarningIgnored && snapshot.nvidiaSmi !== 'available'
  const ignoredMemoryWarnings = ignoredGpuMemoryStallGpus(server.id, snapshot, ignoredGpuMemoryStallWarningIds)
  const ignoredCount = ignoredMemoryWarnings.length + (canRestoreNvidiaWarning ? 1 : 0)
  return <div className="content-stack"><section className="panel connection-panel"><PanelHeader icon={<KeyRound />} title="SSH 连接" subtitle="认证信息仅在本机使用" /><dl className="definition-list"><div><dt>连接地址</dt><dd className="mono">{server.username}@{server.host}:{server.port}</dd></div><div><dt>认证</dt><dd>{server.authMethod === 'sshConfig' ? 'SSH Config' : '系统钥匙串密码'}</dd></div></dl><div className="panel__actions"><button className="button button--primary" onClick={onRefresh} disabled={isRefreshing}><RefreshCw size={16} className={isRefreshing ? 'spin' : ''} />测试并重新连接</button><button className="button button--secondary" onClick={onEdit}><Settings size={16} />编辑配置</button></div></section>{ignoredCount > 0 && <section className="panel ignored-warning-list"><PanelHeader icon={<BellOff />} title={`已忽略的 ${accelerator} 提醒`} subtitle={`${ignoredCount} 项提醒仅在此处保留`} /><div>{canRestoreNvidiaWarning && <div className="ignored-warning-row"><div><strong>GPU 读取异常</strong><p>不可读取的显卡仍会显示，但服务器状态暂按在线处理。</p></div><button className="button button--secondary button--small" onClick={onRestoreNvidiaWarning}><Bell size={14} />恢复提醒</button></div>}{ignoredMemoryWarnings.map((gpu) => <div className="ignored-warning-row" key={gpu.uuid}><div><strong>{accelerator} {gpu.index} · {gpu.name.replace(/^NVIDIA\s+/i, '')} 显存占用预警</strong><p>当前占用 {(gpu.memoryUsedMb / 1024).toFixed(1)} / {(gpu.memoryTotalMb / 1024).toFixed(1)} GB，UTL {clampPercent(gpu.utilization).toFixed(0)}%。</p></div><button className="button button--secondary button--small" onClick={() => onRestoreGpuMemoryStallWarning(`gpu-memory-stall:${server.id}:${gpu.uuid}`)}><Bell size={14} />恢复提醒</button></div>)}</div></section>}<section className="panel danger-zone"><div><strong>删除服务器</strong><p>删除本机记录、历史数据、远端采集进程和服务器用户目录中的 Termio 数据。</p></div><button className="button button--danger" onClick={onDelete}><Trash2 size={16} />删除</button></section></div>
}

function NvidiaWarning({ snapshot, onRefresh, onIgnore }: { snapshot: Snapshot; onRefresh: () => void; onIgnore: () => void }) {
  const [working, setWorking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const command = snapshot.osId === 'ubuntu' ? 'sudo apt update && sudo apt install -y ubuntu-drivers-common && sudo ubuntu-drivers autoinstall' : snapshot.osId === 'debian' ? 'sudo apt update && sudo apt install -y nvidia-driver' : 'command -v nvidia-smi || echo "请参考 NVIDIA 官方驱动文档安装适合当前发行版的驱动"'
  const installable = canOfferNvidiaDriverInstall(snapshot.nvidiaSmi)
  const guidance = nvidiaIssueGuidance(snapshot.nvidiaSmi)
  const copyCommand = async () => {
    try { await navigator.clipboard.writeText(command); setMessage('安装命令已复制') } catch { setMessage('无法访问剪贴板，请手动选择命令复制') }
  }
  const install = async () => {
    if (!window.confirm(`Termio 将在 ${snapshot.osName} 上安装 NVIDIA 驱动包。继续吗？`)) return
    if (!window.confirm('该操作会通过 sudo 修改服务器软件包，且可能需要重启。确认执行？')) return
    setWorking(true)
    try { setMessage(await api.installNvidiaDriver(snapshot.serverId)) } catch (error) { setMessage(String(error)) } finally { setWorking(false) }
  }
  const supported = installable && (snapshot.osId === 'ubuntu' || snapshot.osId === 'debian')
  return <section className="nvidia-warning"><AlertCircle size={20} /><div><strong>{nvidiaIssueTitle(snapshot.nvidiaSmi)}</strong><p>{snapshot.nvidiaMessage || guidance}</p>{snapshot.nvidiaMessage && <small>{guidance}</small>}<small>检测到：{snapshot.osName}</small>{installable && <details open><summary>适用的安装命令</summary><code>{command}</code><small>驱动安装通常需要重启。自动安装只支持 Ubuntu / Debian，并且必须通过两次确认。</small></details>}{message && <p className="nvidia-warning__message" role="status">{message}</p>}<div className="nvidia-warning__actions">{supported && <button className="button button--primary button--small" disabled={working} onClick={() => void install()}>{working ? '安装中…' : '帮助安装'}</button>}{installable && <button className="button button--secondary button--small" onClick={() => void copyCommand()}>复制命令</button>}<button className="button button--secondary button--small" onClick={onRefresh}>重新检测</button><button className="button button--secondary button--small" onClick={onIgnore}><BellOff size={13} />忽略此提醒</button></div></div></section>
}

interface FleetTotals {
  online: number
  offline: number
  gpus: number
  idle: number
  latestRefresh: number | null
}

function MasonryItem({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const resize = () => {
      const grid = element.parentElement
      if (!grid) return
      const style = getComputedStyle(grid)
      const row = Number.parseFloat(style.gridAutoRows) || 4
      const gap = Number.parseFloat(style.rowGap) || 12
      element.style.gridRowEnd = `span ${Math.ceil((element.getBoundingClientRect().height + gap) / (row + gap))}`
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [])
  return <div className="masonry-item" ref={ref}>{children}</div>
}

function FleetOverview({ servers, snapshots, settings, totals, onSelect }: { servers: Server[]; snapshots: Record<string, Snapshot>; settings: AppSettings | null; totals: FleetTotals; onSelect: (serverId: string, tab: DetailTab, gpuUuid?: string) => void }) {
  const orderedServers = [...servers].sort((left, right) => {
    const byName = left.name.trim().localeCompare(right.name.trim(), 'zh-CN', { numeric: true, sensitivity: 'base' })
    return byName || left.id.localeCompare(right.id)
  })
  return <div className="detail-page fleet-page">
    <div className="fleet-toolbar">
      <section className="fleet-summary" aria-label="全局资源摘要">
        <span><ServerIcon size={16} /><strong>{totals.online}</strong><small>在线服务器</small></span>
        <span><WifiOff size={16} /><strong>{totals.offline}</strong><small>离线服务器</small></span>
        <span><Zap size={16} /><strong>{totals.idle} / {totals.gpus}</strong><small>空闲加速卡 / 加速卡总数</small></span>
      </section>
    </div>
    <section className="fleet-grid" aria-label="服务器加速卡状态墙">
      {orderedServers.map((server) => {
        const snapshot = snapshots[server.id]
        const accelerator = snapshot ? acceleratorLabel(snapshot) : 'GPU'
        return <MasonryItem key={server.id}><article className={`panel fleet-card fleet-card--${server.status}`}>
          <button className="fleet-card__header" onClick={() => onSelect(server.id, 'overview')}>
            <span className={`server-row__status server-row__status--${server.status}`} />
            <span><strong>{server.name}</strong><small>{snapshot ? `${snapshot.username}@${snapshot.hostname}` : `${server.username}@${server.host}`}</small></span>
            <StatusPill status={server.status} />
            <ChevronRight size={15} />
          </button>
          {snapshot ? <>
            <div className="fleet-system">
              <button onClick={() => onSelect(server.id, 'cpu')}><span>CPU</span><strong>{clampPercent(snapshot.system.cpuUtilization).toFixed(0)}%</strong><i><b style={{ width: `${clampPercent(snapshot.system.cpuUtilization)}%` }} /></i></button>
            </div>
            <div className="fleet-gpus">
              <div className="fleet-gpus__labels"><span>设备</span><span>显存</span><span>{accelerator}</span></div>
              {snapshot.gpus.map((gpu) => {
                if (!isGpuAvailable(gpu)) return <button className="fleet-gpu-row fleet-gpu-row--unavailable" key={gpu.uuid} onClick={() => onSelect(server.id, 'gpu', gpu.uuid)}>
                  <span><strong>{accelerator} {gpu.index}</strong><small>{gpu.name.replace('Unavailable GPU ', '')}</small></span>
                  <span>无法读取</span>
                  <span>—</span>
                </button>
                const memory = gpuMemoryPercent(gpu)
                const displayedMemory = displayedGpuMemoryPercent(memory)
                const ownProcess = snapshot.processes.some((process) => process.gpuUuid === gpu.uuid && process.isCurrentUser)
                const loadLevel = gpuLoadLevel(gpu.utilization)
                const memoryLevel = gpuMemoryLevel(memory)
                return <button className={`fleet-gpu-row fleet-gpu-row--${memoryLevel}`} style={{ '--memory-fill': `${displayedMemory}%` } as React.CSSProperties} key={gpu.uuid} onClick={() => onSelect(server.id, 'gpu', gpu.uuid)}>
                  <span><strong>{accelerator} {gpu.index}</strong><small>{gpu.name.replace('NVIDIA ', '').replace('GeForce ', '')}</small></span>
                  <span>{displayedMemory}%<small>{(gpu.memoryUsedMb / 1024).toFixed(1)}G</small></span>
                  <span className={`fleet-gpu-row__load fleet-gpu-row__load--${loadLevel}`}>{clampPercent(gpu.utilization).toFixed(0)}%</span>
                  {ownProcess && <em title="有你的任务"><UserRound size={11} />你</em>}
                </button>
              })}
              {snapshot.gpus.length === 0 && <button className="fleet-no-gpu" onClick={() => onSelect(server.id, 'overview')}><AlertCircle size={14} />未检测到受支持的加速卡</button>}
            </div>
            <footer className="fleet-card__footer"><span>{snapshot.gpus.filter((gpu) => isGpuIdle(gpu, settings?.idleGpuThreshold ?? 10)).length} 张 {accelerator} 空闲</span><time>{relativeTime(snapshot.timestamp)}</time></footer>
          </> : <div className="fleet-loading"><RefreshCw size={16} /><span>{server.lastError || '等待首次采样'}</span></div>}
        </article></MasonryItem>
      })}
    </section>
  </div>
}

function IdleGpuView({ snapshots, items: rankedItems, sortRevision, onSelect }: { snapshots: Record<string, Snapshot>; items: IdleGpuItem[]; sortRevision: number; onSelect: (serverId: string, gpuUuid: string) => void }) {
  const orderRef = useRef<{ revision: number; keys: string[] }>({ revision: -1, keys: [] })
  const currentKeys = rankedItems.map(({ server, gpu }) => `${server.id}:${gpu.uuid}`)
  if (orderRef.current.revision !== sortRevision) {
    orderRef.current = { revision: sortRevision, keys: currentKeys }
  } else {
    const currentKeySet = new Set(currentKeys)
    const retained = orderRef.current.keys.filter((key) => currentKeySet.has(key))
    const retainedSet = new Set(retained)
    orderRef.current.keys = [...retained, ...currentKeys.filter((key) => !retainedSet.has(key))]
  }
  const order = new Map(orderRef.current.keys.map((key, index) => [key, index]))
  const items = [...rankedItems].sort((left, right) => (order.get(`${left.server.id}:${left.gpu.uuid}`) ?? Number.MAX_SAFE_INTEGER) - (order.get(`${right.server.id}:${right.gpu.uuid}`) ?? Number.MAX_SAFE_INTEGER))

  return <div className="detail-page idle-page">
    <section className="idle-grid">{items.map(({ server, gpu, available }) => {
      const snapshot = snapshots[server.id]
      const accelerator = snapshot ? acceleratorLabel(snapshot) : 'GPU'
      const freeGpuGb = displayedFreeMemoryGb(gpu.memoryTotalMb - gpu.memoryUsedMb)
      const freeCpuGb = displayedFreeMemoryGb(((snapshot?.system.memoryTotalBytes ?? 0) - (snapshot?.system.memoryUsedBytes ?? 0)) / 1024 ** 2)
      const occupiedProcessCount = countOtherUserGpuWorkloads(gpu, snapshot?.processes ?? [])
      const occupiedDurationSeconds = available ? null : gpuOccupiedDurationSeconds(gpu.uuid, snapshot?.processes ?? [])
      const statusLabel = available ? '空闲' : occupiedDurationSeconds === null ? '使用中' : `使用中 · 已持续 ${formatGpuOccupiedDuration(occupiedDurationSeconds)}`
      return <article className={`panel idle-card ${available ? '' : 'idle-card--unavailable'}`} key={`${server.id}-${gpu.uuid}`}>
        <button className="idle-card__target" onClick={() => onSelect(server.id, gpu.uuid)} aria-label={`查看 ${server.name} ${accelerator} ${gpu.index} 详情`} title={`查看此 ${accelerator} 详情`} />
        <div className="idle-card__body">
          <div className="idle-card__top"><span className={`idle-badge ${available ? '' : 'idle-badge--busy'}`}>{available ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}{statusLabel}</span></div>
          <h3>{server.name} · {accelerator} {gpu.index}</h3><p>{gpu.name} · {snapshot?.system.cpuModel || '未知 CPU'}</p><div className="idle-card__stats"><span><strong>{freeGpuGb.toFixed(1)} GB</strong><small>{accelerator} MEM</small></span><span><strong>{freeCpuGb.toFixed(1)} GB</strong><small>CPU MEM</small></span><span><strong>{occupiedProcessCount > 0 ? `有 ${occupiedProcessCount} 个` : '无'}</strong><small>进程占用</small></span></div>
        </div>
        <div className="idle-card__actions"><button className="icon-button idle-card__detail" onClick={() => onSelect(server.id, gpu.uuid)} aria-label={`打开 ${server.name} ${accelerator} ${gpu.index} 详情`} title="查看详情"><ChevronRight size={15} /></button></div>
      </article>
    })}{items.length === 0 && <div className="inline-empty inline-empty--wide"><WifiOff size={28} /><strong>暂无可展示的加速卡</strong><p>当前服务器没有可读取的 GPU / NPU 设备。</p></div>}</section>
  </div>
}

function SshConfigImportSheet({ drafts, servers, onClose, onSelect }: { drafts: ServerDraft[]; servers: Server[]; onClose: () => void; onSelect: (draft: ServerDraft) => void }) {
  const existing = useMemo(() => new Set(servers.map((server) => `${server.username.toLowerCase()}@${server.host.toLowerCase()}:${server.port}`)), [servers])
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sheet import-sheet" role="dialog" aria-modal="true" aria-labelledby="ssh-import-title">
      <header className="sheet__header"><div><p className="eyebrow">OpenSSH Config</p><h2 id="ssh-import-title">从 SSH Config 导入</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="import-list">
        <p className="import-notice" role="note"><AlertCircle size={15} /><span>导入后默认使用 SSH Config 认证；IdentityFile、ProxyJump、SSH Agent 等配置由系统 OpenSSH 按该 Host 直接处理。</span></p>
        {drafts.map((draft, index) => { const key = `${draft.username.toLowerCase()}@${draft.host.toLowerCase()}:${draft.port}`; const duplicate = existing.has(key); return <button type="button" className={`import-row import-row--button ${duplicate ? 'import-row--duplicate' : ''}`} key={`${draft.name}-${draft.host}-${index}`} disabled={duplicate} onClick={() => onSelect(draft)}><span><strong>{draft.name}</strong><small>{draft.username}@{draft.host}:{draft.port}</small></span><em>{duplicate ? '已存在' : '导入'}</em></button> })}
      </div>
      <footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>取消</button></footer>
    </section>
  </div>
}

export function SettingsSheet({ settings, onClose, onSave }: { settings: AppSettings; onClose: () => void; onSave: (settings: AppSettings) => Promise<void> }) {
  const [value, setValue] = useState(settings)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof AppSettings>(key: K, next: AppSettings[K]) => setValue((current) => ({ ...current, [key]: next }))
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="sheet settings-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="sheet__header"><div><p className="eyebrow">偏好设置</p><h2 id="settings-title">设置</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      <div className="settings-body">
        <SettingsGroup icon={<SlidersHorizontal />} title="外观">
          <label><span><strong className="settings-field-title">主题</strong></span><select value={value.theme} onChange={(event) => set('theme', event.target.value as AppSettings['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
          <label className="switch-row"><span><strong className="settings-field-title">任务标记色</strong></span><input type="color" value={value.currentUserAccent} onChange={(event) => set('currentUserAccent', event.target.value)} /></label>
        </SettingsGroup>
        <SettingsGroup icon={<RefreshCw />} title="采样">
          <label><span><strong className="settings-field-title">后台最低采样间隔</strong></span><span>{value.backgroundSamplingIntervalSeconds} 秒</span><input type="range" min="5" max="120" value={value.backgroundSamplingIntervalSeconds} onChange={(event) => set('backgroundSamplingIntervalSeconds', Number(event.target.value))} /></label>
          <label className="settings-refresh-row"><select aria-label="进程采样间隔" value={value.processIntervalSeconds} onChange={(event) => set('processIntervalSeconds', Number(event.target.value))}><option value="2">2 秒</option><option value="5">5 秒</option><option value="10">10 秒</option><option value="30">30 秒</option></select></label>
        </SettingsGroup>
        <SettingsGroup icon={<Database />} title="历史">
          <label className="switch-row"><span><strong className="settings-field-title">保存历史数据</strong><small>使用本地 SQLite，固定保留最近 2 天</small></span><input type="checkbox" checked={value.historyEnabled} onChange={(event) => set('historyEnabled', event.target.checked)} /></label>
        </SettingsGroup>
        <SettingsGroup icon={<Settings />} title="窗口行为">
          <label><span><strong className="settings-field-title">窗口关闭按钮</strong></span>
            <select aria-label="窗口关闭按钮" value={value.closeBehavior} onChange={(event) => set('closeBehavior', event.target.value as AppSettings['closeBehavior'])}>
              <option value="minimize">隐藏到系统托盘</option>
              <option value="exit">退出程序</option>
            </select>
          </label>
        </SettingsGroup>
        {error && <p className="form-error" role="alert">{error}</p>}
      </div>
      <footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>取消</button><button className="button button--primary" disabled={saving} onClick={async () => { setSaving(true); setError(null); try { await onSave(value) } catch (reason) { setError(String(reason)) } finally { setSaving(false) } }}>{saving ? '保存中…' : '保存设置'}</button></footer>
    </section>
  </div>
}

function SettingsGroup({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return <section className="settings-group"><header><span>{icon}</span><h3>{title}</h3></header><div>{children}</div></section>
}

function AboutSheet({ onClose }: { onClose: () => void }) {
  return <div className="scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="sheet about-sheet" role="dialog" aria-modal="true" aria-labelledby="about-title"><header className="sheet__header"><div><p className="eyebrow">About</p><h2 id="about-title">Termio</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="about-body"><div className="about-product"><span className="about-product__mark"><Activity size={28} /></span><div><strong>Termio {packageInfo.version}</strong><p>SSH 远程终端、服务器文件管理与算力监控工作台。</p></div></div></div><footer className="sheet__footer"><button className="button button--primary" onClick={onClose}>完成</button></footer></section></div>
}

function TerminateProcessDialog({ target, onClose, onTerminate }: { target: ProcessTerminationTarget & { serverId: string; serverName: string }; onClose: () => void; onTerminate: () => void }) {
  const [stage, setStage] = useState<'review' | 'verify'>('review')
  const [confirmation, setConfirmation] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pid = target.process.pid
  const expected = String(pid)
  const copyPid = async () => {
    try {
      await navigator.clipboard.writeText(expected)
      setCopied(true)
    } catch {
      setCopied(false)
      setError('无法访问剪贴板，请手动输入 PID')
    }
  }
  return <div className="scrim"><section className="sheet terminate-process-sheet" role="alertdialog" aria-modal="true" aria-labelledby="terminate-process-title"><header className="sheet__header"><div><p className="eyebrow">结束远程进程</p><h2 id="terminate-process-title">{stage === 'review' ? `确认结束 PID ${pid}？` : '再次确认进程 PID'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="terminate-process-body"><span className="terminate-process-icon"><OctagonX size={24} /></span><div className="terminate-process-copy">{stage === 'review' ? <><p>将在 <strong>{target.serverName}</strong> 上结束当前 SSH 用户的 PID {pid}，并递归清理它下面的 CPU 子进程。同一终端中不相关的兄弟进程不会被结束。</p><dl><div><dt>进程</dt><dd>{target.kind.toUpperCase()} · PID {pid}</dd></div><div><dt>命令</dt><dd className="mono">{target.process.command}</dd></div></dl><small>先发送 TERM，3 秒后仍存在则发送 KILL。未保存的计算状态可能丢失。</small></> : <><p>点击下方 PID 可自动复制，然后将数字输入确认框。</p><button type="button" className={`copy-pid-button ${copied ? 'is-copied' : ''}`} onClick={() => void copyPid()} aria-label={`复制 PID ${pid}`}>{copied ? <CheckCircle2 size={15} /> : <Copy size={15} />}<code>{copied ? `已复制 PID ${pid}` : `PID ${pid}`}</code></button><label>输入 PID 以确认<input autoFocus inputMode="numeric" value={confirmation} onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, ''))} placeholder={expected} /></label></>}{error && <p className="form-error" role="alert">{error}</p>}</div></div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>取消</button>{stage === 'review' ? <button className="button button--danger" onClick={() => setStage('verify')}>继续确认</button> : <button className="button button--danger" disabled={confirmation !== expected} onClick={onTerminate}>结束进程</button>}</footer></section></div>
}

function HostKeyDialog({ info, onClose, onTrust }: { info: HostKeyInfo; onClose: () => void; onTrust: () => Promise<void> }) {
  const [saving, setSaving] = useState(false)
  return <div className="scrim"><section className={`sheet host-key-sheet ${info.changed ? 'host-key-sheet--changed' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="host-key-title"><header className="sheet__header"><div><p className="eyebrow">{info.changed ? 'SSH 安全警告' : '首次 SSH 连接'}</p><h2 id="host-key-title">{info.changed ? '服务器 Host Key 已变化' : '核对服务器指纹'}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header><div className="host-key-body"><span className="host-key-icon"><ShieldAlert size={26} /></span><p>{info.changed ? <>Termio 检测到 <strong>{info.host}</strong> 的密钥与本机记录不一致。这可能是服务器重装，也可能是中间人攻击。</> : <>这是 Termio 第一次连接 <strong>{info.host}</strong>。请通过可信渠道与服务器管理员核对以下指纹。</>}</p><div className="fingerprint"><small>{info.algorithm}</small><code>{info.fingerprint}</code></div><p className="host-key-note">{info.changed ? '连接已被阻止。请先通过独立可信渠道核实新指纹，再使用系统 ssh-keygen 手动移除旧记录；Termio 不会覆盖现有密钥。' : '只有在确认指纹一致后才继续。Termio 不会自动接受未知 Host Key。'}</p></div><footer className="sheet__footer"><button className="button button--secondary" onClick={onClose}>{info.changed ? '保持阻止' : '取消连接'}</button>{!info.changed && <button className="button button--primary" disabled={saving} onClick={async () => { setSaving(true); try { await onTrust() } finally { setSaving(false) } }}>{saving ? '保存中…' : '指纹一致，信任并连接'}</button>}</footer></section></div>
}

export default App
