import { describe, expect, it } from 'vitest'
import type { Server, Snapshot } from '../types/models'
import { displayedFreeMemoryGb, formatGpuOccupiedDuration, gpuOccupiedDurationSeconds, parseProcessElapsedSeconds, rankIdleGpuItems } from './idleGpu'

const server: Server = {
  id: 'server-1', name: 'server-1', host: '10.0.0.1', port: 22, username: 'tongzh',   samplingIntervalSeconds: 2, historyRetentionDays: 30, authMethod: 'sshConfig', status: 'online',
}

const snapshot: Snapshot = {
  serverId: server.id, hostname: server.name, username: server.username, osId: 'linux', osName: 'Linux', timestamp: 1_000,
  status: 'online', processesSampled: true, nvidiaSmi: 'available',
  system: { cpuModel: 'Test CPU', cpuUtilization: 0, currentUserCpuUtilization: 0, load1: 0, load5: 0, load15: 0, memoryUsedBytes: 8 * 1024 ** 3, memoryTotalBytes: 32 * 1024 ** 3, swapUsedBytes: 0, swapTotalBytes: 0 },
  gpus: [{ index: 0, uuid: 'gpu-0', name: 'Test GPU', utilization: 0, memoryUtilization: 0, memoryUsedMb: 2_048, memoryTotalMb: 24_576, temperatureCelsius: 30, powerWatts: 30 }],
  processes: [],
  cpuProcesses: [],
}

describe('idle GPU list', () => {
  it('marks a readable GPU without other-user workloads as available', () => {
    expect(rankIdleGpuItems([server], { [server.id]: snapshot })[0].available).toBe(true)
  })

  it('keeps occupied GPUs visible but marks them unavailable', () => {
    const occupied: Snapshot = {
      ...snapshot,
      processes: [{ gpuUuid: 'gpu-0', gpuIndex: 0, pid: 42, parentPid: 1, username: 'other', command: 'python train.py', memoryUsedMb: 12_000, smUtilization: null, cpuPercent: 0, elapsed: '00:10', isCurrentUser: false, isGroupLeader: false }],
    }
    const item = rankIdleGpuItems([server], { [server.id]: occupied })[0]
    expect(item.gpu.uuid).toBe('gpu-0')
    expect(item.available).toBe(false)
  })

  it('excludes unreadable placeholder GPUs', () => {
    const unavailableSnapshot = {
      ...snapshot,
      nvidiaSmi: 'degraded' as const,
      gpus: [...snapshot.gpus, { ...snapshot.gpus[0], index: 1, uuid: 'unavailable-0000_D1_00_0', name: 'Unavailable GPU (0000:D1:00.0)', memoryUsedMb: 0, memoryTotalMb: 0 }],
    }
    expect(rankIdleGpuItems([server], { [server.id]: unavailableSnapshot }).map((item) => item.gpu.uuid)).toEqual(['gpu-0'])
  })


  it('parses Linux ps elapsed time and formats occupied duration', () => {
    expect(parseProcessElapsedSeconds('42:17')).toBe(2_537)
    expect(parseProcessElapsedSeconds('02:18:09')).toBe(8_289)
    expect(parseProcessElapsedSeconds('3-03:49:20')).toBe(272_960)
    expect(formatGpuOccupiedDuration(42 * 60 + 17)).toBe('42 分钟')
    expect(formatGpuOccupiedDuration(2 * 3_600 + 18 * 60)).toBe('2 小时 18 分钟')
  })

  it('uses the longest visible other-user GPU process as the occupied duration', () => {
    const processes = [
      { gpuUuid: 'gpu-0', gpuIndex: 0, pid: 1, parentPid: 0, username: 'alice', command: 'python train.py', memoryUsedMb: 10_000, smUtilization: null, cpuPercent: 0, elapsed: '42:00', isCurrentUser: false, isGroupLeader: true },
      { gpuUuid: 'gpu-0', gpuIndex: 0, pid: 2, parentPid: 0, username: 'bob', command: 'python worker.py', memoryUsedMb: 8_000, smUtilization: null, cpuPercent: 0, elapsed: '02:18:00', isCurrentUser: false, isGroupLeader: true },
      { gpuUuid: 'gpu-0', gpuIndex: 0, pid: 3, parentPid: 0, username: 'tongzh', command: 'python mine.py', memoryUsedMb: 4_000, smUtilization: null, cpuPercent: 0, elapsed: '09:00:00', isCurrentUser: true, isGroupLeader: true },
    ]
    expect(gpuOccupiedDurationSeconds('gpu-0', processes)).toBe(2 * 3_600 + 18 * 60)
  })

  it('keeps the displayed free-memory value at one decimal place', () => {
    expect(displayedFreeMemoryGb(40_960 - 12)).toBe(40)
  })
})
