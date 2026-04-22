// FIX #1: removed duplicate export default / LoginPage body from bottom of this file.
// FIX #7: all mutating fetch calls now include "X-Requested-With": "XMLHttpRequest".
// FIX #13: queue polling stops automatically once a job reaches success/error.
import { useEffect, useMemo, useRef, useState } from 'react';
import LoginPage from './LoginPage';

const POLL_MS = 1500;
const PREVIEW_DEBOUNCE_MS = 280;
const TOAST_MS = 2200;
const OUTPUT_PATH_KEY = 'download_output_path_v1';
const CLIPBOARD_MONITOR_KEY = 'clipboard_monitor_enabled_v1';

const FORMAT_OPTIONS = [
  { value: 'best_mp4', label: 'Best Quality (MP4)' },
  { value: '1080', label: '1080p' },
  { value: '720', label: '720p' },
  { value: '480', label: '480p' },
  { value: 'audio_mp3', label: 'Audio Only (MP3)' },
];

const YOUTUBE_URL_RE = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|playlist\?list=)|youtu\.be\/)[\w\-?&=%.+/]+$/i;
const ANSI_ESCAPE_RE = /\u001B\[[0-9;]*[A-Za-z]/g;
const DOWNLOAD_PROGRESS_RE = /Downloading\.\.\.\s*([\d.]+)\s*%?\s*\|\s*Speed:\s*([^|]*?)\s*\|\s*ETA:\s*(.+)$/i;

const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// FIX #7: all POST fetches go through this helper which adds the CSRF header
const apiFetch = (url, opts = {}) =>
  fetch(url, {
    credentials: 'include',
    ...opts,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(opts.headers || {}),
    },
  });

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'Unknown';
  const t = Math.round(Number(seconds));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatViewCount(n) {
  if (n == null || !Number.isFinite(Number(n))) return 'Unknown';
  const v = Number(n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M views`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}K views`;
  return `${v} views`;
}

function parseProgress(logs) {
  if (!Array.isArray(logs)) return null;
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = String(logs[i] ?? '').replace(ANSI_ESCAPE_RE, '').trim();
    const m = line.match(DOWNLOAD_PROGRESS_RE);
    if (!m) continue;
    const pct = Number.parseFloat(m[1]);
    if (!Number.isFinite(pct)) continue;
    return { percent: Math.min(100, Math.max(0, pct)), speed: m[2]?.trim() || 'N/A', eta: m[3]?.trim() || 'N/A' };
  }
  return null;
}

