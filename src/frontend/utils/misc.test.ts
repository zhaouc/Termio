import { describe, expect, it } from 'vitest'
import { detectAppPlatform } from './platform'
import { gpuContextName, serverDisplayName } from './serverName'
import { bracketTerminalPaste, isMultilineTerminalPaste, normalizeTerminalPaste } from './terminalPaste'
import { formatFiveMinuteTimeLabel, minuteTickSplitNumber } from './timeAxis'

describe('platform and display helpers', () => {
  it('detects web and desktop platforms', () => {
    expect(detectAppPlatform(false, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('web')
    expect(detectAppPlatform(true, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36')).toBe('windows')
    expect(detectAppPlatform(true, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos')
  })

  it('formats server and GPU display names', () => {
    expect(serverDisplayName('3 * A100')).toBe('3 * A100 服务器')
    expect(serverDisplayName('训练服务器 A')).toBe('训练服务器 A')
    expect(serverDisplayName('  ')).toBe('未命名服务器')
    expect(gpuContextName('3 * A100', 0, 'NVIDIA A100-PCIE-40GB')).toBe('3 * A100 服务器 · GPU 0 · A100-PCIE-40GB')
  })
})

describe('terminal paste protection', () => {
  it('normalizes line endings and detects multiline paste', () => {
    expect(normalizeTerminalPaste('cd /tmp\r\necho ready\r')).toBe('cd /tmp\necho ready\n')
    expect(isMultilineTerminalPaste('echo ready')).toBe(false)
    expect(isMultilineTerminalPaste('echo one\necho two')).toBe(true)
  })

  it('uses bracketed paste for multiline scripts', () => {
    expect(bracketTerminalPaste('echo one\r\necho two')).toBe('\x1b[200~echo one\necho two\x1b[201~')
  })
})

describe('five-minute time axis labels', () => {
  it('labels exact five-minute boundaries and calculates minute ticks', () => {
    const boundary = new Date(2026, 7, 3, 17, 35, 0, 0).getTime()
    expect(formatFiveMinuteTimeLabel(boundary)).toBe('17:35')
    expect(formatFiveMinuteTimeLabel(boundary + 60_000)).toBe('')
    expect(formatFiveMinuteTimeLabel(boundary + 30_000)).toBe('')
    const start = new Date(2026, 7, 3, 17, 30).getTime()
    expect(minuteTickSplitNumber([start, start + 30 * 60_000])).toBe(30)
  })
})
