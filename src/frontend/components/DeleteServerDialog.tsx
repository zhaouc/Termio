import { useState } from 'react'
import { Trash2, X } from 'lucide-react'
import type { Server } from '../types/models'

export function DeleteServerDialog({ server, onClose, onDelete }: { server: Server; onClose: () => void; onDelete: () => Promise<void> }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirmDelete() {
    setDeleting(true)
    setError(null)
    try {
      await onDelete()
    } catch (reason) {
      setError(String(reason))
      setDeleting(false)
    }
  }

  return (
    <div className="scrim">
      <section className="sheet delete-server-sheet" role="alertdialog" aria-modal="true" aria-labelledby="delete-server-title">
        <header className="sheet__header">
          <div><p className="eyebrow">删除服务器</p><h2 id="delete-server-title">确认删除“{server.name}”？</h2></div>
          <button className="icon-button" onClick={onClose} disabled={deleting} aria-label="关闭"><X size={18} /></button>
        </header>
        <div className="delete-server-body">
          <span className="delete-server-icon"><Trash2 size={24} /></span>
          <div><p>将从 Termio 移除 <strong>{server.username}@{server.host}:{server.port}</strong>，并删除本机保存的监控历史。</p><small>如果旧版本曾在服务器生成 <code>~/.termio</code> 遗留数据，删除时会顺带清理；服务器上的其他文件不会受到影响。</small></div>
          {error && <p className="form-error" role="alert">删除失败：{error}</p>}
        </div>
        <footer className="sheet__footer">
          <button className="button button--secondary" onClick={onClose} disabled={deleting}>取消</button>
          <button className="button button--danger" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? '删除中…' : '删除服务器'}</button>
        </footer>
      </section>
    </div>
  )
}