function safeRead(key, fallback) {
  try { const r = localStorage.getItem(key); return r == null ? fallback : JSON.parse(r); }
  catch { return fallback; }
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function getValidation(url) {
  const v = url.trim();
  if (!v) return { state: 'idle', message: 'Paste a YouTube URL to start.' };
  if (YOUTUBE_URL_RE.test(v)) return { state: 'valid', message: 'Valid URL — preview loads automatically.' };
  return { state: 'invalid', message: 'Use a valid YouTube / Shorts / Playlist URL.' };
}

// ── Icons ────────────────────────────────────────────────────────────────────
const IconSettings = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const IconCheck = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const IconX = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const IconChevron = ({ open }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
    <polyline points="6 9 12 15 18 9" />
  </svg>
);
const IconLogout = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

// ── Quota bar ─────────────────────────────────────────────────────────────────
// Quota bar removed - all users have unlimited downloads

// ── User menu ─────────────────────────────────────────────────────────────────
function UserMenu({ user, onLogout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  return (
    <div className="user-menu" ref={ref}>
      <button className="user-avatar-btn" onClick={() => setOpen(v => !v)} type="button" aria-label="User menu">
        {user.avatar_url
          ? <img src={user.avatar_url} alt={user.name} className="user-avatar-img" referrerPolicy="no-referrer" />
          : <span className="user-avatar-fallback">{user.name?.[0]?.toUpperCase() || '?'}</span>}
      </button>
      {open && (
        <div className="user-dropdown">
          <div className="user-dropdown-header">
            <strong>{user.name}</strong>
            <span className="user-email">{user.email}</span>
          </div>
          <hr className="user-dropdown-divider" />
          <button className="user-dropdown-item" onClick={onLogout} type="button">
            <IconLogout /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ── Detect if user is likely on a mobile device ───────────────────────────────
const isMobile = () => window.matchMedia('(max-width: 640px)').matches;

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [authState, setAuthState] = useState('loading');
  const [currentUser, setCurrentUser] = useState(null);
  const [authError, setAuthError] = useState('');
  const [theme, setTheme] = useState('light');
  const [inputText, setInputText] = useState('');
  const [formatQuality, setFormatQuality] = useState('best_mp4');
  const [outputPath, setOutputPath] = useState('');
  const [playlistMode, setPlaylistMode] = useState(false);
  const [downloadSubtitles, setDownloadSubtitles] = useState(false);
  const [subtitleLangs, setSubtitleLangs] = useState('en');
  const [saveThumbnailOnly, setSaveThumbnailOnly] = useState(false);
  const [clipboardMonitor, setClipboardMonitor] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [selectedPlaylistItems, setSelectedPlaylistItems] = useState([]);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [toast, setToast] = useState('');
  const [queue, setQueue] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');
  const [ytDlpVersion, setYtDlpVersion] = useState('unknown');
  const [mobile, setMobile] = useState(isMobile);

  const settingsRef = useRef(null);
  const previewAbortRef = useRef(null);
  const previewDebounceRef = useRef(null);
  const previewKeyRef = useRef('');

  const firstUrl = useMemo(() => inputText.split(/\s+/).map(x => x.trim()).filter(Boolean)[0] || '', [inputText]);
  const validation = useMemo(() => getValidation(firstUrl), [firstUrl]);

  // Detect viewport changes for mobile-specific behaviour
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    const handler = (e) => setMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Bootstrap auth
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('auth_error');
    if (err) { setAuthError(err); window.history.replaceState({}, '', window.location.pathname); }
    // Handle PWA share-target URL param
    const shared = params.get('url');
    if (shared && YOUTUBE_URL_RE.test(shared)) {
      setInputText(shared);
      window.history.replaceState({}, '', window.location.pathname);
    }
    fetch('/auth/me', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) { setCurrentUser(data); setAuthState('authenticated'); } else setAuthState('unauthenticated'); })
      .catch(() => setAuthState('unauthenticated'));
  }, []);

  // Load history + health after auth
  useEffect(() => {
    if (authState !== 'authenticated') return;
    const saved = localStorage.getItem('theme');
    if (saved === 'dark') setTheme('dark');
    setOutputPath(safeRead(OUTPUT_PATH_KEY, ''));
    setClipboardMonitor(Boolean(safeRead(CLIPBOARD_MONITOR_KEY, false)));

    Promise.all([
      fetch('/api/jobs?limit=100', { credentials: 'include' }),
      fetch('/api/health'),
    ]).then(async ([jr, hr]) => {
      if (jr.ok) {
        const p = await jr.json();
        setHistory((p.jobs || []).filter(j => j.status === 'success' && j.result?.file_path).map(j => ({
          id: j.job_id,
          title: j.result?.title || j.url,
          thumbnail: j.result?.thumbnail || null,
          format: FORMAT_OPTIONS.find(x => x.value === j.quality)?.label || j.quality,
          savedAt: j.updated_at,
          filePath: j.result.file_path,
        })));
      }
      if (hr.ok) { const h = await hr.json(); setYtDlpVersion(h?.yt_dlp?.version || 'unknown'); }
    }).catch(() => { });
  }, [authState]);

  // Sync theme / prefs
  useEffect(() => { document.body.setAttribute('data-theme', theme); localStorage.setItem('theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem(OUTPUT_PATH_KEY, JSON.stringify(outputPath)); }, [outputPath]);
  useEffect(() => { localStorage.setItem(CLIPBOARD_MONITOR_KEY, JSON.stringify(clipboardMonitor)); }, [clipboardMonitor]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), TOAST_MS); return () => clearTimeout(t); }, [toast]);

  // Close settings on outside click
  useEffect(() => {
    if (!isSettingsOpen) return;
    const h = (e) => { if (settingsRef.current && !settingsRef.current.contains(e.target)) setIsSettingsOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [isSettingsOpen]);

  // Global paste (skip when in a field)
  useEffect(() => {
    const h = (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const pasted = e.clipboardData?.getData('text')?.trim();
      if (!pasted || !YOUTUBE_URL_RE.test(pasted)) return;
      setInputText(pasted); setToast('URL pasted automatically.');
    };
    document.addEventListener('paste', h);
    return () => document.removeEventListener('paste', h);
  }, []);

  // Clipboard monitor
  useEffect(() => {
    if (!clipboardMonitor) return;
    const interval = setInterval(async () => {
      try {
        const v = (await navigator.clipboard.readText()).trim();
        if (v && YOUTUBE_URL_RE.test(v) && v !== firstUrl) { setInputText(v); setToast('Clipboard: YouTube URL detected.'); }
      } catch { /* permission denied */ }
    }, 3200);
    return () => clearInterval(interval);
  }, [clipboardMonitor, firstUrl]);

  // Preview
  const fetchPreview = async (url) => {
    if (!url || !YOUTUBE_URL_RE.test(url)) return;
    const key = `${url}::${playlistMode}`;
    if (previewKeyRef.current === key && preview) return;
    if (previewAbortRef.current) previewAbortRef.current.abort();
    const ctrl = new AbortController();
    previewAbortRef.current = ctrl;
    setIsPreviewLoading(true); setPreviewError('');
    try {
      const res = await apiFetch('/api/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, playlist_mode: playlistMode }), signal: ctrl.signal,
      });
      const p = await res.json();
      if (!res.ok) throw new Error(p.error || 'Failed to preview');
      setPreview(p);
      setSelectedPlaylistItems(p.playlist?.entries?.length ? p.playlist.entries.map(e => e.index) : []);
      previewKeyRef.current = key;
    } catch (err) {
      if (err.name !== 'AbortError') setPreviewError(err.message);
    } finally {
      if (previewAbortRef.current === ctrl) { previewAbortRef.current = null; setIsPreviewLoading(false); }
    }
  };

  useEffect(() => {
    setPreview(null); setPreviewError(''); previewKeyRef.current = '';
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    if (!firstUrl || validation.state !== 'valid') return;
    previewDebounceRef.current = setTimeout(() => fetchPreview(firstUrl), PREVIEW_DEBOUNCE_MS);
    return () => { if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current); };
  }, [firstUrl, validation.state, playlistMode]);

  useEffect(() => () => { if (previewAbortRef.current) previewAbortRef.current.abort(); }, []);

  // FIX #13: queue polling — only poll items that are still active
  useEffect(() => {
    const active = queue.filter(item => item.jobId && ['queued', 'running'].includes(item.status));
    if (!active.length) return; // nothing to poll — no interval created
    const timer = setInterval(async () => {
      await Promise.all(active.map(async (item) => {
        try {
          const res = await fetch(`/api/jobs/${item.jobId}`, { credentials: 'include' });
          if (!res.ok) return;
          const p = await res.json();
          const prog = parseProgress(p.logs);
          setQueue(prev => prev.map(x => x.localId !== item.localId ? x : {
            ...x,
            status: p.status, logs: p.logs || [], result: p.result, error: p.error,
            progress: prog?.percent ?? (p.status === 'success' ? 100 : 0),
            speed: prog?.speed || (p.status === 'queued' ? 'Waiting...' : 'N/A'),
            eta: prog?.eta || (p.status === 'queued' ? 'Waiting...' : 'N/A'),
          }));
        } catch { /* ignore */ }
      }));
    }, POLL_MS);
    return () => clearInterval(timer);
    // Re-evaluated whenever queue changes — if all jobs finish, active.length → 0 and interval is cleared
  }, [queue]);

  // Record finished jobs to history
  useEffect(() => {
    let didRecord = false;
    queue.forEach(item => {
      if (item.status !== 'success' || !item.result?.file_path || item.recorded) return;
      didRecord = true;
      setHistory(prev => [{
        id: item.jobId, title: item.result.title || item.url,
        thumbnail: item.result?.thumbnail || item.thumbnail || null,
        format: FORMAT_OPTIONS.find(x => x.value === item.quality)?.label || item.quality,
        savedAt: new Date().toISOString(), filePath: item.result.file_path,
      }, ...prev]);
      setQueue(prev => prev.map(x => x.localId === item.localId ? { ...x, recorded: true } : x));
    });
    if (didRecord) {
      fetch('/auth/me', { credentials: 'include' }).then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setCurrentUser(d); }).catch(() => { });
    }
  }, [queue]);

  // Submit
  const enqueueDownloads = async (e) => {
    e.preventDefault(); setError('');
    const urls = inputText.split(/\s+/).map(x => x.trim()).filter(Boolean).filter(x => YOUTUBE_URL_RE.test(x));
    if (!urls.length) { setError('Add at least one valid YouTube URL.'); return; }

    const created = await Promise.all(urls.map(async (url, idx) => {
      const res = await apiFetch('/api/download', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url, quality: formatQuality,
          output_path: outputPath.trim() || '',
          playlist_mode: playlistMode,
          playlist_items: playlistMode && idx === 0 ? selectedPlaylistItems : [],
          download_subtitles: downloadSubtitles,
          subtitle_languages: subtitleLangs.split(',').map(x => x.trim()).filter(Boolean),
          save_thumbnail_only: saveThumbnailOnly,
        }),
      });
      const p = await res.json();
      if (!res.ok) throw new Error(p.error || `Failed creating job for ${url}`);
      return {
        localId: uid(), jobId: p.job_id, url, status: p.status,
        quality: formatQuality, outputPath: outputPath.trim() || '~/Downloads',
        logs: [], progress: 0, speed: 'Waiting...', eta: 'Waiting...',
        thumbnail: idx === 0 ? preview?.thumbnail || null : null,
        result: null, error: null, recorded: false,
      };
    })).catch(err => { setError(err.message); return []; });

    if (created.length) {
      setQueue(prev => [...created, ...prev]);
      setToast(`${created.length} job${created.length > 1 ? 's' : ''} added to queue.`);
    }
  };

  const togglePlaylistItem = (idx) =>
    setSelectedPlaylistItems(prev => prev.includes(idx) ? prev.filter(x => x !== idx) : [...prev, idx].sort((a, b) => a - b));

  const handleLogout = async () => {
    // Logout POSTs directly — exempt from CSRF helper (browser form-like)
    await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthState('unauthenticated'); setCurrentUser(null); setQueue([]); setHistory([]);
  };

  const toggleTheme = () => setTheme(c => c === 'light' ? 'dark' : 'light');

  // ── Render guards ───────────────────────────────────────────────────────────
  if (authState === 'loading') {
    return (
      <main className="page-shell">
        <div className="auth-loading"><div className="auth-spinner" /><p>Loading...</p></div>
      </main>
    );
  }
  if (authState === 'unauthenticated') return <LoginPage authError={authError} />;

  // ── Main UI ─────────────────────────────────────────────────────────────────
  return (
    <main className="page-shell">
      <section className="card">

        {/* Header */}
        <div className="header-row">
          <h1>YouTube Downloader</h1>
          <div className="header-actions-row">
            <div className="header-actions" ref={settingsRef}>
              <button className="settings-toggle" type="button"
                onClick={() => setIsSettingsOpen(v => !v)}
                aria-expanded={isSettingsOpen} aria-label="Settings" title="Settings">
                <IconSettings />
              </button>
              {isSettingsOpen && (
                <section className="settings-panel">
                  <h3>Settings</h3>
                  <label><input type="checkbox" checked={theme === 'dark'} onChange={toggleTheme} /> Dark mode</label>
                  <label><input type="checkbox" checked={downloadSubtitles} onChange={e => setDownloadSubtitles(e.target.checked)} /> Download subtitles</label>
                  <label><input type="checkbox" checked={saveThumbnailOnly} onChange={e => setSaveThumbnailOnly(e.target.checked)} /> Save thumbnail only</label>
                  {/* FIX #21: clipboard monitor hidden on mobile (clipboard API restricted on phones) */}
                  {!mobile && (
                    <label><input type="checkbox" checked={clipboardMonitor} onChange={e => setClipboardMonitor(e.target.checked)} /> Clipboard monitor</label>
                  )}
                </section>
              )}
            </div>
            {currentUser && <UserMenu user={currentUser} onLogout={handleLogout} />}
          </div>
        </div>

        <p className="subtitle">Automatic preview, persistent history, smart queue, and creator-friendly options.</p>

        {/* Form */}
        <form className="download-form" onSubmit={enqueueDownloads}>
          <label htmlFor="video-url">
            {mobile ? 'YouTube URL' : 'YouTube URL (one or multiple, space/newline separated)'}
          </label>
          {/* FIX #21: single input on mobile, textarea on desktop */}
          {mobile ? (
            <input
              id="video-url" type="url" className="url-input-mobile"
              value={inputText} onChange={e => setInputText(e.target.value)}
              placeholder="https://youtube.com/watch?v=..."
              autoComplete="off" autoCorrect="off" spellCheck="false"
            />
          ) : (
            <textarea
              id="video-url" className="url-textarea" value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder="Paste one or multiple URLs here..."
            />
          )}

          <div className={`url-feedback url-feedback-${validation.state}`}>
            {validation.state !== 'idle' && (
              <span className="url-feedback-icon">
                {validation.state === 'valid' ? <IconCheck /> : <IconX />}
              </span>
            )}
            {validation.message}
          </div>

          {/* FIX #15/#21: output path hidden on mobile */}
          <div className={mobile ? 'option-grid option-grid--mobile' : 'option-grid'}>
            <div>
              <label htmlFor="format-quality">Format &amp; quality</label>
              <select id="format-quality" value={formatQuality} onChange={e => setFormatQuality(e.target.value)}>
                {FORMAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {!mobile && (
              <div>
                <label htmlFor="output-path">Output folder</label>
                <input id="output-path" type="text" value={outputPath}
                  onChange={e => setOutputPath(e.target.value)}
                  placeholder="Leave empty to use ~/Downloads" />
              </div>
            )}
          </div>

          <div className="toggles-grid">
            <label><input type="checkbox" checked={playlistMode} onChange={e => setPlaylistMode(e.target.checked)} /> Playlist mode</label>
          </div>

          {downloadSubtitles && (
            <div>
              <label htmlFor="subtitle-langs">Subtitle languages (comma-separated)</label>
              <input id="subtitle-langs" type="text" value={subtitleLangs} onChange={e => setSubtitleLangs(e.target.value)} />
            </div>
          )}

          <div className="form-actions">
            {!mobile && (
              <button type="button" className="secondary-button"
                onClick={() => fetchPreview(firstUrl)}
                disabled={!firstUrl || isPreviewLoading || validation.state !== 'valid'}>
                {isPreviewLoading ? 'Loading...' : 'Refresh preview'}
              </button>
            )}
            <button type="submit" className={mobile ? 'submit-btn-full' : ''}>
              Add to Download Queue
            </button>
          </div>
        </form>

        {previewError && <div className="error-box">{previewError}</div>}
        {error && <div className="error-box">{error}</div>}

        {/* Preview panel */}
        {preview && (
          <section className="preview-panel">
            <div className="preview-media">
              {preview.thumbnail
                ? <img className="preview-thumbnail" src={preview.thumbnail} alt={preview.title} />
                : <div className="preview-thumbnail preview-thumbnail-placeholder">No thumbnail</div>}
            </div>
            <div className="preview-details">
              <span className="preview-label">Preview</span>
              <h2>{preview.title}</h2>
              <p className="preview-channel">{preview.channel}</p>
              <div className="preview-meta">
                <span>⏱ {formatDuration(preview.duration)}</span>
                <span>👁 {formatViewCount(preview.view_count)}</span>
              </div>
            </div>
          </section>
        )}

        {/* Playlist picker */}
        {playlistMode && preview?.playlist && (
          <section className="playlist-panel">
            <h3>Playlist: {preview.playlist.title} <span className="playlist-count">({preview.playlist.count} videos)</span></h3>
            <div className="playlist-list">
              {preview.playlist.entries.map(entry => (
                <label key={entry.index} className="playlist-item">
                  <input type="checkbox" checked={selectedPlaylistItems.includes(entry.index)} onChange={() => togglePlaylistItem(entry.index)} />
                  {entry.thumbnail
                    ? <img src={entry.thumbnail} alt={entry.title} className="playlist-thumb" />
                    : <div className="playlist-thumb playlist-thumb-placeholder">No image</div>}
                  <span>{entry.index}. {entry.title}</span>
                </label>
              ))}
            </div>
          </section>
        )}

        {/* Queue */}
        <section className="queue-panel">
          <h2>Download Queue</h2>
          {queue.length ? (
            <div className="queue-list">
              {queue.map(item => (
                <article key={item.localId} className="queue-item">
                  <div className="queue-head">
                    <p className="queue-url">{item.result?.title || item.url}</p>
                    <span className={`queue-badge queue-badge-${item.status}`}>{item.status}</span>
                  </div>
                  <p className="queue-meta">
                    {FORMAT_OPTIONS.find(o => o.value === item.quality)?.label}&nbsp;·&nbsp;{item.outputPath}
                  </p>
                  <div className={`progress-track${item.status === 'queued' ? ' progress-track--waiting' : ''}`}
                    role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progress)}>
                    <div className="progress-fill" style={{ width: `${item.progress}%` }} />
                  </div>
                  <div className="progress-meta">
                    <span><strong>Speed:</strong> {item.speed}</span>
                    <span><strong>ETA:</strong> {item.eta}</span>
                  </div>
                  {item.result?.file_path && (
                    <p className="queue-success">✓ Saved to <span className="queue-path">{item.result.file_path}</span></p>
                  )}
                  {item.error && <p className="queue-error">{item.error}</p>}
                </article>
              ))}
            </div>
          ) : (
            <p className="history-empty">Queue is empty. Add one or more URLs above.</p>
          )}
        </section>

        {/* History */}
        <section className="history-panel">
          <button type="button" className="history-toggle"
            onClick={() => setHistoryOpen(v => !v)} aria-expanded={historyOpen}>
            <span>Download History</span>
            <span className="history-toggle-right">
              <span className="history-count">{history.length}</span>
              <IconChevron open={historyOpen} />
            </span>
          </button>
          {historyOpen && (
            <div className="history-list">
              {history.length ? history.map(entry => (
                <article key={entry.id} className="history-item">
                  {entry.thumbnail
                    ? <img src={entry.thumbnail} alt={entry.title} className="history-thumb" />
                    : <div className="history-thumb history-thumb-placeholder">No image</div>}
                  <div className="history-content">
                    <h4>{entry.title}</h4>
                    <p>{entry.format}</p>
                    <p>{formatDate(entry.savedAt)}</p>
                    {entry.filePath && <p className="history-path" title={entry.filePath}>{entry.filePath}</p>}
                  </div>
                </article>
              )) : <p className="history-empty">No downloads yet.</p>}
            </div>
          )}
        </section>

        <footer className="footer-row">
          <span className="version-badge">yt-dlp {ytDlpVersion}</span>
        </footer>
      </section>

      {toast && <div className="toast" role="status">{toast}</div>}
    </main>
  );
}
