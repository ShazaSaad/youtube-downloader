import { useEffect, useMemo, useRef, useState } from 'react';

const POLL_MS = 1500;

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

function App() {
  const [url, setUrl] = useState('');
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState('light');
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const previewRequestRef = useRef(null);

  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      setTheme('dark');
    }
  }, []);

  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!jobId) return undefined;

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

  useEffect(() => {
    setPreview(null);
    setPreviewError('');
    setJob(null);
    setJobId(null);
    setError('');
    setIsPreviewLoading(false);
    if (previewRequestRef.current) {
      previewRequestRef.current.abort();
      previewRequestRef.current = null;
    }
  }, [url]);

  useEffect(
    () => () => {
      if (previewRequestRef.current) {
        previewRequestRef.current.abort();
      }
    },
    [],
  );

  const canSubmit = useMemo(
    () =>
      Boolean(url.trim()) &&
      Boolean(preview) &&
      !isPreviewLoading &&
      (!job || !['queued', 'running'].includes(job.status)),
    [url, preview, isPreviewLoading, job],
  );

  const handlePreview = async () => {
    if (previewRequestRef.current) {
      previewRequestRef.current.abort();
    }
    const controller = new AbortController();
    previewRequestRef.current = controller;

    setError('');
    setPreviewError('');
    setPreview(null);
    setJob(null);
    setJobId(null);
    setIsPreviewLoading(true);

    try {
      const response = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: controller.signal,
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load video preview.');
      }

      setPreview(payload);
    } catch (previewFetchError) {
      if (previewFetchError.name === 'AbortError') {
        return;
      }
      setPreviewError(previewFetchError.message);
    } finally {
      if (previewRequestRef.current === controller) {
        previewRequestRef.current = null;
        setIsPreviewLoading(false);
      }
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');

    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || 'Unable to create download job.');
      }

      setJobId(payload.job_id);
      setJob({ status: payload.status, logs: [] });
    } catch (submitError) {
      setError(submitError.message);
    }
  };

  const toggleTheme = () => {
    setTheme((current) => (current === 'light' ? 'dark' : 'light'));
  };

  return (
    <main className="page-shell">
      <section className="card">
        <div className="header-row">
          <h1>YouTube Downloader</h1>
          <button className="theme-toggle" onClick={toggleTheme} type="button">
            {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
          </button>
        </div>

        <p className="subtitle">
          Paste a YouTube URL, preview the video details, then download the best available quality.
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
          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={handlePreview}
              disabled={!url.trim() || isPreviewLoading || job?.status === 'running' || job?.status === 'queued'}
            >
              {isPreviewLoading ? 'Loading Preview...' : 'Preview Video'}
            </button>
            <button type="submit" disabled={!canSubmit}>
              {job?.status === 'running' || job?.status === 'queued' ? 'Downloading...' : 'Start Download'}
            </button>
          </div>
        </form>

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
            {job.result ? (
              <div className="success-box">
                <p>
                  <strong>Title:</strong> {job.result.title}
                </p>
                <p>
                  <strong>Saved to:</strong> {job.result.file_path}
                </p>
              </div>
            ) : null}
            {job.error ? <div className="error-box">{job.error}</div> : null}

            <h3>Activity</h3>
            <pre className="log-box">{job.logs && job.logs.length ? job.logs.join('\n') : 'Waiting for activity...'}</pre>
          </section>
        ) : null}
      </section>
    </main>
  );
}

export default App;