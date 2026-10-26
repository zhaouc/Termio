import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Server } from '../types/models'
import { DeleteServerDialog } from './DeleteServerDialog'

const server: Server = {
  id: 'server-1', name: 'GPU Server', host: 'gpu-server', port: 22, username: 'alice',
  samplingIntervalSeconds: 2, historyRetentionDays: 90, authMethod: 'sshConfig', status: 'online',
}

describe('DeleteServerDialog', () => {
  it('deletes Termio data without managed-key revocation controls', () => {
    const markup = renderToStaticMarkup(<DeleteServerDialog server={server} onClose={vi.fn()} onDelete={vi.fn()} />)
    expect(markup).toContain('删除服务器')
    expect(markup).not.toContain('撤销 Termio 配置的免密登录')
    expect(markup).not.toContain('authorized_keys')
  })
})
