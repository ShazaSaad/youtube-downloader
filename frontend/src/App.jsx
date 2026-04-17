import { useEffect, useMemo, useState } from 'react';

const POLL_MS = 1500;

function App() {
  const [url, setUrl] = useState('');
  const [jobId, setJobId] = useState(null);
  const [job, setJob] = useState(null);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState('light');

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

  const canSubmit = useMemo(
    () => Boolean(url.trim()) && (!job || !['queued', 'running'].includes(job.status)),
    [url, job],
  );

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
          Paste a YouTube URL and download the best available quality with a modern, one-click workflow.
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
          <button type="submit" disabled={!canSubmit}>
            {job?.status === 'running' || job?.status === 'queued' ? 'Downloading...' : 'Start Download'}
          </button>
        </form>

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
            <pre className="log-box">{(job.logs && job.logs.length ? job.logs.join('\n') : 'Waiting for activity...')}</pre>
          </section>
        ) : null}
      </section>
    </main>
  );
}

export default App;