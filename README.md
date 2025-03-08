
## **YouTube Video Downloader**
A simple yet powerful Python-based **YouTube Video Downloader** that fetches and saves videos in the best available quality using `yt-dlp`. This tool merges video and audio seamlessly and ensures fast, reliable downloads.

### **Features**
✅ **Download videos in the best quality** (auto-selects highest resolution)  
✅ **Merges video & audio automatically** (requires `ffmpeg`)  
✅ **Saves videos to a dedicated folder** (`downloads/`)  
✅ **Lightweight & Easy to Use**  
✅ **Fully open-source and customizable**  

---

### **How It Works**
1. **Input a YouTube Video URL**
2. **Selects the best video & audio format**
3. **Downloads and merges files (using `ffmpeg`)**
4. **Saves the video to the `downloads/` folder**

---

### **Installation & Usage**
#### **1. Clone the Repository**
```bash
git clone https://github.com/your-username/youtube-downloader.git
cd youtube-downloader
```

#### **2. Install Dependencies**
```bash
pip install -r requirements.txt
```

#### **3. Run the Downloader**
```bash
python src/main.py
```
> **Note:** Ensure `ffmpeg` is installed and added to your system PATH.

---

### **Requirements**
- Python 3.x
- `yt-dlp` (installed via `pip`)
- `ffmpeg` (for merging video & audio)

---

### **Example**
```
Enter the video URL: https://youtu.be/example-video
Downloading: Example Video Title...
Download completed successfully!
```

---

### **License**
This project is licensed under the **MIT License**, meaning you can freely use, modify, and distribute it.

---
