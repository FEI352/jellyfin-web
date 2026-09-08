#!/bin/bash
# Jellyfin Docker Deployment Script with rslave mount
docker run -d \
  --name jellyfin \
  --restart unless-stopped \
  --net=host \
  -v /opt/jellyfin/config:/config \
  -v /opt/jellyfin/cache:/cache \
  -v /mnt/alist:/media:rslave \
  jellyfin/jellyfin:latest
