// Jellyfin Custom Enhancement:
// 1. PotPlayer-Style Continuous Buffer Engine (7200s, 2GB Buffer, Background Buffering on Pause)
// 2. Minimalist English HUD (Realtime Speed, Dynamic Buffer Progress, Decode Switcher)
// 3. Persistent "最近观看" (Recently Watched) Section with Playback Progress & History

(function() {
    'use strict';

    // =========================================================================
    // 1. PotPlayer-Style Continuous Buffering Engine & HLS DirectStream Routing
    // =========================================================================
    let forceDirectPlayNative = false;
    let activeHlsInstance = null;
    let instantSpeedBps = 0;
    let smoothedSpeedBps = 0;
    let lastChunkDownloadedTime = 0;
    let effectiveBitrateBps = 8000000; // fallback 8 Mbps

    // Intercept PlaybackInfo requests to remove Video from DirectPlayProfiles
    // This routes video through HLS DirectStream (Video: copy, Audio: copy, 0% CPU transcode overhead)
    // which enables Hls.js to continuously pre-buffer the ENTIRE episode even when PAUSED!
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._pp_url = typeof url === 'string' ? url : '';
        return origXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        const url = this._pp_url || '';

        // Filter out Video DirectPlay for continuous HLS prebuffering
        if (!forceDirectPlayNative && typeof body === 'string' && body.includes('DirectPlayProfiles')) {
            try {
                const parsed = JSON.parse(body);
                if (parsed.DeviceProfile && Array.isArray(parsed.DeviceProfile.DirectPlayProfiles)) {
                    parsed.DeviceProfile.DirectPlayProfiles = parsed.DeviceProfile.DirectPlayProfiles.filter(p => p.Type !== 'Video');
                    arguments[0] = JSON.stringify(parsed);
                    console.log('[PotPlayer-Buffer] Filtered DirectPlayProfiles -> HLS DirectStream active for full background prebuffering');
                }
            } catch (e) {}
        }

        // Network throughput measurement for video chunks
        if (url.includes('/Videos/') || url.includes('/hls') || url.includes('.ts') || url.includes('.m4s') || url.includes('stream')) {
            let prev = 0;
            let startTime = Date.now();
            this.addEventListener('progress', (e) => {
                const now = Date.now();
                const dt = (now - startTime) / 1000;
                if (e.loaded > prev && dt > 0.08) {
                    const delta = e.loaded - prev;
                    instantSpeedBps = delta / dt;
                    prev = e.loaded;
                    startTime = now;
                    lastChunkDownloadedTime = now;
                }
            });
            this.addEventListener('load', () => {
                lastChunkDownloadedTime = Date.now();
            });
        }

        return origXhrSend.apply(this, arguments);
    };

    if (window.fetch) {
        const origFetch = window.fetch;
        window.fetch = function(input, init) {
            if (!forceDirectPlayNative && init && typeof init.body === 'string' && init.body.includes('DirectPlayProfiles')) {
                try {
                    const parsed = JSON.parse(init.body);
                    if (parsed.DeviceProfile && Array.isArray(parsed.DeviceProfile.DirectPlayProfiles)) {
                        parsed.DeviceProfile.DirectPlayProfiles = parsed.DeviceProfile.DirectPlayProfiles.filter(p => p.Type !== 'Video');
                        init.body = JSON.stringify(parsed);
                        console.log('[PotPlayer-Buffer] Filtered fetch DirectPlayProfiles -> HLS DirectStream active');
                    }
                } catch (e) {}
            }
            return origFetch.apply(this, arguments);
        };
    }

    // Configure HLS Player for 7200s (2hr) / 2GB continuous prebuffering without breaking constructor or static Events
    function configureHls(HlsClass) {
        if (!HlsClass) return;
        if (HlsClass.DefaultConfig) {
            HlsClass.DefaultConfig.maxBufferLength = 7200; // 2 hours buffer ahead
            HlsClass.DefaultConfig.maxMaxBufferLength = 14400; // 4 hours
            HlsClass.DefaultConfig.maxBufferSize = 2 * 1024 * 1024 * 1024; // 2GB buffer in RAM
            HlsClass.DefaultConfig.backBufferLength = 1800; // 30 minutes back buffer
            HlsClass.DefaultConfig.maxBufferHole = 0.5;
            HlsClass.DefaultConfig.lowLatencyMode = false;
            HlsClass.DefaultConfig.startFragPrefetch = true;
            HlsClass.DefaultConfig.progressive = true;
            HlsClass.DefaultConfig.manifestLoadingTimeOut = 30000;
        }

        if (HlsClass.prototype && !HlsClass.prototype.__potplayerHooked) {
            HlsClass.prototype.__potplayerHooked = true;
            const origLoadSource = HlsClass.prototype.loadSource;
            HlsClass.prototype.loadSource = function(url) {
                activeHlsInstance = this;
                window.__potplayer_active_hls = this;

                // Force PotPlayer 7200s buffer directly onto the instantiated player config
                if (this.config) {
                    this.config.maxBufferLength = 7200;
                    this.config.maxMaxBufferLength = 14400;
                    this.config.maxBufferSize = 2 * 1024 * 1024 * 1024;
                    this.config.backBufferLength = 1800;
                    this.config.startFragPrefetch = true;
                    this.config.progressive = true;
                    this.config.lowLatencyMode = false;
                    this.config.manifestLoadingTimeOut = 30000;
                }

                // Hook fragment progress & load events for realtime speed monitoring
                if (HlsClass.Events) {
                    if (HlsClass.Events.FRAG_LOAD_PROGRESS) {
                        this.on(HlsClass.Events.FRAG_LOAD_PROGRESS, (event, data) => {
                            const now = Date.now();
                            lastChunkDownloadedTime = now;
                            if (this.bandwidthEstimate && this.bandwidthEstimate > 0) {
                                instantSpeedBps = this.bandwidthEstimate / 8;
                            }
                        });
                    }
                    if (HlsClass.Events.FRAG_LOADED) {
                        this.on(HlsClass.Events.FRAG_LOADED, (event, data) => {
                            const now = Date.now();
                            lastChunkDownloadedTime = now;
                            if (data && data.stats) {
                                const bytes = data.stats.total || data.stats.loaded || 0;
                                const dur = (data.stats.loading.end - data.stats.loading.start) / 1000;
                                if (dur > 0 && bytes > 0) {
                                    instantSpeedBps = bytes / dur;
                                } else if (this.bandwidthEstimate) {
                                    instantSpeedBps = this.bandwidthEstimate / 8;
                                }
                            }
                        });
                    }
                    if (HlsClass.Events.ERROR) {
                        this.on(HlsClass.Events.ERROR, (event, data) => {
                            if (data && data.fatal) {
                                console.warn("[PotPlayer-Buffer] Fatal HLS error:", data.type, data.details);
                                switch (data.type) {
                                    case HlsClass.ErrorTypes.NETWORK_ERROR:
                                        this.startLoad(-1);
                                        break;
                                    case HlsClass.ErrorTypes.MEDIA_ERROR:
                                        this.recoverMediaError();
                                        break;
                                    default:
                                        console.warn("[PotPlayer-Buffer] Unrecoverable error, switching to native DirectPlay fallback");
                                        forceDirectPlayNative = true;
                                        break;
                                }
                            }
                        });
                    }
                }
                return origLoadSource.apply(this, arguments);
            };
        }
    }

    let _hls = window.Hls ? (configureHls(window.Hls), window.Hls) : null;
    try {
        Object.defineProperty(window, "Hls", {
            get() { return _hls; },
            set(val) {
                _hls = val;
                configureHls(val);
                console.log("[PotPlayer-Buffer] window.Hls safely configured with continuous buffer & metrics.");
            },
            configurable: true
        });
    } catch (e) {
        if (window.Hls) {
            configureHls(window.Hls);
        }
    }

    // Direct Play Video Pre-buffering & Progress Speed Tracking
    let lastBufferedEndSec = 0;
    let lastProgressTime = Date.now();

    document.addEventListener('play', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            const video = e.target;
            video.preload = 'auto';
            lastBufferedEndSec = 0;
            lastProgressTime = Date.now();
            if (activeHlsInstance && typeof activeHlsInstance.startLoad === 'function') {
                activeHlsInstance.startLoad();
            }
        }
    }, true);

    // CRITICAL: Ensure pre-buffering KEEPS RUNNING even when the user PAUSES the video!
    document.addEventListener('pause', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            console.log('[PotPlayer-Buffer] Video paused. Forcing continuous background pre-buffering...');
            if (activeHlsInstance && typeof activeHlsInstance.startLoad === 'function') {
                activeHlsInstance.startLoad();
            }
        }
    }, true);

    // Track buffer advancement on native video element
    document.addEventListener('progress', (e) => {
        if (e.target && e.target.tagName === 'VIDEO') {
            const video = e.target;
            if (!video.duration || isNaN(video.duration)) return;

            const now = Date.now();
            const dt = (now - lastProgressTime) / 1000;
            const ct = video.currentTime || 0;

            let currentEnd = 0;
            for (let i = 0; i < video.buffered.length; i++) {
                const s = video.buffered.start(i);
                const end = video.buffered.end(i);
                if (ct >= s - 1 && ct <= end + 1) {
                    currentEnd = end;
                    break;
                }
                if (end > currentEnd) currentEnd = end;
            }

            if (dt >= 0.25 && currentEnd > lastBufferedEndSec) {
                const deltaSec = currentEnd - lastBufferedEndSec;
                const bytes = deltaSec * (effectiveBitrateBps / 8);
                instantSpeedBps = bytes / dt;
                lastChunkDownloadedTime = now;
                lastBufferedEndSec = currentEnd;
                lastProgressTime = now;
            } else if (currentEnd < lastBufferedEndSec) {
                lastBufferedEndSec = currentEnd;
                lastProgressTime = now;
            }

            // If paused and Hls is available, make sure startLoad stays active
            if (video.paused && activeHlsInstance && typeof activeHlsInstance.startLoad === 'function') {
                activeHlsInstance.startLoad();
            }
        }
    }, true);

    // =========================================================================
    // 2. Minimalist English HUD Control Bar (PotPlayer Style)
    // =========================================================================
    const hudStyle = document.createElement('style');
    hudStyle.id = 'potplayer-minimal-style';
    hudStyle.textContent = `
        /* Align time display and HUD */
        .videoOsdBottom-maincontrols .buttons .osdTimeText {
            margin-right: 0.8em !important;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace !important;
            font-size: 12px !important;
        }

        .potplayer-hud {
            display: inline-flex !important;
            align-items: center !important;
            gap: 4px !important;
            margin-right: auto !important;
            user-select: none !important;
            z-index: 100 !important;
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace !important;
        }

        .pp-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 20px;
            padding: 0 6px;
            border-radius: 3px;
            font-size: 11px;
            font-weight: 500;
            letter-spacing: 0.5px;
            text-transform: uppercase;
            background: rgba(18, 18, 22, 0.75);
            border: 1px solid rgba(255, 255, 255, 0.14);
            color: #d1d5db;
            transition: all 0.15s ease;
            white-space: nowrap;
            font-variant-numeric: tabular-nums;
        }

        button.pp-badge {
            cursor: pointer;
            outline: none;
        }
        button.pp-badge:hover {
            background: rgba(35, 35, 42, 0.95);
            border-color: rgba(255, 255, 255, 0.3);
        }

        /* H/W Decode Button */
        .pp-hw {
            color: #f59e0b !important; /* Minimalist Amber */
            border-color: rgba(245, 158, 11, 0.35) !important;
            background: rgba(30, 24, 12, 0.8) !important;
        }
        .pp-hw:hover {
            background: rgba(45, 34, 15, 0.95) !important;
            border-color: #f59e0b !important;
        }

        .pp-sw {
            color: #38bdf8 !important; /* Minimalist Sky Blue */
            border-color: rgba(56, 189, 248, 0.35) !important;
            background: rgba(12, 26, 36, 0.8) !important;
        }
        .pp-sw:hover {
            background: rgba(16, 38, 52, 0.95) !important;
            border-color: #38bdf8 !important;
        }

        /* Codecs & Audio */
        .pp-codec {
            color: #9ca3af;
        }
        .pp-audio {
            color: #9ca3af;
        }
        .pp-dim {
            opacity: 0.65;
            margin-left: 2px;
        }

        /* Speed Badge */
        .pp-speed {
            min-width: 62px;
            color: #6b7280;
        }
        .pp-speed-fast {
            color: #22c55e !important; /* Clean Green */
            border-color: rgba(34, 197, 94, 0.35) !important;
        }
        .pp-speed-normal {
            color: #f59e0b !important;
        }
        .pp-speed-slow {
            color: #38bdf8 !important;
        }

        /* Buffer Badge */
        .pp-buffer {
            min-width: 76px;
            color: #9ca3af;
        }
        .pp-buffer-full {
            color: #22c55e !important;
            border-color: rgba(34, 197, 94, 0.35) !important;
        }

        /* Minimalist Dark Popover */
        .pp-menu {
            position: absolute;
            background: #141417;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 6px;
            padding: 4px;
            min-width: 240px;
            box-shadow: 0 12px 30px rgba(0, 0, 0, 0.7);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            gap: 1px;
            animation: ppFadeIn 0.12s ease-out;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        }

        @keyframes ppFadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .pp-menu-header {
            font-size: 10px;
            font-weight: 700;
            color: #6b7280;
            padding: 5px 8px 3px;
            letter-spacing: 0.6px;
            text-transform: uppercase;
        }

        .pp-menu-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 6px 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
            color: #d1d5db;
            transition: background 0.12s ease;
        }
        .pp-menu-item:hover {
            background: rgba(255, 255, 255, 0.08);
            color: #ffffff;
        }
        .pp-menu-item.active {
            color: #f59e0b;
            font-weight: 600;
        }
        .pp-menu-tag {
            font-size: 10px;
            color: #6b7280;
            font-family: ui-monospace, monospace;
        }

        .pp-menu-divider {
            height: 1px;
            background: rgba(255, 255, 255, 0.08);
            margin: 3px 4px;
        }

        /* Refined glowing seekbar buffer track */
        .mdl-slider-background-upper {
            background: rgba(245, 158, 11, 0.45) !important;
            border-radius: 2px !important;
            height: 100% !important;
            opacity: 1 !important;
            display: block !important;
        }

        @media (max-width: 680px) {
            .pp-codec,
            .pp-audio {
                display: none !important;
            }
        }
    `;
    if (!document.getElementById('potplayer-minimal-style')) {
        document.head.appendChild(hudStyle);
    }

    let cachedSession = {
        playMethod: 'DirectStream',
        videoCodec: 'H264',
        audioCodec: 'AAC',
        audioChannels: '2.0',
        lastFetch: 0
    };

    async function fetchSession() {
        const now = Date.now();
        if (now - cachedSession.lastFetch < 3000) return;
        cachedSession.lastFetch = now;
        try {
            if (window.ApiClient) {
                const deviceId = window.ApiClient.deviceId ? window.ApiClient.deviceId() : '';
                const sessions = await window.ApiClient.getSessions({ deviceId });
                const s = sessions && sessions.find(item => (deviceId && item.DeviceId === deviceId) || item.NowPlayingItem);
                if (s && s.NowPlayingItem) {
                    const isTranscode = s.PlayState?.PlayMethod === 'Transcode';
                    const isDirectStream = s.PlayState?.PlayMethod === 'DirectStream' || (s.TranscodingInfo && s.TranscodingInfo.IsVideoDirect);
                    cachedSession.playMethod = (isTranscode && !s.TranscodingInfo?.IsVideoDirect) ? 'Transcode' : (isDirectStream ? 'DirectStream' : 'DirectPlay');

                    if (s.NowPlayingItem.MediaSources && s.NowPlayingItem.MediaSources[0]?.Bitrate) {
                        effectiveBitrateBps = s.NowPlayingItem.MediaSources[0].Bitrate;
                    }

                    if (s.TranscodingInfo) {
                        cachedSession.videoCodec = (s.TranscodingInfo.VideoCodec || 'H264').toUpperCase();
                        cachedSession.audioCodec = (s.TranscodingInfo.AudioCodec || 'AAC').toUpperCase();
                        cachedSession.audioChannels = s.TranscodingInfo.AudioChannels === 6 ? '5.1' : (s.TranscodingInfo.AudioChannels ? s.TranscodingInfo.AudioChannels + '.0' : '2.0');
                    } else if (s.NowPlayingItem.MediaStreams) {
                        const vs = s.NowPlayingItem.MediaStreams.find(m => m.Type === 'Video');
                        const as = s.NowPlayingItem.MediaStreams.find(m => m.Type === 'Audio');
                        if (vs && vs.Codec) cachedSession.videoCodec = vs.Codec.toUpperCase();
                        if (as && as.Codec) {
                            cachedSession.audioCodec = as.Codec.toUpperCase();
                            cachedSession.audioChannels = as.Channels === 6 ? '5.1' : (as.Channels ? as.Channels + '.0' : '2.0');
                        }
                    }
                }
            }
        } catch (e) {}
    }

    function formatSpeed(bps) {
        if (bps >= 1048576) {
            return (bps / 1048576).toFixed(1) + ' MB/s';
        } else if (bps >= 1024) {
            return Math.round(bps / 1024) + ' KB/s';
        }
        return '0 KB/s';
    }

    function switchPreset(action) {
        const pm = window.playbackManager;
        const player = pm ? (pm.getCurrentPlayer ? pm.getCurrentPlayer() : (pm._currentPlayer || window.__currentVideoPlayer)) : null;

        if (action === 'direct') {
            forceDirectPlayNative = false;
            if (pm && pm.setMaxStreamingBitrate && player) {
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 0 }, player);
            } else {
                const sBtn = document.querySelector('.btnVideoOsdSettings');
                if (sBtn) sBtn.click();
            }
        } else if (action === 'native-mp4') {
            forceDirectPlayNative = true;
            if (pm && pm.setMaxStreamingBitrate && player) {
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 0 }, player);
            }
        } else if (action === 'transcode-1080p') {
            if (pm && pm.setMaxStreamingBitrate && player) {
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 10000000 }, player);
            }
        } else if (action === 'transcode-720p') {
            if (pm && pm.setMaxStreamingBitrate && player) {
                pm.setMaxStreamingBitrate({ enableAutomaticBitrateDetection: false, maxBitrate: 4000000 }, player);
            }
        } else if (action === 'stats') {
            const sBtn = document.querySelector('.btnVideoOsdSettings');
            if (sBtn) {
                sBtn.click();
                setTimeout(() => {
                    const titles = Array.from(document.querySelectorAll('.actionSheetMenuItemTitle'));
                    const statsItem = titles.find(t => t.textContent.includes('播放数据') || t.textContent.includes('Playback Data'));
                    if (statsItem) statsItem.closest('.actionSheetMenuItem').click();
                }, 120);
            }
        }
        closeMenu();
    }

    function closeMenu() {
        const m = document.getElementById('ppDecodeMenu');
        if (m) m.remove();
    }

    function toggleMenu(targetBtn) {
        const existing = document.getElementById('ppDecodeMenu');
        if (existing) {
            existing.remove();
            return;
        }

        const isHw = cachedSession.playMethod === 'DirectPlay' || cachedSession.playMethod === 'DirectStream';

        const menu = document.createElement('div');
        menu.id = 'ppDecodeMenu';
        menu.className = 'pp-menu';

        menu.innerHTML = `
            <div class="pp-menu-header">DECODE PRESET</div>
            <div class="pp-menu-item ${isHw ? 'active' : ''}" data-action="direct">
                <span>Direct Stream (H/W Copy)</span>
                <span class="pp-menu-tag">FAST BUFFER</span>
            </div>
            <div class="pp-menu-item" data-action="native-mp4">
                <span>Direct Play (Native MP4)</span>
                <span class="pp-menu-tag">RAW</span>
            </div>
            <div class="pp-menu-item ${!isHw ? 'active' : ''}" data-action="transcode-1080p">
                <span>Transcode 1080p (S/W)</span>
                <span class="pp-menu-tag">10M</span>
            </div>
            <div class="pp-menu-item" data-action="transcode-720p">
                <span>Transcode 720p (S/W)</span>
                <span class="pp-menu-tag">4M</span>
            </div>
            <div class="pp-menu-divider"></div>
            <div class="pp-menu-item" data-action="stats">
                <span>Playback Info</span>
                <span class="pp-menu-tag">STATS</span>
            </div>
        `;

        menu.querySelectorAll('.pp-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                switchPreset(item.getAttribute('data-action'));
            });
        });

        const rect = targetBtn.getBoundingClientRect();
        menu.style.left = `${Math.max(10, rect.left - 10)}px`;
        menu.style.bottom = `${window.innerHeight - rect.top + 6}px`;

        document.body.appendChild(menu);

        const onDocClick = (e) => {
            if (!menu.contains(e.target) && e.target !== targetBtn && !targetBtn.contains(e.target)) {
                closeMenu();
                document.removeEventListener('click', onDocClick, true);
            }
        };
        setTimeout(() => {
            document.addEventListener('click', onDocClick, true);
        }, 50);
    }

    // Main HUD update loop
    function updateHud() {
        const osdControls = document.querySelector('.videoOsdBottom-maincontrols .buttons');
        if (!osdControls) {
            closeMenu();
            return;
        }

        let hud = document.getElementById('potplayerHud');
        if (!hud) {
            const timeText = osdControls.querySelector('.osdTimeText');
            if (!timeText) return;

            hud = document.createElement('div');
            hud.id = 'potplayerHud';
            hud.className = 'potplayer-hud';
            hud.innerHTML = `
                <button type="button" class="pp-badge pp-hw" id="ppHwBtn" title="Decode Preset (Click to switch)">H/W</button>
                <span class="pp-badge pp-codec" id="ppVideoCodec">H264</span>
                <button type="button" class="pp-badge pp-audio" id="ppAudioBtn" title="Audio Stream (Click to change track)">
                    <span id="ppAudioCodec">AAC</span>
                    <span id="ppAudioChannels" class="pp-dim">2.0</span>
                </button>
                <span class="pp-badge pp-speed" id="ppSpeedBadge">0 KB/s</span>
                <span class="pp-badge pp-buffer" id="ppBufferBadge">BUFFER 0%</span>
            `;

            timeText.insertAdjacentElement('afterend', hud);

            const hwBtn = hud.querySelector('#ppHwBtn');
            if (hwBtn) {
                hwBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleMenu(hwBtn);
                });
            }

            const audioBtn = hud.querySelector('#ppAudioBtn');
            if (audioBtn) {
                audioBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const nativeAudioBtn = document.querySelector('.btnAudio:not(.hide)');
                    if (nativeAudioBtn) {
                        nativeAudioBtn.click();
                    } else {
                        const sBtn = document.querySelector('.btnVideoOsdSettings');
                        if (sBtn) sBtn.click();
                    }
                });
            }
        }

        // 1. Calculate Realtime Network Speed with smoothing
        const now = Date.now();
        if (now - lastChunkDownloadedTime > 1800) {
            instantSpeedBps = 0;
        }
        smoothedSpeedBps = smoothedSpeedBps * 0.35 + instantSpeedBps * 0.65;
        if (smoothedSpeedBps < 1024) smoothedSpeedBps = 0;

        // 2. Calculate Buffer Percentage
        const video = document.querySelector('video');
        let bufferPercent = 0;
        let isBufferFull = false;

        if (video && video.duration && !isNaN(video.duration) && video.duration > 0) {
            const ct = video.currentTime || 0;
            let totalEnd = 0;

            for (let i = 0; i < video.buffered.length; i++) {
                const s = video.buffered.start(i);
                const end = video.buffered.end(i);
                if (ct >= s - 1 && ct <= end + 1) {
                    totalEnd = Math.max(totalEnd, end);
                } else if (end > totalEnd) {
                    totalEnd = end;
                }
            }

            bufferPercent = Math.min(100, Math.round((totalEnd / video.duration) * 100));
            isBufferFull = bufferPercent >= 99;

            // Keep loading active when paused
            if (video.paused && activeHlsInstance && typeof activeHlsInstance.startLoad === 'function') {
                activeHlsInstance.startLoad();
            }
        }

        // Update Speed Badge
        const speedBadge = hud.querySelector('#ppSpeedBadge');
        if (speedBadge) {
            speedBadge.className = 'pp-badge pp-speed';
            if (isBufferFull && smoothedSpeedBps === 0) {
                speedBadge.textContent = 'IDLE';
                speedBadge.classList.add('pp-speed-fast');
            } else {
                speedBadge.textContent = formatSpeed(smoothedSpeedBps);
                if (smoothedSpeedBps >= 3 * 1048576) {
                    speedBadge.classList.add('pp-speed-fast');
                } else if (smoothedSpeedBps >= 512 * 1024) {
                    speedBadge.classList.add('pp-speed-normal');
                } else if (smoothedSpeedBps > 0) {
                    speedBadge.classList.add('pp-speed-slow');
                }
            }
        }

        // Update Buffer Badge
        const bufferBadge = hud.querySelector('#ppBufferBadge');
        if (bufferBadge) {
            bufferBadge.className = 'pp-badge pp-buffer';
            if (isBufferFull) {
                bufferBadge.textContent = 'BUFFER 100%';
                bufferBadge.classList.add('pp-buffer-full');
            } else {
                bufferBadge.textContent = `BUFFER ${bufferPercent}%`;
            }
        }

        // Update Codecs & Decode Mode
        fetchSession();
        const hwBtn = hud.querySelector('#ppHwBtn');
        const videoCodecEl = hud.querySelector('#ppVideoCodec');
        const audioCodecEl = hud.querySelector('#ppAudioCodec');
        const audioChanEl = hud.querySelector('#ppAudioChannels');

        const isHw = cachedSession.playMethod === 'DirectPlay' || cachedSession.playMethod === 'DirectStream';
        if (hwBtn) {
            hwBtn.className = isHw ? 'pp-badge pp-hw' : 'pp-badge pp-sw';
            hwBtn.textContent = isHw ? 'H/W' : 'S/W';
        }
        if (videoCodecEl) {
            videoCodecEl.textContent = cachedSession.videoCodec || 'H264';
        }
        if (audioCodecEl) {
            audioCodecEl.textContent = cachedSession.audioCodec || 'AAC';
        }
        if (audioChanEl) {
            audioChanEl.textContent = cachedSession.audioChannels || '2.0';
        }
    }

    setInterval(updateHud, 350);

    // =========================================================================
    // 3. Persistent "最近观看" (Recently Watched) Home Section
    // =========================================================================
    function formatTimeAgo(isoString) {
        if (!isoString) return '';
        try {
            const date = new Date(isoString);
            const now = new Date();
            const diffSec = Math.floor((now - date) / 1000);
            if (diffSec < 60) return '刚刚';
            if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
            if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
            if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)} 天前`;
            return `${date.getMonth() + 1}月${date.getDate()}日`;
        } catch (e) {
            return '';
        }
    }

    function updateNativeTitles() {
        document.querySelectorAll('.sectionTitle').forEach(el => {
            const text = el.textContent.trim();
            if (text === '继续观看') {
                el.textContent = '最近观看';
            }
        });
    }

    let isUpdating = false;

    async function checkRecentSection() {
        if (isUpdating) return;
        const hash = window.location.hash || '';
        if (hash && !hash.startsWith('#/home') && hash !== '#/' && hash !== '') {
            return;
        }

        updateNativeTitles();

        // If native continue-watching section has visible cards, ensure its title is "最近观看"
        const nativeSection = document.querySelector('.section1:not(.hide)');
        if (nativeSection && nativeSection.querySelector('.card')) {
            const customSec = document.getElementById('customRecentWatchedSection');
            if (customSec) customSec.remove();
            return;
        }

        if (document.getElementById('customRecentWatchedSection')) {
            return;
        }

        if (!window.ApiClient || !window.ApiClient.getCurrentUserId) {
            return;
        }

        const userId = window.ApiClient.getCurrentUserId();
        if (!userId) return;

        isUpdating = true;
        try {
            const queryParams = {
                SortBy: 'DatePlayed',
                SortOrder: 'Descending',
                Recursive: true,
                IncludeItemTypes: 'Movie,Episode,Video',
                Limit: 12,
                fields: 'ParentId,SeriesName,PrimaryImageAspectRatio'
            };

            const result = await window.ApiClient.getItems(userId, queryParams);
            const items = (result && result.Items) ? result.Items.filter(it => it.UserData && it.UserData.LastPlayedDate) : [];

            if (!items.length) return;

            const parentIds = [...new Set(items.map(it => it.ParentId).filter(Boolean))];
            const parentMap = {};
            if (parentIds.length && window.ApiClient.getItem) {
                await Promise.all(parentIds.map(async pid => {
                    try {
                        const p = await window.ApiClient.getItem(userId, pid);
                        if (p && p.Name) parentMap[pid] = p.Name;
                    } catch (e) {}
                }));
            }

            const homeContainer = document.querySelector('.homeSectionsContainer') || document.querySelector('.sections');
            if (!homeContainer) return;

            const myMediaSection = homeContainer.querySelector('.section0') || homeContainer.firstElementChild;

            const sectionEl = document.createElement('div');
            sectionEl.id = 'customRecentWatchedSection';
            sectionEl.className = 'verticalSection customRecentSection';
            sectionEl.style.margin = '1.2em 0 1.5em 0';

            let cardsHtml = '';
            items.forEach(it => {
                const parentName = parentMap[it.ParentId] || it.SeriesName || '';
                const timeAgo = formatTimeAgo(it.UserData.LastPlayedDate);
                const hasCover = it.ImageTags && it.ImageTags.Primary;
                const imgUrl = hasCover ? window.ApiClient.getImageUrl(it.Id, {
                    type: 'Primary',
                    fillHeight: 320,
                    fillWidth: 500,
                    quality: 90
                }) : '';

                let statusBadge = '';
                let progressPercent = 0;
                if (it.UserData.Played) {
                    statusBadge = '<span style="background: rgba(46, 125, 50, 0.85); color: #fff; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500;">已看完</span>';
                } else if (it.UserData.PlaybackPositionTicks && it.RunTimeTicks) {
                    progressPercent = Math.min(100, Math.round((it.UserData.PlaybackPositionTicks / it.RunTimeTicks) * 100));
                    statusBadge = `<span style="background: rgba(0, 164, 220, 0.85); color: #fff; padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 500;">看到 ${progressPercent}%</span>`;
                }

                cardsHtml += `
                    <div class="card card-hoverable" style="width: 220px; flex: 0 0 auto; margin-right: 1.2em; cursor: pointer; transition: transform 0.2s;" onmouseover="this.style.transform='scale(1.03)'" onmouseout="this.style.transform='scale(1)'" onclick="window.location.hash='#/details?id=${it.Id}'">
                        <div class="cardBox visualCardBox" style="background: #1b1c1e; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.06);">
                            <div class="cardScalable" style="position: relative; width: 100%; aspect-ratio: 16/9; background: #121214;">
                                ${imgUrl ? `<div class="cardImage" style="position: absolute; inset: 0; background: url('${imgUrl}') center/cover no-repeat;"></div>` : '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;"><span class="material-icons" style="font-size:44px;">movie</span></div>'}
                                <div style="position: absolute; top: 6px; right: 6px;">${statusBadge}</div>
                                ${progressPercent > 0 ? `
                                    <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 4px; background: rgba(255,255,255,0.15);">
                                        <div style="height: 100%; width: ${progressPercent}%; background: #00a4dc;"></div>
                                    </div>
                                ` : ''}
                            </div>
                            <div class="cardFooter" style="padding: 10px 12px 12px 12px;">
                                <div class="cardText" style="font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff;">
                                    ${it.Name}
                                </div>
                                <div class="cardText" style="font-size: 12px; color: rgba(255,255,255,0.55); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 4px;">
                                    ${parentName ? `${parentName} · ` : ''}${timeAgo}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });

            sectionEl.innerHTML = `
                <div style="display: flex; align-items: baseline; justify-content: space-between; padding: 0 1.5em; margin-bottom: 0.6em;">
                    <h2 class="sectionTitle sectionTitle-cards" style="margin: 0; font-size: 1.45em; font-weight: 600; color: #fff;">
                        最近观看
                    </h2>
                    <span style="font-size: 12px; color: rgba(255,255,255,0.45);">播放历史与断点续播</span>
                </div>
                <div style="display: flex; overflow-x: auto; padding: 0.4em 1.5em; scrollbar-width: thin; -webkit-overflow-scrolling: touch;">
                    ${cardsHtml}
                </div>
            `;

            if (myMediaSection && myMediaSection.nextSibling) {
                homeContainer.insertBefore(sectionEl, myMediaSection.nextSibling);
            } else {
                homeContainer.appendChild(sectionEl);
            }

        } catch (e) {
            console.error('Error in recent watched script:', e);
        } finally {
            isUpdating = false;
        }
    }

    const observer = new MutationObserver(() => {
        checkRecentSection();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkRecentSection);
    } else {
        setTimeout(checkRecentSection, 400);
    }
    window.addEventListener('hashchange', () => {
        setTimeout(checkRecentSection, 300);
    });

})();
