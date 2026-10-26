// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSheet } from '../App'
import type { AppSettings } from '../types/models'

vi.mock('./SshTerminal', () => ({ SshTerminal: () => null }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: AppSettings = {
  defaultSamplingIntervalSeconds: 2,
  backgroundSamplingIntervalSeconds: 15,
  processIntervalSeconds: 5,
  historyEnabled: true,
  historyRetentionDays: 2,
  idleGpuThreshold: 10,
  idleMemoryThresholdMb: 40960,
  idleDurationMinutes: 10,
  temperatureThresholdCelsius: 85,
  currentUserAccent: '#0a84ff',
  theme: 'system',
  fontSize: 'standard',
  closeBehavior: 'minimize',
}

let root: ReturnType<typeof createRoot> | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('SettingsSheet', () => {
  it('removes onboarding preferences and saves app settings directly', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)

    await act(async () => root?.render(<SettingsSheet settings={settings} onClose={vi.fn()} onSave={onSave} />))

    expect(container.textContent).not.toContain('显示新手引导')
    expect(container.textContent).not.toContain('显示添加服务器引导')
    expect(container.textContent).toContain('外观')
    expect(container.textContent).toContain('采样')
    expect(container.querySelector('#settings-title')?.textContent).toBe('设置')
    expect(container.textContent).toContain('固定保留最近 2 天')
    expect(container.textContent).toContain('窗口行为')
    expect(container.textContent).toContain('窗口关闭按钮')
    expect(container.textContent).not.toContain('窗口最小化按钮')
    expect(container.textContent).toContain('任务标记色')
    expect(container.textContent).not.toContain('用于显存光标')
    expect(container.textContent).not.toContain('用于显示光标')
    expect([...container.querySelectorAll('.settings-field-title')].map((item) => item.textContent)).toEqual(['主题', '任务标记色', '后台最低采样间隔', '保存历史数据', '窗口关闭按钮'])
    expect(container.textContent).not.toContain('进程刷新')
    expect(container.querySelector('.settings-body')?.innerHTML).not.toContain('进程刷新')
    const processSelect = container.querySelector('select[aria-label="进程采样间隔"]') as HTMLSelectElement
    expect(processSelect).not.toBeNull()
    expect(processSelect.value).toBe('5')
    expect([...processSelect.options].map((option) => option.value)).toEqual(['2', '5', '10', '30'])
    expect(container.textContent).not.toContain('我的任务标记色')
    expect(container.querySelector('.settings-help')).toBeNull()
    expect(container.textContent).not.toContain('空闲与告警')
    expect(container.textContent).not.toContain('诊断与日志')
    expect(container.textContent).not.toContain('菜单栏状态')
    expect(container.textContent).not.toContain('减少非必要动效')

    const saveButton = [...container.querySelectorAll('button')].find((button) => button.textContent === '保存设置')
    await act(async () => { saveButton?.click(); await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith(settings)
  })

  it('keeps process refresh configurable without a visible title', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SettingsSheet settings={settings} onClose={vi.fn()} onSave={onSave} />))

    const select = container.querySelector('select[aria-label="进程采样间隔"]') as HTMLSelectElement
    expect(select).not.toBeNull()
    expect(container.textContent).not.toContain('进程刷新')
    await act(async () => {
      select.value = '10'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')].find((item) => item.textContent === '保存设置')
    await act(async () => { save?.click(); await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith({ ...settings, processIntervalSeconds: 10 })
  })

  it('only presents the close behavior setting and persists exit-on-close', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(<SettingsSheet settings={settings} onClose={vi.fn()} onSave={onSave} />))
    expect(container.querySelector('select[aria-label="窗口最小化按钮"]')).toBeNull()
    const close = container.querySelector('select[aria-label="窗口关闭按钮"]') as HTMLSelectElement
    expect(close.value).toBe('minimize')
    await act(async () => {
      close.value = 'exit'
      close.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = [...container.querySelectorAll('button')].find((item) => item.textContent === '保存设置')
    await act(async () => { save?.click(); await Promise.resolve() })
    expect(onSave).toHaveBeenCalledWith({ ...settings, closeBehavior: 'exit' })
  })
})
