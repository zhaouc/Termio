export type ServerStatus = 'online' | 'offline' | 'connecting' | 'warning' | 'unknown'
export type AuthMethod = 'sshConfig' | 'password'

export interface Server {
  id: string
  name: string
  host: string
  port: number
  username: string
  samplingIntervalSeconds: number
  historyRetentionDays: number
  sortOrder?: number
  authMethod: AuthMethod
  status: ServerStatus
  lastError?: string | null
  lastSeenAt?: number | null
}

export interface GpuMetric {
  index: number
  uuid: string
  name: string
  utilization: number
  memoryUtilization: number
  memoryUsedMb: number
  memoryTotalMb: number
  temperatureCelsius: number
  powerWatts: number
  powerLimitWatts?: number
  smClockMhz?: number
  memoryClockMhz?: number
  performanceState?: string
  fanSpeedPercent?: number
  throttleReason?: string
  eccErrors?: number
}

export interface ProcessMetric {
  gpuUuid: string
  gpuIndex: number
  pid: number
  parentPid: number
  username: string
  command: string
  memoryUsedMb: number
  smUtilization: number | null
  cpuPercent: number
  elapsed: string
  isCurrentUser: boolean
  isGroupLeader: boolean
}

export interface CpuProcessMetric {
  pid: number
  parentPid: number
  username: string
  command: string
  cpuPercent: number
  memoryPercent: number
  memoryUsedBytes: number
  elapsed: string
  isCurrentUser: boolean
  isGroupLeader: boolean
}

export interface SystemMetric {
  cpuModel: string
  cpuUtilization: number
  currentUserCpuUtilization: number
  load1: number
  load5: number
  load15: number
  memoryUsedBytes: number
  memoryTotalBytes: number
  swapUsedBytes: number
  swapTotalBytes: number
  cpuPhysicalCores?: number
  cpuLogicalCores?: number
  cpuFrequencyMhz?: number
  cpuMaxFrequencyMhz?: number
  cpuUserPercent?: number
  cpuSystemPercent?: number
  cpuIoWaitPercent?: number
  cpuStealPercent?: number
  cpuTemperatureCelsius?: number
  memoryAvailableBytes?: number
  memoryCacheBytes?: number
}

export interface NetworkUserMetric {
  uid: number
  username: string
  downloadBytesPerSecond: number
  uploadBytesPerSecond: number
  connectionCount: number
}

export interface NetworkMetric {
  downloadBytesPerSecond: number
  uploadBytesPerSecond: number
  users: NetworkUserMetric[]
  userBreakdownSupported: boolean
  usersSampled: boolean
}

export interface Snapshot {
  serverId: string
  hostname: string
  username: string
  osId: string
  osName: string
  timestamp: number
  status: ServerStatus
  acceleratorVendor?: 'nvidia' | 'ascend'
  system: SystemMetric
  network?: NetworkMetric
  gpus: GpuMetric[]
  disks?: DiskMetric[]
  processes: ProcessMetric[]
  cpuProcesses: CpuProcessMetric[]
  processesSampled: boolean
  nvidiaSmi: 'available' | 'degraded' | 'missing' | 'permissionDenied' | 'failed'
  nvidiaMessage?: string | null
}

export interface DiskMetric {
  mountPoint: string
  usedBytes: number
  totalBytes: number
  availableBytes: number
  currentUserUsedBytes?: number
}

export interface HistoryPoint {
  timestamp: number
  isCompacted?: boolean
  cpuUtilization: number
  memoryUtilization: number
  swapUtilization: number
  gpuUtilizations: Record<string, number>
  gpuMemoryUtilizations: Record<string, number>
  gpuOtherUserOccupancies?: Record<string, boolean>
  cpuMin?: number
  cpuMax?: number
  memoryMin?: number
  memoryMax?: number
  swapMin?: number
  swapMax?: number
  gpuMins?: Record<string, number>
  gpuMaxes?: Record<string, number>
  gpuMemoryMins?: Record<string, number>
  gpuMemoryMaxes?: Record<string, number>
}

export interface HostKeyInfo {
  serverId: string
  host: string
  algorithm: string
  fingerprint: string
  keyLine: string
  changed: boolean
}


