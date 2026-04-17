
## **YouTube Video Downloader**
A Python + React YouTube downloader with a modern UI and optional dark mode. It fetches and saves videos in the best available quality using `yt-dlp` and merges streams with `ffmpeg`.

### **Features**
✅ **Modern React interface** inspired by YouTube styling  
✅ **Light + Dark mode toggle** (default: light)  
✅ **Background download jobs with progress logs**  
✅ **Download videos in the best quality** (`bestvideo+bestaudio/best`)    
✅ **Merges video & audio automatically** (requires `ffmpeg`)  
✅ **Saves videos to a dedicated folder** (`downloads/`)  
  

---

### **Project Structure**
- `src/ytdownload.py` → reusable download logic
- `src/api.py` → Flask API for UI integration
- `src/main.py` → CLI fallback entry point
- `frontend/` → React (Vite) user interface

---

### **Backend Setup (Flask + yt-dlp)**
#### 1) Install Python dependencies
```bash
pip install -r requirements.txt
```

#### 2) Run backend API
```bash
python src/api.py
```
Backend runs on `http://localhost:5000`.

---

### **Frontend Setup (React + Vite)**
#### 1) Install frontend dependencies
```bash
cd frontend
npm install
```

#### 2) Run frontend
```bash
npm run dev
```
Frontend runs on `http://localhost:5173` and proxies API calls to Flask.

---

### **CLI Usage (Optional)**
If you prefer the terminal flow:
```bash
python src/main.py
```

---

### **Requirements**
- Python 3.x
- Node.js 18+
- `yt-dlp`
- `flask`
- `flask-cors`
- `ffmpeg` (for merging video & audio)

---

### **License**
This project is licensed under the **MIT License**.
---
