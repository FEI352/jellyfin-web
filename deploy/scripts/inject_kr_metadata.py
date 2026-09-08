#!/usr/bin/env python3
"""
Jellyfin Metadata & Artwork Injection Tool
Applies official TMDB / TheTVDB posters, backdrops, clean numbering,
and fixes episode titles for Kamen Rider series and special media.
"""

import sqlite3
import urllib.request
import os
import uuid
import re

DB_PATH = "/opt/jellyfin/config/data/jellyfin.db"
HEADERS = {"User-Agent": "Mozilla/5.0"}

def set_image(cur, item_id, img_url, img_type=0, width=680, height=1000):
    raw_id = item_id.replace('-', '').lower()
    meta_dir = f"/opt/jellyfin/config/metadata/library/{raw_id[:2]}/{raw_id}"
    os.makedirs(meta_dir, exist_ok=True)
    suffix = 'poster.jpg' if img_type == 0 else 'backdrop.jpg'
    local_path = f"{meta_dir}/{suffix}"
    container_path = f"/config/metadata/library/{raw_id[:2]}/{raw_id}/{suffix}"
    
    req = urllib.request.Request(img_url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=15) as resp, open(local_path, "wb") as f:
        f.write(resp.read())
        
    cur.execute("DELETE FROM BaseItemImageInfos WHERE ItemId=? AND ImageType=?;", (item_id, img_type))
    cur.execute("""
        INSERT INTO BaseItemImageInfos (Id, Blurhash, DateModified, Height, ImageType, ItemId, Path, Width)
        VALUES (?, NULL, datetime('now'), ?, ?, ?, ?, ?);
    """, (str(uuid.uuid4()).upper(), height, img_type, item_id, container_path, width))
    print(f"Applied ImageType {img_type} to {item_id}")

def main():
    if not os.path.exists(DB_PATH):
        print(f"Database {DB_PATH} not found.")
        return
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    print("Database connected. Ready for metadata processing.")
    conn.commit()
    conn.close()

if __name__ == "__main__":
    main()
