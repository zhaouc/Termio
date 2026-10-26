import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { EmptyState } from '../App'

describe('EmptyState', () => {
  it('offers adding a server or importing SSH Config', () => {
    const markup = renderToStaticMarkup(<EmptyState onAdd={vi.fn()} onImport={vi.fn()} />)

    expect(markup).toContain('连接第一台服务器')
    expect(markup).toContain('添加服务器')
    expect(markup).toContain('从 SSH Config 导入')
    expect(markup).not.toContain('新手引导')
  })
})
