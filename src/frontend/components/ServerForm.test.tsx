import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ServerForm } from './ServerForm'

const handlers = { onClose: () => {}, onSave: async () => {} }

describe('ServerForm', () => {
  it('keeps SSH Config and password authentication only', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} />)
    expect(markup).toContain('添加服务器')
    expect(markup).toContain('>SSH Config<')
    expect(markup).toContain('>密码<')
    expect(markup).not.toContain('SSH 密钥')
    expect(markup).not.toContain('私钥路径')
  })

  it('explains that SSH Config may use identity, jump and agent settings', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} />)
    expect(markup).toContain('IdentityFile')
    expect(markup).toContain('ProxyJump')
    expect(markup).toContain('SSH Agent')
  })

  it('keeps password credentials isolated from SSH Config', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} initial={{ authMethod: 'password' }} />)
    expect(markup).toContain('系统安全凭据存储')
    expect(markup).toContain('密码认证不会读取 SSH Config')
  })

  it('limits custom server names to keep the sidebar readable', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} />)
    expect(markup).toContain('maxLength="24"')
  })

  it('provides an SSH connection test before saving', () => {
    const markup = renderToStaticMarkup(<ServerForm {...handlers} />)
    expect(markup).toContain('测试连接')
  })
})
