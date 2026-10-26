import { useState, type FormEvent } from 'react'
import { AlertTriangle, Check, PlugZap, X } from 'lucide-react'
import type { ServerDraft } from '../types/models'
import { api } from '../services/api'

const MAX_SERVER_NAME_LENGTH = 24

interface ServerFormProps {
  initial?: Partial<ServerDraft>
  onClose: () => void
  onSave: (draft: ServerDraft) => Promise<void>
}

export function ServerForm({ initial, onClose, onSave }: ServerFormProps) {
  const [draft, setDraft] = useState<ServerDraft>({
    id: initial?.id,
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: initial?.port ?? 22,
    username: initial?.username ?? '',
    samplingIntervalSeconds: 2,
    historyRetentionDays: 2,
    authMethod: initial?.authMethod === 'password' ? 'password' : 'sshConfig',
    savePassword: initial?.savePassword ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [testingConnection, setTestingConnection] = useState(false)
  const [connectionTest, setConnectionTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [passwordAcknowledged, setPasswordAcknowledged] = useState(initial?.authMethod === 'password')

  const set = <K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
    setConnectionTest(null)
  }

  const selectAuthMethod = (authMethod: ServerDraft['authMethod']) => {
    setDraft((current) => ({ ...current, authMethod, password: authMethod === 'password' ? current.password : undefined }))
    setPasswordAcknowledged(authMethod === 'password')
    setConnectionTest(null)
    setError(null)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft.name.trim()) {
      setError('请填写服务器名称后再连接。')
      return
    }
    if (!draft.host.trim()) {
      setError(draft.authMethod === 'sshConfig' ? '请填写 SSH Config 中的 Host 别名。' : '请填写主机地址。')
      return
    }
    if (!draft.username.trim()) {
      setError('请填写 SSH 用户名。')
      return
    }
    if (draft.authMethod === 'password' && !passwordAcknowledged) return
    if (draft.authMethod === 'password' && !initial?.id && !draft.password?.trim()) {
      setError('请输入 SSH 密码后再保存服务器。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave({ ...draft, name: draft.name || draft.host })
    } catch (reason) {
      setError(String(reason))
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    if (testingConnection) return
    if (!draft.host.trim()) {
      setConnectionTest({ ok: false, message: draft.authMethod === 'sshConfig' ? '请先填写 SSH Config 中的 Host 别名。' : '请先填写主机地址。' })
      return
    }
    if (!draft.username.trim()) { setConnectionTest({ ok: false, message: '请先填写用户名。' }); return }
    if (draft.authMethod === 'password' && !draft.password?.trim() && !initial?.id) {
      setConnectionTest({ ok: false, message: '测试密码登录时请先输入密码。' })
      return
    }
    setTestingConnection(true)
    setConnectionTest(null)
    try {
      const result = await api.testServerDraft({ ...draft, name: draft.name || draft.host })
      setConnectionTest({ ok: true, message: result })
    } catch (reason) {
      setConnectionTest({ ok: false, message: String(reason) })
    } finally {
      setTestingConnection(false)
    }
  }

  return (
    <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sheet server-form-sheet" role="dialog" aria-modal="true" aria-labelledby="server-form-title">
        <header className="sheet__header">
          <div><p className="eyebrow">SSH 服务器</p><h2 id="server-form-title">{initial?.id ? '编辑服务器' : '添加服务器'}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>
        <form onSubmit={submit} className="server-form">
          <div className="server-form__body">
            <label className={!draft.name.trim() && error ? 'field-error' : undefined}>显示名称<input aria-invalid={!draft.name.trim() && Boolean(error)} value={draft.name} maxLength={MAX_SERVER_NAME_LENGTH} onChange={(event) => { set('name', event.target.value); if (error) setError(null) }} placeholder="训练服务器 A" />{!draft.name.trim() && error && <small className="field-error__message">服务器名称不能为空</small>}</label>
            <div className="form-grid form-grid--host">
              <label>{draft.authMethod === 'sshConfig' ? 'SSH Config Host' : '主机地址'}<input required value={draft.host} onChange={(event) => set('host', event.target.value)} placeholder={draft.authMethod === 'sshConfig' ? 'gpu-server' : '10.0.0.10'} /></label>
              <label>端口<input required type="number" min="1" max="65535" value={draft.port} onChange={(event) => set('port', Number(event.target.value))} /></label>
              <label>用户名<input required value={draft.username} onChange={(event) => set('username', event.target.value)} placeholder="researcher" /></label>
            </div>
            <fieldset>
              <legend>认证方式</legend>
              <div className="segmented segmented--auth">
                <button type="button" className={draft.authMethod === 'sshConfig' ? 'is-selected' : ''} onClick={() => selectAuthMethod('sshConfig')}>SSH Config</button>
                <button type="button" className={draft.authMethod === 'password' ? 'is-selected' : ''} onClick={() => selectAuthMethod('password')}>密码</button>
              </div>
            </fieldset>
            {draft.authMethod === 'sshConfig' && (
              <div className="security-warning security-warning--info">
                <AlertTriangle size={20} />
                <div><strong>使用本机 OpenSSH Config 认证</strong><p>Termio 会直接读取 <code>~/.ssh/config</code> 中该 Host 的认证与跳转配置，包括 IdentityFile、ProxyJump 和 SSH Agent。主机地址请填写 Host 别名。</p></div>
              </div>
            )}
            {draft.authMethod === 'password' && (
              <div className="security-warning">
                <AlertTriangle size={20} />
                <div>
                  <strong>密码只保存在系统安全凭据存储中</strong>
                  <p>密码认证不会读取 SSH Config，也不会把密码写入配置文件或 SQLite。</p>
                  <label className="checkbox-row"><input type="checkbox" checked={passwordAcknowledged} onChange={(event) => setPasswordAcknowledged(event.target.checked)} />我理解并继续使用密码</label>
                </div>
              </div>
            )}
            {draft.authMethod === 'password' && passwordAcknowledged && (
              <div className="form-grid form-grid--2">
                <label>密码<input type="password" value={draft.password ?? ''} onChange={(event) => set('password', event.target.value)} autoComplete="new-password" /></label>
                <label className="checkbox-card"><input type="checkbox" checked={draft.savePassword ?? true} onChange={(event) => set('savePassword', event.target.checked)} /><span>保存到系统钥匙串</span></label>
              </div>
            )}
            {connectionTest && <p className={`connection-test-result ${connectionTest.ok ? 'is-success' : 'is-error'}`} role={connectionTest.ok ? 'status' : 'alert'}>{connectionTest.ok ? <Check size={14} /> : <AlertTriangle size={14} />}{connectionTest.message}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <footer className="sheet__footer">
            <button type="button" className="button button--secondary" disabled={testingConnection} onClick={() => void testConnection()}><PlugZap size={16} />{testingConnection ? '测试中…' : '测试连接'}</button>
            <span className="sheet__footer-spacer" />
            <button type="button" className="button button--secondary" onClick={onClose}>取消</button>
            <button type="submit" className="button button--primary" disabled={saving || (draft.authMethod === 'password' && !passwordAcknowledged)}><Check size={17} />{saving ? '保存中…' : '保存并连接'}</button>
          </footer>
        </form>
      </section>
    </div>
  )
}
