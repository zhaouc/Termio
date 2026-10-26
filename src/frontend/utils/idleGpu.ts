import type { ProcessMetric, Server, Snapshot } from '../types/models'
import { hasOtherUserGpuWorkload, isGpuAvailable, isIgnoredSystemGpuProcess } from './gpu'

export type IdleGpuItem = {
  server: Server
  gpu: Snapshot['gpus'][number]
  available: boolean
}


export function parseProcessElapsedSeconds(value: string): number | null {
  const text = value.trim()
  if (!text || text === '—') return null
  const daySplit = text.split('-')
  if (daySplit.length > 2) return null
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0
  const clock = (daySplit.length === 2 ? daySplit[1] : daySplit[0]).split(':').map(Number)
  if (!Number.isInteger(days) || days < 0 || (clock.length !== 2 && clock.length !== 3) || clock.some((part) => !Number.isInteger(part) || part < 0)) return null
  const [hours, minutes, seconds] = clock.length === 3 ? clock : [0, clock[0], clock[1]]
  if (minutes >= 60 || seconds >= 60) return null
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

export function gpuOccupiedDurationSeconds(gpuUuid: string, processes: ProcessMetric[]): number | null {
  const elapsed = processes
    .filter((process) => process.gpuUuid === gpuUuid && !process.isCurrentUser && !isIgnoredSystemGpuProcess(process) && process.memoryUsedMb > 0)
    .map((process) => parseProcessElapsedSeconds(process.elapsed))
    .filter((seconds): seconds is number => seconds !== null)
  return elapsed.length ? Math.max(...elapsed) : null
}

export function formatGpuOccupiedDuration(seconds: number): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  if (safeSeconds < 60) return '不足 1 分钟'
  const totalMinutes = Math.floor(safeSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) return minutes ? `${totalHours} 小时 ${minutes} 分钟` : `${totalHours} 小时`
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours ? `${days} 天 ${hours} 小时` : `${days} 天`
}

export function displayedFreeMemoryGb(memoryMb: number): number {
  const safeMemoryMb = Number.isFinite(memoryMb) ? Math.max(0, memoryMb) : 0
  return Math.round(safeMemoryMb / 1024 * 10) / 10
}

export function rankIdleGpuItems(servers: Server[], snapshots: Record<string, Snapshot>): IdleGpuItem[] {
  return servers
    .flatMap((server) => (snapshots[server.id]?.gpus ?? []).map((gpu) => ({ server, gpu })))
    .filter(({ gpu }) => isGpuAvailable(gpu))
    .map(({ server, gpu }) => ({
      server,
      gpu,
      available: !hasOtherUserGpuWorkload(gpu, snapshots[server.id]?.processes ?? []),
    }))
    .sort((left, right) => Number(right.available) - Number(left.available)
      || (right.gpu.memoryTotalMb - right.gpu.memoryUsedMb) - (left.gpu.memoryTotalMb - left.gpu.memoryUsedMb)
      || ((snapshots[right.server.id]?.system.memoryTotalBytes ?? 0) - (snapshots[right.server.id]?.system.memoryUsedBytes ?? 0))
        - ((snapshots[left.server.id]?.system.memoryTotalBytes ?? 0) - (snapshots[left.server.id]?.system.memoryUsedBytes ?? 0)))
}
