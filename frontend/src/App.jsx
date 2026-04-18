import { useEffect, useMemo, useRef, useState } from 'react';

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

const YOUTUBE_URL_RE =
  /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|playlist\?list=)|youtu\.be\/)[\w\-?&=%.+/]+$/i;
const ANSI_ESCAPE_RE = /\u001B\[[0-9;]*[A-Za-z]/g;
const DOWNLOAD_PROGRESS_RE =
  /Downloading\.\.\.\s*([\d.]+)\s*%?\s*\|\s*Speed:\s*([^|]*?)\s*\|\s*ETA:\s*(.+)$/i;

const uid = () => `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// Format raw seconds (number) into a human-readable "H:MM:SS" / "M:SS" string.
function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'Unknown';
  const total = Math.round(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Format a raw view count number into a compact string (e.g. 1.4M, 230K).
function formatViewCount(count) {
  if (count == null || !Number.isFinite(Number(count))) return 'Unknown';
  const n = Number(count);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K views`;
  return `${n} views`;
}

function parseProgress(logs) {
  if (!Array.isArray(logs)) return null;
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = String(logs[i] ?? '').replace(ANSI_ESCAPE_RE, '').trim();
    const match = line.match(DOWNLOAD_PROGRESS_RE);
    if (!match) continue;
    const percent = Number.parseFloat(match[1]);
    if (!Number.isFinite(percent)) continue;
    return {
      percent: Math.min(100, Math.max(0, percent)),
      speed: match[2]?.trim() || 'N/A',
      eta: match[3]?.trim() || 'N/A',
    };
  }
  return null;
}

