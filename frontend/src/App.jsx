import { useEffect, useMemo, useRef, useState } from 'react';

const POLL_MS = 1500;
const PREVIEW_DEBOUNCE_MS = 280;
const HISTORY_STORAGE_KEY = 'download_history_v1';
const TOAST_MS = 2200;
const MAX_HISTORY_ITEMS = 20;

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

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return 'Unknown';
  }
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds]
      .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, '0')))
      .join(':');
  }
  return [minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function formatViews(viewCount) {
  if (!Number.isFinite(viewCount) || viewCount < 0) {
    return 'Unknown';
  }
  return new Intl.NumberFormat().format(viewCount);
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_ESCAPE_RE, '');
}

function parseDownloadProgressFromLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) {
    return null;
  }
  for (let i = logs.length - 1; i >= 0; i -= 1) {
    const line = stripAnsi(logs[i]).trim();
    const match = line.match(DOWNLOAD_PROGRESS_RE);
    if (!match) {
      continue;
    }
    const pct = Number.parseFloat(match[1]);
    if (!Number.isFinite(pct)) {
      continue;
    }
    return {
      percent: Math.min(100, Math.max(0, pct)),
      speed: match[2].trim() || null,
      eta: match[3].trim() || null,
    };
  }
  return null;
}

function getUrlValidationState(rawUrl) {
  const value = rawUrl.trim();
  if (!value) {
    return { state: 'idle', message: 'Paste a YouTube video, shorts, or playlist URL.' };
  }
  if (YOUTUBE_URL_RE.test(value)) {
    return { state: 'valid', message: 'Looks good. Preview is fetched automatically.' };
  }
  return { state: 'invalid', message: 'Enter a valid YouTube URL (youtube.com, youtu.be, shorts, or playlist).' };
}

function safeReadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function App() {
  const [url, setUrl] = useState('');
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState('light');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [formatQuality, setFormatQuality] = useState('best_mp4');
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [toast, setToast] = useState('');
  const [copySuccess, setCopySuccess] = useState(false);
  const previewRequestRef = useRef(null);
  const previewDebounceRef = useRef(null);
  const previewUrlRef = useRef('');
  const lastCompletedJobRef = useRef(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      setTheme('dark');
    }
    setHistory(safeReadHistory());
  }, []);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    if (!jobId) {
      return undefined;
    }
    const refreshJob = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch job status.');
        }
        const payload = await response.json();
        setJob(payload);
      } catch (fetchError) {
        setError(fetchError.message);
      }
    };

    refreshJob();
    const interval = setInterval(refreshJob, POLL_MS);
    return () => clearInterval(interval);
  }, [jobId]);

  const urlValidation = useMemo(() => getUrlValidationState(url), [url]);
  const isUrlValid = urlValidation.state === 'valid';

  const resetForNewUrl = () => {
    setPreview(null);
    setPreviewError('');
    setJob(null);
    setJobId(null);
    setError('');
    setCopySuccess(false);
    if (previewRequestRef.current) {
      previewRequestRef.current.abort();
      previewRequestRef.current = null;
    }
  };

  useEffect(() => {
    resetForNewUrl();
    if (previewDebounceRef.current) {
      clearTimeout(previewDebounceRef.current);
      previewDebounceRef.current = null;
    }
  }, [url]);

  useEffect(() => () => {
    if (previewRequestRef.current) {
      previewRequestRef.current.abort();
    }
    if (previewDebounceRef.current) {
      clearTimeout(previewDebounceRef.current);
    }
  }, []);

  const handlePreview = async (targetUrl) => {
    const candidateUrl = (targetUrl ?? url).trim();
    if (!candidateUrl || !YOUTUBE_URL_RE.test(candidateUrl)) {
      return;
    }
    if (previewUrlRef.current === candidateUrl && preview) {
      return;
    }

    if (previewRequestRef.current) {
      previewRequestRef.current.abort();
    }
    const controller = new AbortController();
    previewRequestRef.current = controller;

    setError('');
    setPreviewError('');
    setIsPreviewLoading(true);
    previewUrlRef.current = candidateUrl;

    try {
      const response = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: candidateUrl }),
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load video preview.');
      }
      if (candidateUrl === url.trim()) {
        setPreview(payload);
      }
    } catch (previewFetchError) {
      if (previewFetchError.name === 'AbortError') {
        return;
      }
      if (candidateUrl === url.trim()) {
        setPreviewError(previewFetchError.message);
      }
    } finally {
      if (previewRequestRef.current === controller) {
        previewRequestRef.current = null;
        setIsPreviewLoading(false);
      }
    }
  };

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || !isUrlValid) {
      previewUrlRef.current = '';
      return;
    }
    previewDebounceRef.current = setTimeout(() => {
      handlePreview(trimmed);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      if (previewDebounceRef.current) {
        clearTimeout(previewDebounceRef.current);
        previewDebounceRef.current = null;
      }
    };
  }, [url, isUrlValid]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    const timeout = setTimeout(() => setToast(''), TOAST_MS);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const onPaste = (event) => {
      const pasted = event.clipboardData?.getData('text')?.trim();
      if (!pasted || !YOUTUBE_URL_RE.test(pasted)) {
        return;
      }
      setUrl(pasted);
      setToast('Paste detected. URL captured.');
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  useEffect(() => {
    if (!job || job.status !== 'success' || !job.result?.file_path) {
      return;
    }
    if (lastCompletedJobRef.current === job.job_id) {
      return;
    }
    lastCompletedJobRef.current = job.job_id;

    const newItem = {
      id: `${job.job_id}-${Date.now()}`,
      title: job.result.title || preview?.title || 'Unknown title',
      thumbnail: preview?.thumbnail || null,
      format: FORMAT_OPTIONS.find((opt) => opt.value === (job.quality || formatQuality))?.label || 'Unknown',
      savedAt: new Date().toISOString(),
      filePath: job.result.file_path,
    };
    setHistory((prev) => [newItem, ...prev.filter((item) => item.filePath !== newItem.filePath)].slice(0, MAX_HISTORY_ITEMS));
  }, [job, preview, formatQuality]);

  const canSubmit = useMemo(
    () =>
      Boolean(url.trim()) &&
      isUrlValid &&
      Boolean(preview) &&
      !isPreviewLoading &&
      (!job || !['queued', 'running'].includes(job.status)),
    [url, isUrlValid, preview, isPreviewLoading, job],
  );

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setCopySuccess(false);

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, quality: formatQuality }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to create download job.');
      }
      setJobId(payload.job_id);
      setJob({ status: payload.status, logs: [], quality: formatQuality });
    } catch (submitError) {
      setError(submitError.message);
    }
  };

  const handleCopyPath = async () => {
    if (!job?.result?.file_path) {
      return;
    }
    try {
      await navigator.clipboard.writeText(job.result.file_path);
      setCopySuccess(true);
      setToast('Saved path copied.');
    } catch {
      setError('Unable to copy path. Please copy it manually.');
    }
  };

  const handleDownloadAnother = () => {
    setUrl('');
    setJob(null);
    setJobId(null);
    setPreview(null);
    setPreviewError('');
    setError('');
    setCopySuccess(false);
    previewUrlRef.current = '';
  };

  const toggleTheme = () => {
    setTheme((current) => (current === 'light' ? 'dark' : 'light'));
  };

  const parsedDownloadProgress = useMemo(() => parseDownloadProgressFromLogs(job?.logs), [job?.logs]);
  const downloadProgress = useMemo(() => {
    if (!job) {
      return null;
    }
    if (job.status === 'success') {
      return { percent: 100, speed: parsedDownloadProgress?.speed, eta: '0s' };
    }
    if (job.status === 'queued') {
      return { percent: 0, speed: null, eta: null };
    }
    return parsedDownloadProgress;
  }, [job, parsedDownloadProgress]);

  const showProgressBar = Boolean(job && ['queued', 'running', 'success'].includes(job.status));
  const progressFallbackText = useMemo(() => {
    if (!job) {
      return { speed: 'N/A', eta: 'N/A' };
    }
    switch (job.status) {
      case 'queued':
        return { speed: 'Waiting...', eta: 'Waiting...' };
      case 'running':
        return { speed: 'Calculating...', eta: 'Calculating...' };
      default:
        return { speed: 'N/A', eta: 'N/A' };
    }
  }, [job]);

  return (
    <main className="page-shell">
      <section className="card">
        <div className="header-row">
          <h1>YouTube Downloader</h1>
          <button className="theme-toggle" onClick={toggleTheme} type="button">
            {theme === 'light' ? 'Dark' : 'Light'} mode
          </button>
        </div>

        <p className="subtitle">
          Paste anywhere, auto-preview instantly, choose quality, and download in one clean flow.
        </p>

        <form onSubmit={handleSubmit} className="download-form">
          <label htmlFor="video-url">Video URL</label>
          <input
            id="video-url"
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            required
          />
          <div className={`url-feedback url-feedback-${urlValidation.state}`}>
            {urlValidation.state === 'valid' ? <span className="url-feedback-icon">✓</span> : null}
            {urlValidation.state === 'invalid' ? <span className="url-feedback-icon">!</span> : null}
            <span>{urlValidation.message}</span>
          </div>

          <label htmlFor="format-quality">Format &amp; quality</label>
          <select id="format-quality" value={formatQuality} onChange={(event) => setFormatQuality(event.target.value)}>
            {FORMAT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => handlePreview(url)}
              disabled={!url.trim() || !isUrlValid || isPreviewLoading || job?.status === 'running' || job?.status === 'queued'}
            >
              {isPreviewLoading ? 'Refreshing...' : 'Refresh Preview'}
            </button>
            <button type="submit" disabled={!canSubmit}>
              {job?.status === 'running' || job?.status === 'queued' ? 'Downloading...' : 'Start Download'}
            </button>
          </div>
        </form>

        <section className="history-panel">
          <button
            type="button"
            className="history-toggle"
            onClick={() => setHistoryOpen((current) => !current)}
            aria-expanded={historyOpen}
          >
            <span>Download History</span>
            <span>{historyOpen ? 'Hide' : 'Show'} ({history.length})</span>
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
                      <p className="history-path" title={entry.filePath}>
                        {entry.filePath}
                      </p>
                    </div>
                  </article>
                ))
              ) : (
                <p className="history-empty">No downloads yet. Completed items will appear here.</p>
              )}
            </div>
          ) : null}
        </section>

        {previewError ? <div className="error-box">{previewError}</div> : null}

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
              <span className="preview-label">Video Preview</span>
              <h2>{preview.title}</h2>
              <p className="preview-channel">{preview.channel}</p>
              <div className="preview-meta">
                <span>Duration: {formatDuration(preview.duration)}</span>
                <span>Views: {formatViews(preview.view_count)}</span>
              </div>
            </div>
          </section>
        ) : null}

        {error ? <div className="error-box">{error}</div> : null}

        {job ? (
          <section className="status-panel">
            <h2>Status: {job.status}</h2>
            {job.quality ? (
              <p className="job-quality">
                <strong>Format:</strong> {FORMAT_OPTIONS.find((o) => o.value === job.quality)?.label ?? job.quality}
              </p>
            ) : null}

            {showProgressBar ? (
              <div className="download-progress" aria-live="polite">
                <div className="progress-header">
                  <span className="progress-label">Download progress</span>
                  <span className="progress-percent">{downloadProgress ? `${Math.round(downloadProgress.percent)}%` : '...'}</span>
                </div>
                <div
                  className={`progress-track${downloadProgress ? '' : ' progress-track--waiting'}`}
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={downloadProgress ? Math.round(downloadProgress.percent) : 0}
                  aria-label="Download progress"
                >
                  <div className="progress-fill" style={{ width: `${downloadProgress ? downloadProgress.percent : 0}%` }} />
                </div>
                <div className="progress-meta">
                  <span>
                    Speed: <strong>{downloadProgress?.speed ?? progressFallbackText.speed}</strong>
                  </span>
                  <span>
                    ETA: <strong>{downloadProgress?.eta ?? progressFallbackText.eta}</strong>
                  </span>
                </div>
              </div>
            ) : null}

            {job.result ? (
              <div className="success-card">
                <div className="success-icon" aria-hidden="true">
                  ✓
                </div>
                <div className="success-main">
                  <h3>Download complete</h3>
                  <p>{job.result.title}</p>
                  {preview?.thumbnail ? <img src={preview.thumbnail} alt={job.result.title} className="success-thumbnail" /> : null}
                  <p className="success-path" title={job.result.file_path}>
                    {job.result.file_path}
                  </p>
                  <div className="success-actions">
                    <button type="button" onClick={handleCopyPath}>
                      {copySuccess ? 'Copied' : 'Copy Path'}
                    </button>
                    <button type="button" className="secondary-button" onClick={handleDownloadAnother}>
                      Download Another
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {job.error ? <div className="error-box">{job.error}</div> : null}
          </section>
        ) : null}
      </section>
      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  );
}

export default App;