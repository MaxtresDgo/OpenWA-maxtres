import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Check,
  Copy,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  Music,
  Paperclip,
  Plus,
  Search,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { type MessageTemplate, type TemplateMediaType, type TemplatePayload } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useCreateTemplateMutation,
  useDeleteTemplateMutation,
  useSendTemplateMutation,
  useSessionChatsQuery,
  useSessionsQuery,
  useTemplatesQuery,
  useUpdateTemplateMutation,
} from '../hooks/queries';
import { PageHeader } from '../components/PageHeader';
import { copyToClipboard } from '../utils/clipboard';
import { parseBulkRecipients, BULK_MAX_RECIPIENTS } from '../utils/bulkRecipients';
import './Templates.css';

type TemplateForm = {
  name: string;
  header: string;
  body: string;
  footer: string;
  // A newly selected file, held as base64 (no data: prefix) until saved. null = nothing new picked.
  mediaBase64: string | null;
  mediaType: TemplateMediaType | null;
  mimetype: string | null;
  filename: string | null;
  // data: URL of the newly picked file, for an inline preview before saving.
  mediaPreviewUrl: string | null;
  // Media already stored on the template being edited (kept unless replaced or removed).
  existingMediaType: TemplateMediaType | null;
  existingFilename: string | null;
  // When editing: request removal of the stored attachment on save.
  removeMedia: boolean;
};

const emptyForm: TemplateForm = {
  name: '',
  header: '',
  body: '',
  footer: '',
  mediaBase64: null,
  mediaType: null,
  mimetype: null,
  filename: null,
  mediaPreviewUrl: null,
  existingMediaType: null,
  existingFilename: null,
  removeMedia: false,
};

function extractPlaceholders(template: TemplateForm | MessageTemplate) {
  const source = [template.header, template.body, template.footer].filter(Boolean).join('\n');
  return Array.from(new Set(Array.from(source.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g), match => match[1]))).sort();
}

/** Map a browser File MIME type onto the template's coarse media kind. */
function mediaTypeFromMime(mime: string): TemplateMediaType {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}


/** True when the form will carry media after save: a freshly picked file, or kept existing media. */
function formHasMedia(form: TemplateForm): boolean {
  return !!form.mediaBase64 || (!!form.existingMediaType && !form.removeMedia);
}

function toPayload(form: TemplateForm, isEditing: boolean): TemplatePayload {
  const payload: TemplatePayload = {
    name: form.name.trim(),
    header: form.header.trim() || null,
    body: form.body.trim() || null,
    footer: form.footer.trim() || null,
  };
  if (form.mediaBase64 && form.mediaType) {
    payload.mediaType = form.mediaType;
    payload.mediaBase64 = form.mediaBase64;
    payload.mimetype = form.mimetype || 'application/octet-stream';
    if (form.filename) payload.filename = form.filename;
  } else if (isEditing && form.removeMedia) {
    payload.removeMedia = true;
  }
  return payload;
}

function renderPreview(template: TemplateForm, values: Record<string, string>) {
  return [template.header, template.body, template.footer]
    .filter(Boolean)
    .join('\n\n')
    .replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => values[key] || `{{${key}}}`);
}

