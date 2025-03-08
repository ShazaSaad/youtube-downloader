import yt_dlp
import os

def download_video(url, output_path="downloads"):
    if not os.path.exists(output_path):
        os.makedirs(output_path)

    ydl_opts = {
        'outtmpl': f'{output_path}/%(title)s.%(ext)s',
        'format': 'bestvideo+bestaudio/best',
        'ffmpeg_location': r"ffmpeg" 
    }

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        print("Download completed successfully!")
    except Exception as e:
        print(f"Error: {e}")