export interface AppSettings {
  defaultSamplingIntervalSeconds: number
  backgroundSamplingIntervalSeconds: number
  processIntervalSeconds: number
  historyEnabled: boolean
  historyRetentionDays: number
  idleGpuThreshold: number
  idleMemoryThresholdMb: number
  idleDurationMinutes: number
  temperatureThresholdCelsius: number
  currentUserAccent: string
  theme: 'system' | 'light' | 'dark'
  fontSize: 'standard' | 'large'
  closeBehavior: 'minimize' | 'exit'
}

export interface GpuMemoryStallWarning {
  id: string
  serverId: string
  serverName: string
  gpuUuid: string
  gpuIndex: number
  gpuName: string
  usernames: string[]
  defunctProcesses: Array<{ pid: number; username: string }>
  memoryUsedMb: number
  memoryTotalMb: number
  startedAt: number
  durationSeconds: number
}

export type DetailTab = 'overview' | 'gpu' | 'processes' | 'cpu' | 'network' | 'terminal'

export interface ServerDraft {
  id?: string
  name: string
  host: string
  port: number
  username: string
  samplingIntervalSeconds: number
  historyRetentionDays: number
  authMethod: AuthMethod
  password?: string
  savePassword?: boolean
}

export interface RemoteCleanupResult {
  remoteCleaned: boolean
  cleanupPending: boolean
  message: string
}

export interface RemoteCleanupSweepResult {
  cleanedNames: string[]
  pendingNames: string[]
  expiredNames: string[]
}

export interface InteractionServerSummary {
  serverId: string
  serverName: string
  sentBytes: number
  responseBytes: number
  storedBytes: number
  lastStartedAt: number
  lastFinishedAt?: number | null
  lastCommand: string
  status: 'running' | 'success' | 'error'
  error?: string | null
}

export interface InteractionLogSummary {
  sentBytes: number
  responseBytes: number
  storedBytes: number
  localStorageBytes: number
  failureCount: number
  servers: InteractionServerSummary[]
}

export type ProjectKind = 'project' | 'dataset' | 'model'
export type ProjectTargetStatus = 'unknown' | 'found' | 'missing' | 'offline' | 'syncing' | 'paused' | 'synced' | 'conflict' | 'error'

export interface ProjectTarget {
  serverId: string
  path: string
  status: ProjectTargetStatus
  exists: boolean
  isDirectory: boolean
  sizeBytes: number
  fileCount: number
  modifiedAt?: number | null
  lastCheckedAt?: number | null
  lastSyncedAt?: number | null
  syncedSourceSizeBytes?: number | null
  syncedSourceFileCount?: number | null
  syncedSourceModifiedAt?: number | null
  syncedTargetSizeBytes?: number | null
  syncedTargetFileCount?: number | null
  syncedTargetModifiedAt?: number | null
  error?: string | null
}

export interface Project {
  id: string
  name: string
  kind: ProjectKind
  sourceServerId: string
  sourcePath: string
  sourceExists: boolean
  sourceIsDirectory: boolean
  sourceSizeBytes: number
  sourceFileCount: number
  sourceModifiedAt?: number | null
  datasetIds: string[]
  modelIds: string[]
  targets: ProjectTarget[]
  createdAt: number
  updatedAt: number
  lastSyncAt?: number | null
  status: ProjectTargetStatus
  lastError?: string | null
}

export interface ProjectDraft {
  id?: string
  name: string
  kind: ProjectKind
  sourceServerId: string
  sourcePath: string
  datasetIds: string[]
  modelIds: string[]
  targets: Array<{ serverId: string; path: string }>
}

export interface LinkedProjectResourcePlan {
  resourceId: string
  kind: 'dataset' | 'model'
  syncOnSave: boolean
  targets: Array<{ serverId: string; path: string }>
}

export interface ProjectPathCheck {
  serverId: string
  requestedPath: string
  suggestedPath: string
  exists: boolean
  isDirectory: boolean
  sizeBytes: number
  fileCount: number
  modifiedAt?: number | null
  matches: string[]
  error?: string | null
}

export interface ProjectSyncResult {
  projectId: string
  targetServerId: string
  transferredBytes: number
  message: string
}

export interface ProjectSyncProgress {
  projectId: string
  targetServerId: string
  transferredBytes: number
  resumedBytes: number
  totalBytes: number
  startedAt: number
  state: 'preparing' | 'transferring' | 'publishing'
}