export function Templates() {
  const { t } = useTranslation();
  useDocumentTitle(t('templates.title'));
  const { canWrite } = useRole();
  const { data: sessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const [selectedSessionId, setSelectedSessionId] = useState('');
  const [form, setForm] = useState<TemplateForm>(emptyForm);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplate | null>(null);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, string>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Send-template modal state. `sendTarget` is the saved template being sent.
  const [sendTarget, setSendTarget] = useState<MessageTemplate | null>(null);
  const [sendVars, setSendVars] = useState<Record<string, string>>({});
  // Recipient selection: either pick from the session's existing chats, or paste/CSV a manual list.
  const [sendMode, setSendMode] = useState<'chats' | 'manual'>('chats');
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [chatSearch, setChatSearch] = useState('');
  const [manualText, setManualText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendProgress, setSendProgress] = useState<{ total: number; done: number; failed: number } | null>(null);
  // Seconds to pause between consecutive sends in a bulk run — a safe-sending guard against WhatsApp's
  // anti-abuse detection. Default 3s; applies only when there is more than one recipient.
  const [sendDelaySec, setSendDelaySec] = useState(3);
  const csvInputRef = useRef<HTMLInputElement>(null);

  const { data: templates = [], isLoading: loadingTemplates } = useTemplatesQuery(selectedSessionId, !!selectedSessionId);
  const createMutation = useCreateTemplateMutation();
  const updateMutation = useUpdateTemplateMutation();
  const deleteMutation = useDeleteTemplateMutation();
  const sendMutation = useSendTemplateMutation();
  // Load the session's chats only while the send modal is open (in chats mode) — avoids fetching on
  // every page view. React Query caches it for 60s, so reopening the modal is instant.
  const { data: sessionChats = [], isLoading: loadingChats } = useSessionChatsQuery(
    selectedSessionId,
    !!sendTarget && !!selectedSessionId,
  );

  const selectedSession = sessions.find(session => session.id === selectedSessionId);
  const placeholders = useMemo(() => extractPlaceholders(form), [form]);
  const preview = useMemo(() => renderPreview(form, previewValues), [form, previewValues]);
  const filteredTemplates = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return templates;
    return templates.filter(template =>
      [template.name, template.header, template.body, template.footer]
        .filter(Boolean)
        .some(value => value!.toLowerCase().includes(query)),
    );
  }, [searchTerm, templates]);
  const isSaving = createMutation.isPending || updateMutation.isPending;

  useEffect(() => {
    if (!selectedSessionId && sessions.length > 0) {
      setSelectedSessionId(sessions[0].id);
    }
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    setPreviewValues(current => {
      const next: Record<string, string> = {};
      for (const key of placeholders) {
        next[key] = current[key] || '';
      }
      return next;
    });
  }, [placeholders]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingTemplate(null);
    setPreviewValues({});
  };

  const openEdit = (template: MessageTemplate) => {
    setEditingTemplate(template);
    setForm({
      ...emptyForm,
      name: template.name,
      header: template.header || '',
      body: template.body || '',
      footer: template.footer || '',
      existingMediaType: template.hasMedia ? template.mediaType ?? null : null,
      existingFilename: template.hasMedia ? template.filename ?? null : null,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file after a remove
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      setForm(current => ({
        ...current,
        mediaBase64: base64,
        mediaType: mediaTypeFromMime(file.type),
        mimetype: file.type || 'application/octet-stream',
        filename: file.name,
        mediaPreviewUrl: result,
        removeMedia: false,
      }));
    };
    reader.readAsDataURL(file);
  };

  const clearMedia = () => {
    setForm(current => ({
      ...current,
      mediaBase64: null,
      mediaType: null,
      mimetype: null,
      filename: null,
      mediaPreviewUrl: null,
      // If the edited template had stored media, record the intent to remove it on save.
      removeMedia: current.removeMedia || !!current.existingMediaType,
      existingMediaType: null,
      existingFilename: null,
    }));
  };

  // A template needs a message: text OR a media attachment. Body alone is no longer mandatory.
  const canSave = !!form.name.trim() && (!!form.body.trim() || formHasMedia(form));

  const handleSave = async () => {
    if (!selectedSessionId || !canSave) return;

    try {
      if (editingTemplate) {
        await updateMutation.mutateAsync({
          sessionId: selectedSessionId,
          id: editingTemplate.id,
          data: toPayload(form, true),
        });
        setToast({ type: 'success', message: t('templates.toasts.updated') });
      } else {
        await createMutation.mutateAsync({
          sessionId: selectedSessionId,
          data: toPayload(form, false),
        });
        setToast({ type: 'success', message: t('templates.toasts.created') });
      }
      resetForm();
    } catch (err) {
      setToast({
        type: 'error',
        message: t(editingTemplate ? 'templates.toasts.updateFailed' : 'templates.toasts.createFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const handleDelete = async () => {
    if (!selectedSessionId || !deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: selectedSessionId, id: deleteTarget.id });
      setToast({ type: 'success', message: t('templates.toasts.deleted') });
      if (editingTemplate?.id === deleteTarget.id) resetForm();
      setDeleteTarget(null);
    } catch (err) {
      setToast({
        type: 'error',
        message: t('templates.toasts.deleteFailed', {
          message: err instanceof Error ? err.message : t('common.unknownError'),
        }),
      });
    }
  };

  const copyName = async (name: string) => {
    if (await copyToClipboard(name)) {
      setToast({ type: 'success', message: t('templates.toasts.copied') });
    }
  };

  const openSend = (template: MessageTemplate) => {
    setSendTarget(template);
    setSendMode('chats');
    setSelectedChatIds([]);
    setChatSearch('');
    setManualText('');
    setSendProgress(null);
    // Seed the send variables from the placeholders the template actually uses, prefilled with any
    // sample values already typed in the preview panel.
    const seeded: Record<string, string> = {};
    for (const key of extractPlaceholders(template)) {
      seeded[key] = previewValues[key] || '';
    }
    setSendVars(seeded);
  };

  const closeSend = () => {
    if (isSending) return; // don't yank the modal out from under an in-flight batch
    setSendTarget(null);
    setSendProgress(null);
  };

  // The recipients the current mode resolves to: selected chat ids, or the parsed manual/CSV list.
  const sendRecipients = useMemo(
    () => (sendMode === 'chats' ? selectedChatIds : parseBulkRecipients(manualText)),
    [sendMode, selectedChatIds, manualText],
  );
  const tooManyRecipients = sendRecipients.length > BULK_MAX_RECIPIENTS;

  const filteredChats = useMemo(() => {
    const query = chatSearch.trim().toLowerCase();
    if (!query) return sessionChats;
    return sessionChats.filter(
      chat => chat.name.toLowerCase().includes(query) || chat.id.toLowerCase().includes(query),
    );
  }, [chatSearch, sessionChats]);

  const toggleChat = (chatId: string) => {
    setSelectedChatIds(current =>
      current.includes(chatId) ? current.filter(id => id !== chatId) : [...current, chatId],
    );
  };

  const handleCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Flatten every CSV cell (comma / semicolon / tab / newline separated) to one-per-line, then let
      // parseBulkRecipients keep only the entries that resolve to a chat id. Non-number cells (names,
      // headers) have no digits and drop out. The result fills the textarea so the operator can review.
      const raw = String(reader.result ?? '');
      const tokens = raw
        .split(/[\r\n,;\t]+/)
        .map(token => token.trim())
        .filter(Boolean);
      const merged = parseBulkRecipients([manualText, ...tokens].join('\n'));
      setManualText(merged.join('\n'));
      setSendMode('manual');
    };
    reader.readAsText(file);
  };

  const handleSendTemplate = async () => {
    if (!selectedSessionId || !sendTarget || isSending) return;
    const recipients = sendRecipients;
    if (recipients.length === 0) {
      setToast({ type: 'error', message: t('templates.send.toasts.noRecipients') });
      return;
    }
    if (tooManyRecipients) return;

    const vars = Object.keys(sendVars).length > 0 ? sendVars : undefined;

    // Single recipient: one call, simple success/failure toast.
    if (recipients.length === 1) {
      try {
        setIsSending(true);
        await sendMutation.mutateAsync({ sessionId: selectedSessionId, chatId: recipients[0], templateId: sendTarget.id, vars });
        setToast({ type: 'success', message: t('templates.send.toasts.sent') });
        setSendTarget(null);
      } catch (err) {
        setToast({
          type: 'error',
          message: t('templates.send.toasts.failed', {
            message: err instanceof Error ? err.message : t('common.unknownError'),
          }),
        });
      } finally {
        setIsSending(false);
      }
      return;
    }

    // Multiple recipients: send sequentially so we stay well under the rate limiter and WhatsApp's
    // anti-abuse radar, updating a live progress counter. Individual failures are tallied, not fatal.
    setIsSending(true);
    let done = 0;
    let failed = 0;
    setSendProgress({ total: recipients.length, done, failed });
    const delayMs = Math.max(0, Math.round(sendDelaySec * 1000));
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < recipients.length; i++) {
      try {
        await sendMutation.mutateAsync({
          sessionId: selectedSessionId,
          chatId: recipients[i],
          templateId: sendTarget.id,
          vars,
        });
      } catch {
        failed += 1;
      }
      done += 1;
      setSendProgress({ total: recipients.length, done, failed });
      // Pause between sends (not after the last one) to stay under the rate limiter / anti-abuse radar.
      if (i < recipients.length - 1 && delayMs > 0) await sleep(delayMs);
    }
    setIsSending(false);

    const sent = recipients.length - failed;
    setToast(
      failed === 0
        ? { type: 'success', message: t('templates.send.toasts.bulkSent', { sent, total: recipients.length }) }
        : { type: 'error', message: t('templates.send.toasts.bulkPartial', { sent, failed }) },
    );
    if (failed === 0) setSendTarget(null);
    else setSendProgress(null);
  };

  if (loadingSessions) {
    return (
      <div className="templates-page templates-loading">
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="templates-page">
      {toast && (
        <div className={`toast ${toast.type}`}>
          {toast.type === 'success' ? <Check size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <button className="toast-close" onClick={() => setToast(null)} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
      )}

      <PageHeader
        title={t('templates.title')}
        subtitle={t('templates.subtitle')}
        actions={
          <select
            className="templates-session-select"
            value={selectedSessionId}
            onChange={event => {
              setSelectedSessionId(event.target.value);
              resetForm();
            }}
          >
            {sessions.length === 0 && <option value="">{t('templates.noSessions')}</option>}
            {sessions.map(session => (
              <option key={session.id} value={session.id}>
                {session.name}
              </option>
            ))}
          </select>
        }
      />

      {sessions.length === 0 ? (
        <div className="templates-empty-page">
          <FileText size={48} strokeWidth={1} />
          <h3>{t('templates.empty.noSessionsTitle')}</h3>
          <p>{t('templates.empty.noSessionsDesc')}</p>
        </div>
      ) : (
        <div className="templates-workspace">
          <aside className="templates-library">
            <div className="templates-library-header">
              <div>
                <h2>{t('templates.savedTitle')}</h2>
                <span>{t('templates.count', { count: templates.length })}</span>
              </div>
              <button className="btn-primary templates-new-btn" onClick={resetForm} disabled={!canWrite}>
                <Plus size={16} />
                {t('templates.newTemplate')}
              </button>
            </div>

            <div className="templates-search">
              <Search size={16} />
              <input
                value={searchTerm}
                onChange={event => setSearchTerm(event.target.value)}
                placeholder={t('common.search')}
              />
            </div>

            {loadingTemplates ? (
              <div className="templates-loading-inline">
                <Loader2 className="animate-spin" size={24} />
              </div>
            ) : templates.length === 0 ? (
              <div className="templates-empty-list">
                <FileText size={40} strokeWidth={1} />
                <h3>{t('templates.empty.title')}</h3>
                <p>{t('templates.empty.description')}</p>
              </div>
            ) : filteredTemplates.length === 0 ? (
              <div className="templates-empty-list compact">
                <Search size={32} strokeWidth={1.5} />
                <h3>{t('templates.empty.title')}</h3>
              </div>
            ) : (
              <div className="template-list" role="list">
                {filteredTemplates.map(template => {
                  const templatePlaceholders = extractPlaceholders(template);
                  const isSelected = editingTemplate?.id === template.id;
                  return (
                    <button
                      key={template.id}
                      className={`template-list-item ${isSelected ? 'selected' : ''}`}
                      onClick={() => openEdit(template)}
                      type="button"
                    >
                      <span className="template-list-title">
                        {template.name}
                        {template.hasMedia && (
                          <span className="template-media-badge" title={t('templates.media.badge')}>
                            <Paperclip size={12} />
                            {t('templates.media.badge')}
                          </span>
                        )}
                      </span>
                      <span className="template-list-body">
                        {template.body || t(`templates.media.types.${template.mediaType ?? 'document'}`)}
                      </span>
                      <span className="template-list-meta">
                        {templatePlaceholders.length > 0
                          ? templatePlaceholders.map(key => `{{${key}}}`).join(' ')
                          : t('templates.noPlaceholders')}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          <section className="template-editor">
            <div className="template-editor-header">
              <div>
                <h2>{editingTemplate ? t('templates.editTitle') : t('templates.createTitle')}</h2>
                <p>{selectedSession ? t('templates.sessionHint', { name: selectedSession.name }) : ''}</p>
              </div>
              <div className="template-header-actions">
                {editingTemplate && (
                  <button
                    className="btn-primary btn-sm"
                    title={t('templates.send.button')}
                    onClick={() => openSend(editingTemplate)}
                    type="button"
                  >
                    <Send size={15} />
                    {t('templates.send.button')}
                  </button>
                )}
                {editingTemplate && (
                  <button
                    className="icon-btn"
                    title={t('templates.actions.copyName')}
                    onClick={() => void copyName(editingTemplate.name)}
                    type="button"
                  >
                    <Copy size={16} />
                  </button>
                )}
                {editingTemplate && canWrite && (
                  <button
                    className="icon-btn danger"
                    title={t('common.delete')}
                    onClick={() => setDeleteTarget(editingTemplate)}
                    type="button"
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>

            <div className="template-form">
              <div className="form-group">
                <label>{t('common.name')}</label>
                <input
                  value={form.name}
                  onChange={event => setForm({ ...form, name: event.target.value })}
                  placeholder={t('templates.namePlaceholder')}
                  disabled={!canWrite}
                />
              </div>

              <div className="template-message-fields">
                <div className="form-group">
                  <label>{t('templates.header')}</label>
                  <input
                    value={form.header}
                    onChange={event => setForm({ ...form, header: event.target.value })}
                    placeholder={t('templates.headerPlaceholder')}
                    disabled={!canWrite}
                  />
                </div>

                <div className="form-group body-field">
                  <label>{t('templates.body')}</label>
                  <textarea
                    value={form.body}
                    onChange={event => setForm({ ...form, body: event.target.value })}
                    placeholder={t('templates.bodyPlaceholder')}
                    rows={10}
                    disabled={!canWrite}
                  />
                </div>

                <div className="form-group">
                  <label>{t('templates.footer')}</label>
                  <input
                    value={form.footer}
                    onChange={event => setForm({ ...form, footer: event.target.value })}
                    placeholder={t('templates.footerPlaceholder')}
                    disabled={!canWrite}
                  />
                </div>

                <div className="form-group template-media-field">
                  <label>{t('templates.media.label')}</label>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
                    style={{ display: 'none' }}
                    onChange={handleFileSelect}
                    disabled={!canWrite}
                  />

                  {form.mediaPreviewUrl && form.mediaType ? (
                    <div className="template-media-attached">
                      <div className="template-media-preview">
                        {form.mediaType === 'image' ? (
                          <img src={form.mediaPreviewUrl} alt={form.filename || ''} />
                        ) : form.mediaType === 'video' ? (
                          <video src={form.mediaPreviewUrl} controls />
                        ) : form.mediaType === 'audio' ? (
                          <audio src={form.mediaPreviewUrl} controls />
                        ) : (
                          <div className="template-media-fileicon">
                            <FileText size={28} />
                          </div>
                        )}
                      </div>
                      <div className="template-media-meta">
                        <span className="template-media-name">
                          {form.filename || t(`templates.media.types.${form.mediaType}`)}
                        </span>
                        <span className="template-media-kind">{t(`templates.media.types.${form.mediaType}`)}</span>
                      </div>
                      {canWrite && (
                        <button className="icon-btn danger" type="button" title={t('templates.media.remove')} onClick={clearMedia}>
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  ) : form.existingMediaType && !form.removeMedia ? (
                    <div className="template-media-attached">
                      <div className="template-media-preview">
                        {form.existingMediaType === 'image' ? (
                          <ImageIcon size={24} />
                        ) : form.existingMediaType === 'video' ? (
                          <Film size={24} />
                        ) : form.existingMediaType === 'audio' ? (
                          <Music size={24} />
                        ) : (
                          <FileText size={24} />
                        )}
                      </div>
                      <div className="template-media-meta">
                        <span className="template-media-name">
                          {form.existingFilename
                            ? t('templates.media.current', {
                                type: t(`templates.media.types.${form.existingMediaType}`),
                                name: form.existingFilename,
                              })
                            : t('templates.media.currentNoName', {
                                type: t(`templates.media.types.${form.existingMediaType}`),
                              })}
                        </span>
                        <span className="template-media-kind">{t('templates.media.previewUnavailable')}</span>
                      </div>
                      {canWrite && (
                        <div className="template-media-actions">
                          <button
                            className="btn-secondary btn-sm"
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                          >
                            <Paperclip size={14} />
                            {t('templates.media.replace')}
                          </button>
                          <button className="icon-btn danger" type="button" title={t('templates.media.remove')} onClick={clearMedia}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="template-media-empty">
                      <button
                        className="btn-secondary"
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={!canWrite}
                      >
                        <Paperclip size={16} />
                        {t('templates.media.add')}
                      </button>
                      <p className="template-media-hint">{t('templates.media.hint')}</p>
                    </div>
                  )}
                </div>
              </div>

              <div className="template-editor-actions">
                <button className="btn-secondary" onClick={resetForm} disabled={isSaving} type="button">
                  {t('common.cancel')}
                </button>
                <button
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={!canWrite || isSaving || !selectedSessionId || !canSave}
                  type="button"
                >
                  {isSaving ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
                  {canWrite ? t(editingTemplate ? 'templates.saveChanges' : 'templates.createTemplate') : t('templates.viewOnly')}
                </button>
              </div>
            </div>
          </section>

          <aside className="template-preview">
            <div className="template-preview-header">
              <h2>{t('templates.previewTitle')}</h2>
              <span>{placeholders.length}</span>
            </div>
            <div className="template-preview-message">
              <pre>{preview || t('templates.previewEmpty')}</pre>
            </div>
            <div className="template-variable-panel">
              {placeholders.length > 0 ? (
                <div className="placeholder-list">
                  {placeholders.map(key => (
                    <label key={key}>
                      <span>{`{{${key}}}`}</span>
                      <input
                        value={previewValues[key] || ''}
                        onChange={event => setPreviewValues({ ...previewValues, [key]: event.target.value })}
                        placeholder={t('templates.previewValuePlaceholder')}
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="template-muted">{t('templates.noPlaceholders')}</p>
              )}
            </div>
          </aside>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-overlay" onClick={() => setDeleteTarget(null)}>
          <div className="modal modal-sm" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('templates.deleteTitle')}</h2>
              <button className="btn-icon" onClick={() => setDeleteTarget(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>{t('templates.deleteConfirm', { name: deleteTarget.name })}</p>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setDeleteTarget(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={handleDelete} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? <Loader2 size={18} className="animate-spin" /> : <Trash2 size={18} />}
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {sendTarget && (
        <div className="modal-overlay" onClick={closeSend}>
          <div className="modal modal-lg" onClick={event => event.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('templates.send.title', { name: sendTarget.name })}</h2>
              <button className="btn-icon" onClick={closeSend} disabled={isSending}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body template-send-body">
              {sendTarget.hasMedia && (
                <div className="template-send-media-note">
                  <Paperclip size={14} />
                  {t(`templates.media.types.${sendTarget.mediaType ?? 'document'}`)}
                </div>
              )}

              {/* Recipient source: existing session chats, or a manual / CSV list. */}
              <div className="template-send-tabs">
                <button
                  type="button"
                  className={`template-send-tab ${sendMode === 'chats' ? 'active' : ''}`}
                  onClick={() => setSendMode('chats')}
                  disabled={isSending}
                >
                  {t('templates.send.mode.chats')}
                </button>
                <button
                  type="button"
                  className={`template-send-tab ${sendMode === 'manual' ? 'active' : ''}`}
                  onClick={() => setSendMode('manual')}
                  disabled={isSending}
                >
                  {t('templates.send.mode.manual')}
                </button>
              </div>

              {sendMode === 'chats' ? (
                <div className="form-group">
                  <div className="template-send-search">
                    <Search size={16} />
                    <input
                      value={chatSearch}
                      onChange={event => setChatSearch(event.target.value)}
                      placeholder={t('templates.send.searchChats')}
                      disabled={isSending}
                    />
                  </div>
                  <div className="template-chat-list">
                    {loadingChats ? (
                      <div className="template-chat-loading">
                        <Loader2 className="animate-spin" size={22} />
                      </div>
                    ) : filteredChats.length === 0 ? (
                      <p className="template-muted">{t('templates.send.noChats')}</p>
                    ) : (
                      filteredChats.map(chat => (
                        <label key={chat.id} className="template-chat-item">
                          <input
                            type="checkbox"
                            checked={selectedChatIds.includes(chat.id)}
                            onChange={() => toggleChat(chat.id)}
                            disabled={isSending}
                          />
                          <span className="template-chat-name">{chat.name || chat.id}</span>
                          {chat.isGroup && <span className="template-chat-tag">{t('templates.send.groupTag')}</span>}
                        </label>
                      ))
                    )}
                  </div>
                </div>
              ) : (
                <div className="form-group">
                  <label>{t('templates.send.manualLabel')}</label>
                  <textarea
                    value={manualText}
                    onChange={event => setManualText(event.target.value)}
                    placeholder={t('templates.send.manualPlaceholder')}
                    rows={6}
                    disabled={isSending}
                  />
                  <div className="template-send-manual-actions">
                    <input
                      ref={csvInputRef}
                      type="file"
                      accept=".csv,text/csv,text/plain"
                      style={{ display: 'none' }}
                      onChange={handleCsvUpload}
                    />
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      onClick={() => csvInputRef.current?.click()}
                      disabled={isSending}
                    >
                      <Upload size={14} />
                      {t('templates.send.uploadCsv')}
                    </button>
                    <span className="template-send-hint">{t('templates.send.csvHint')}</span>
                  </div>
                </div>
              )}

              {Object.keys(sendVars).length > 0 && (
                <div className="form-group">
                  <label>{t('templates.send.variables')}</label>
                  <span className="template-send-hint">{t('templates.send.variablesHint')}</span>
                  <div className="placeholder-list">
                    {Object.keys(sendVars).map(key => (
                      <label key={key}>
                        <span>{`{{${key}}}`}</span>
                        <input
                          value={sendVars[key]}
                          onChange={event => setSendVars({ ...sendVars, [key]: event.target.value })}
                          placeholder={t('templates.previewValuePlaceholder')}
                          disabled={isSending}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="form-group template-send-delay">
                <label>{t('templates.send.delayLabel')}</label>
                <input
                  type="number"
                  min={0}
                  max={120}
                  step={1}
                  value={sendDelaySec}
                  onChange={event => setSendDelaySec(Math.max(0, Math.min(120, Number(event.target.value) || 0)))}
                  disabled={isSending}
                />
                <span className="template-send-hint">{t('templates.send.delayHint')}</span>
              </div>

              <div className="template-send-summary">
                {tooManyRecipients ? (
                  <span className="template-send-warn">
                    {t('templates.send.tooMany', { max: BULK_MAX_RECIPIENTS })}
                  </span>
                ) : (
                  <span>{t('templates.send.recipientsSummary', { count: sendRecipients.length })}</span>
                )}
                {sendProgress && (
                  <span className="template-send-progress">
                    {t('templates.send.progress', { done: sendProgress.done, total: sendProgress.total })}
                  </span>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={closeSend} disabled={isSending}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleSendTemplate}
                disabled={isSending || sendRecipients.length === 0 || tooManyRecipients}
              >
                {isSending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                {isSending ? t('templates.send.sending') : t('templates.send.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
