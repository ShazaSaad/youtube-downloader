from ytdownload import download_video

if __name__ == "__main__":
    video_url = input("Enter the video URL: ")
    result = download_video(video_url)
    print(f"Saved: {result['title']} -> {result['file_path']}")