function safeRead(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function getValidation(url) {
  const value = url.trim();
  if (!value) return { state: 'idle', message: 'Paste a YouTube URL to start.' };
  if (YOUTUBE_URL_RE.test(value)) return { state: 'valid', message: 'Valid URL — preview loads automatically.' };
  return { state: 'invalid', message: 'Use a valid YouTube / Shorts / Playlist URL.' };
}

// Icon components keep JSX clean
function IconSettings() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function IconX() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconChevron({ open }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function App() {
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

  const settingsRef = useRef(null);
  const previewAbortRef = useRef(null);
  const previewDebounceRef = useRef(null);
  const previewKeyRef = useRef('');

  const firstUrl = useMemo(
    () => inputText.split(/\s+/).map((x) => x.trim()).filter(Boolean)[0] || '',
    [inputText],
  );
  const validation = useMemo(() => getValidation(firstUrl), [firstUrl]);

  // ── Initialise from localStorage & server ────────────────────────────────
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') setTheme('dark');
    setOutputPath(safeRead(OUTPUT_PATH_KEY, ''));
    setClipboardMonitor(Boolean(safeRead(CLIPBOARD_MONITOR_KEY, false)));
  }, []);

  useEffect(() => {
    const loadServerInfo = async () => {
      try {
        const [jobsResponse, healthResponse] = await Promise.all([
          fetch('/api/jobs?limit=100'),
          fetch('/api/health'),
        ]);
        if (jobsResponse.ok) {
          const jobsPayload = await jobsResponse.json();
          const successful = (jobsPayload.jobs || []).filter(
            (job) => job.status === 'success' && job.result?.file_path,
          );
          setHistory(
            successful.map((job) => ({
              id: job.job_id,
              title: job.result?.title || job.url,
              thumbnail: job.result?.thumbnail || null,
              format: FORMAT_OPTIONS.find((x) => x.value === job.quality)?.label || job.quality,
              savedAt: job.updated_at,
              filePath: job.result.file_path,
            })),
          );
        }
        if (healthResponse.ok) {
          const healthPayload = await healthResponse.json();
          setYtDlpVersion(healthPayload?.yt_dlp?.version || 'unknown');
        }
      } catch {
        // ignore startup fetch errors
      }
    };
    loadServerInfo();
  }, []);

  // ── Sync side-effects ─────────────────────────────────────────────────────
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(OUTPUT_PATH_KEY, JSON.stringify(outputPath));
  }, [outputPath]);

  useEffect(() => {
    localStorage.setItem(CLIPBOARD_MONITOR_KEY, JSON.stringify(clipboardMonitor));
  }, [clipboardMonitor]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  // ── Close settings panel when clicking outside ────────────────────────────
  useEffect(() => {
    if (!isSettingsOpen) return undefined;
    const handleClick = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setIsSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isSettingsOpen]);

  // ── Global paste detection ────────────────────────────────────────────────
  useEffect(() => {
    const onPaste = (event) => {
      // Don't intercept paste when user is typing in an input/textarea
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const pasted = event.clipboardData?.getData('text')?.trim();
      if (!pasted || !YOUTUBE_URL_RE.test(pasted)) return;
      setInputText(pasted);
      setToast('URL pasted automatically.');
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  // ── Clipboard monitor ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!clipboardMonitor) return undefined;
    const interval = setInterval(async () => {
      try {
        const value = (await navigator.clipboard.readText()).trim();
        if (value && YOUTUBE_URL_RE.test(value) && value !== firstUrl) {
          setInputText(value);
          setToast('Clipboard monitor detected a YouTube URL.');
        }
      } catch {
        // ignore permission errors
      }
    }, 3200);
    return () => clearInterval(interval);
  }, [clipboardMonitor, firstUrl]);

  // ── Preview fetching ──────────────────────────────────────────────────────
  const fetchPreview = async (url) => {
    if (!url || !YOUTUBE_URL_RE.test(url)) return;
    const previewKey = `${url}::${playlistMode}`;
    if (previewKeyRef.current === previewKey && preview) return;
    if (previewAbortRef.current) previewAbortRef.current.abort();
    const controller = new AbortController();
    previewAbortRef.current = controller;
    setIsPreviewLoading(true);
    setPreviewError('');
    try {
      const response = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, playlist_mode: playlistMode }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Failed to preview');
      setPreview(payload);
      if (payload.playlist?.entries?.length) {
        setSelectedPlaylistItems(payload.playlist.entries.map((entry) => entry.index));
      } else {
        setSelectedPlaylistItems([]);
      }
      previewKeyRef.current = previewKey;
    } catch (previewFetchError) {
      if (previewFetchError.name !== 'AbortError') {
        setPreviewError(previewFetchError.message);
      }
    } finally {
      if (previewAbortRef.current === controller) {
        previewAbortRef.current = null;
        setIsPreviewLoading(false);
      }
    }
  };

  useEffect(() => {
    setPreview(null);
    setPreviewError('');
    previewKeyRef.current = '';
    if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    if (!firstUrl || validation.state !== 'valid') return;
    previewDebounceRef.current = setTimeout(() => fetchPreview(firstUrl), PREVIEW_DEBOUNCE_MS);
    return () => {
      if (previewDebounceRef.current) clearTimeout(previewDebounceRef.current);
    };
  }, [firstUrl, validation.state, playlistMode]);

  useEffect(
    () => () => {
      if (previewAbortRef.current) previewAbortRef.current.abort();
    },
    [],
  );

  // ── Queue polling ─────────────────────────────────────────────────────────
  useEffect(() => {
    const active = queue.filter((item) => item.jobId && ['queued', 'running'].includes(item.status));
    if (!active.length) return undefined;
    const timer = setInterval(async () => {
      await Promise.all(
        active.map(async (item) => {
          try {
            const response = await fetch(`/api/jobs/${item.jobId}`);
            if (!response.ok) return;
            const payload = await response.json();
            const prog = parseProgress(payload.logs);
            setQueue((prev) =>
              prev.map((x) =>
                x.localId === item.localId
                  ? {
                      ...x,
                      status: payload.status,
                      logs: payload.logs || [],
                      result: payload.result,
                      error: payload.error,
                      progress: prog?.percent ?? (payload.status === 'success' ? 100 : 0),
                      speed: prog?.speed || (payload.status === 'queued' ? 'Waiting...' : 'N/A'),
                      eta: prog?.eta || (payload.status === 'queued' ? 'Waiting...' : 'N/A'),
                    }
                  : x,
              ),
            );
          } catch {
            // ignore
          }
        }),
      );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [queue]);

  // ── Record completed downloads to history ─────────────────────────────────
  useEffect(() => {
    queue.forEach((item) => {
      if (item.status !== 'success' || !item.result?.file_path || item.recorded) return;
      setHistory((prev) => [
        {
          id: item.jobId,
          title: item.result.title || item.url,
          thumbnail: item.result?.thumbnail || item.thumbnail || null,
          format: FORMAT_OPTIONS.find((x) => x.value === item.quality)?.label || item.quality,
          savedAt: new Date().toISOString(),
          filePath: item.result.file_path,
        },
        ...prev,
      ]);
      setQueue((prev) => prev.map((x) => (x.localId === item.localId ? { ...x, recorded: true } : x)));
    });
  }, [queue]);

  // ── Submit handler ────────────────────────────────────────────────────────
  const enqueueDownloads = async (event) => {
    event.preventDefault();
    setError('');
    const urls = inputText
      .split(/\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => YOUTUBE_URL_RE.test(x));
    if (!urls.length) {
      setError('Add at least one valid YouTube URL.');
      return;
    }

    // FIX: use the resolved output path (with fallback) consistently
    const resolvedOutputPath = outputPath.trim() || '';

    const created = await Promise.all(
      urls.map(async (url, idx) => {
        const body = {
          url,
          quality: formatQuality,
          output_path: resolvedOutputPath,
          playlist_mode: playlistMode,
          playlist_items: playlistMode && idx === 0 ? selectedPlaylistItems : [],
          download_subtitles: downloadSubtitles,
          subtitle_languages: subtitleLangs
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          save_thumbnail_only: saveThumbnailOnly,
        };
        const response = await fetch('/api/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || `Failed creating job for ${url}`);
        }
        return {
          localId: uid(),
          jobId: payload.job_id,
          url,
          status: payload.status,
          quality: formatQuality,
          outputPath: resolvedOutputPath || '~/Downloads',
          logs: [],
          progress: 0,
          speed: 'Waiting...',
          eta: 'Waiting...',
          thumbnail: idx === 0 ? preview?.thumbnail || null : null,
          result: null,
          error: null,
          recorded: false,
        };
      }),
    ).catch((enqueueError) => {
      setError(enqueueError.message);
      return [];
    });

    if (created.length) {
      setQueue((prev) => [...created, ...prev]);
      setToast(`${created.length} job${created.length > 1 ? 's' : ''} added to queue.`);
    }
  };

  const togglePlaylistItem = (index) => {
    setSelectedPlaylistItems((prev) =>
      prev.includes(index) ? prev.filter((x) => x !== index) : [...prev, index].sort((a, b) => a - b),
    );
  };

  const toggleTheme = () => setTheme((current) => (current === 'light' ? 'dark' : 'light'));

  return (
    <main className="page-shell">
      <section className="card">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div className="header-row">
          <h1>YouTube Downloader</h1>
          <div className="header-actions" ref={settingsRef}>
            <button
              className="settings-toggle"
              type="button"
              onClick={() => setIsSettingsOpen((current) => !current)}
              aria-expanded={isSettingsOpen}
              aria-label="Open settings"
              title="Settings"
            >
              <IconSettings />
            </button>
            {isSettingsOpen ? (
              <section className="settings-panel">
                <h3>Settings</h3>
                <label>
                  <input type="checkbox" checked={theme === 'dark'} onChange={toggleTheme} />
                  Dark mode
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={downloadSubtitles}
                    onChange={(e) => setDownloadSubtitles(e.target.checked)}
                  />
                  Download subtitles
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={saveThumbnailOnly}
                    onChange={(e) => setSaveThumbnailOnly(e.target.checked)}
                  />
                  Save thumbnail only
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={clipboardMonitor}
                    onChange={(e) => setClipboardMonitor(e.target.checked)}
                  />
                  Clipboard monitor
                </label>
              </section>
            ) : null}
          </div>
        </div>

        <p className="subtitle">
          Automatic preview, persistent history, smart queue limits, and creator-friendly download options.
        </p>

        {/* ── Download form ────────────────────────────────────────────── */}
        <form className="download-form" onSubmit={enqueueDownloads}>
          <label htmlFor="video-url">YouTube URL (one or multiple, space/newline separated)</label>
          <textarea
            id="video-url"
            className="url-textarea"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Paste one or multiple URLs here..."
          />

          {/* URL validation feedback with icon */}
          <div className={`url-feedback url-feedback-${validation.state}`}>
            {validation.state !== 'idle' && (
              <span className="url-feedback-icon">
                {validation.state === 'valid' ? <IconCheck /> : <IconX />}
              </span>
            )}
            {validation.message}
          </div>

          <div className="option-grid">
            <div>
              <label htmlFor="format-quality">Format &amp; quality</label>
              <select
                id="format-quality"
                value={formatQuality}
                onChange={(e) => setFormatQuality(e.target.value)}
              >
                {FORMAT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="output-path">Output folder</label>
              <input
                id="output-path"
                type="text"
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="Leave empty to use ~/Downloads"
              />
            </div>
          </div>

          <div className="toggles-grid">
            <label>
              <input
                type="checkbox"
                checked={playlistMode}
                onChange={(e) => setPlaylistMode(e.target.checked)}
              />
              Playlist mode
            </label>
          </div>

          {downloadSubtitles ? (
            <div>
              <label htmlFor="subtitle-langs">Subtitle languages (comma-separated)</label>
              <input
                id="subtitle-langs"
                type="text"
                value={subtitleLangs}
                onChange={(e) => setSubtitleLangs(e.target.value)}
              />
            </div>
          ) : null}

          <div className="form-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => fetchPreview(firstUrl)}
              disabled={!firstUrl || isPreviewLoading || validation.state !== 'valid'}
            >
              {isPreviewLoading ? 'Loading preview...' : 'Refresh preview'}
            </button>
            <button type="submit">Add to Download Queue</button>
          </div>
        </form>

        {previewError ? <div className="error-box">{previewError}</div> : null}
        {error ? <div className="error-box">{error}</div> : null}

        {/* ── Video preview ────────────────────────────────────────────── */}
        {preview ? (
          <section className="preview-panel">
            <div className="preview-media">
              {preview.thumbnail ? (
                <img className="preview-thumbnail" src={preview.thumbnail} alt={preview.title} />
              ) : (
                <div className="preview-thumbnail preview-thumbnail-placeholder">No thumbnail</div>
              )}
            </div>
            <div className="preview-details">
              <span className="preview-label">Preview</span>
              <h2>{preview.title}</h2>
              <p className="preview-channel">{preview.channel}</p>
              <div className="preview-meta">
                {/* FIX: format raw seconds into M:SS; format raw count into "1.4M views" */}
                <span>⏱ {formatDuration(preview.duration)}</span>
                <span>👁 {formatViewCount(preview.view_count)}</span>
              </div>
            </div>
          </section>
        ) : null}

        {/* ── Playlist picker ──────────────────────────────────────────── */}
        {playlistMode && preview?.playlist ? (
          <section className="playlist-panel">
            <h3>
              Playlist: {preview.playlist.title}{' '}
              <span className="playlist-count">({preview.playlist.count} videos)</span>
            </h3>
            <div className="playlist-list">
              {preview.playlist.entries.map((entry) => (
                <label key={entry.index} className="playlist-item">
                  <input
                    type="checkbox"
                    checked={selectedPlaylistItems.includes(entry.index)}
                    onChange={() => togglePlaylistItem(entry.index)}
                  />
                  {entry.thumbnail ? (
                    <img src={entry.thumbnail} alt={entry.title} className="playlist-thumb" />
                  ) : (
                    <div className="playlist-thumb playlist-thumb-placeholder">No image</div>
                  )}
                  <span>
                    {entry.index}. {entry.title}
                  </span>
                </label>
              ))}
            </div>
          </section>
        ) : null}

        {/* ── Download queue ───────────────────────────────────────────── */}
        <section className="queue-panel">
          <h2>Download Queue</h2>
          {queue.length ? (
            <div className="queue-list">
              {queue.map((item) => (
                <article key={item.localId} className="queue-item">
                  <div className="queue-head">
                    {/* FIX: show title from result when available, fall back to URL */}
                    <p className="queue-url">{item.result?.title || item.url}</p>
                    <span className={`queue-badge queue-badge-${item.status}`}>{item.status}</span>
                  </div>
                  <p className="queue-meta">
                    {FORMAT_OPTIONS.find((opt) => opt.value === item.quality)?.label} &nbsp;·&nbsp;{' '}
                    {item.outputPath}
                  </p>
                  {/* FIX: apply --waiting shimmer class when job hasn't started yet */}
                  <div
                    className={`progress-track${item.status === 'queued' ? ' progress-track--waiting' : ''}`}
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(item.progress)}
                  >
                    <div className="progress-fill" style={{ width: `${item.progress}%` }} />
                  </div>
                  <div className="progress-meta">
                    <span>
                      <strong>Speed:</strong> {item.speed}
                    </span>
                    <span>
                      <strong>ETA:</strong> {item.eta}
                    </span>
                  </div>
                  {item.result?.file_path ? (
                    <p className="queue-success">
                      ✓ Saved to <span className="queue-path">{item.result.file_path}</span>
                    </p>
                  ) : null}
                  {item.error ? <p className="queue-error">{item.error}</p> : null}
                </article>
              ))}
            </div>
          ) : (
            <p className="history-empty">Queue is empty. Add one or more URLs above.</p>
          )}
        </section>

        {/* ── Download history ─────────────────────────────────────────── */}
        <section className="history-panel">
          <button
            type="button"
            className="history-toggle"
            onClick={() => setHistoryOpen((current) => !current)}
            aria-expanded={historyOpen}
          >
            <span>Download History</span>
            <span className="history-toggle-right">
              <span className="history-count">{history.length}</span>
              <IconChevron open={historyOpen} />
            </span>
          </button>
          {historyOpen ? (
            <div className="history-list">
              {history.length ? (
                history.map((entry) => (
                  <article key={entry.id} className="history-item">
                    {entry.thumbnail ? (
                      <img src={entry.thumbnail} alt={entry.title} className="history-thumb" />
                    ) : (
                      <div className="history-thumb history-thumb-placeholder">No image</div>
                    )}
                    <div className="history-content">
                      <h4>{entry.title}</h4>
                      <p>{entry.format}</p>
                      <p>{formatDate(entry.savedAt)}</p>
                      {/* FIX: render the actual file path in history cards */}
                      {entry.filePath ? (
                        <p className="history-path" title={entry.filePath}>
                          {entry.filePath}
                        </p>
                      ) : null}
                    </div>
                  </article>
                ))
              ) : (
                <p className="history-empty">No downloads yet.</p>
              )}
            </div>
          ) : null}
        </section>

        <footer className="footer-row">
          <span className="version-badge">yt-dlp {ytDlpVersion}</span>
        </footer>
      </section>

      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}

export default App;
